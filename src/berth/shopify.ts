import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Stream from "effect/Stream";

import type { CheckoutPath, StoreDomain } from "./domain.ts";
import type { OrganizationId, OrgStore } from "./pool.ts";

// EPERM: the process exists but belongs to another user.
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const DevSession = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.Int,
    details: Schema.Struct({ storeFqdn: Schema.String }),
  }),
);

export const liveSession = Effect.fn("Shopify.liveSession")(function* (
  checkout: CheckoutPath,
  store: StoreDomain,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(checkout, ".shopify", "dev");
  if (!(yield* fs.exists(directory))) return Option.none<number>();
  for (const name of yield* fs.readDirectory(directory)) {
    if (!/^app-dev-.*\.json$/u.test(name)) continue;
    const text = yield* fs
      .readFileString(path.join(directory, name))
      .pipe(Effect.option);
    const session = Option.flatMap(text, (text) =>
      Schema.decodeUnknownOption(DevSession)(text),
    );
    if (
      Option.isSome(session) &&
      session.value.details.storeFqdn === store &&
      isAlive(session.value.pid)
    )
      return Option.some(session.value.pid);
  }
  return Option.none<number>();
}, Effect.orDie);

/**
 * A Shopify CLI command that did not succeed as berth can tell: it could not
 * start, it exited non-zero (signed out, refused, or timed out), or it printed
 * output berth cannot read.
 */
export class ShopifyCliError extends Schema.TaggedError<ShopifyCliError>()(
  "ShopifyCliError",
  { command: Schema.String, detail: Schema.String },
) {
  override get message() {
    return `${this.command} failed: ${this.detail}`;
  }
}

/** Shopify lists at most 250 stores, the newest first, so an older one may be missing from the list. */
export class StoreListTruncatedError extends Schema.TaggedError<StoreListTruncatedError>()(
  "StoreListTruncatedError",
  { organization: Schema.String },
) {
  override get message() {
    return `shopify store list returned only some of organization ${this.organization}'s stores, so berth cannot tell which exist`;
  }
}

/**
 * The CLI can print progress events, one JSON object per line, before the
 * result, which it prints as one object over several lines. The result is the
 * last object, not the last line.
 */
export const resultText = (stdout: string): string => {
  const lines = stdout.split("\n").filter((line) => line !== "");
  const last = lines.at(-1) ?? "";
  if (last !== "}") return last;
  return lines.slice(Math.max(lines.lastIndexOf("{"), 0)).join("\n");
};

const CliResult = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform({
        decode: resultText,
        encode: (text) => text,
      }),
    ),
    Schema.decodeTo(Schema.fromJsonString(schema)),
  );

const StoreList = CliResult(
  Schema.Struct({
    stores: Schema.Array(
      Schema.Struct({
        store: Schema.String,
        name: Schema.optionalKey(Schema.String),
        type: Schema.String,
        plan: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
    truncated: Schema.optionalKey(Schema.Boolean),
  }),
);

const CreatedStore = CliResult(
  Schema.Struct({ store: Schema.Struct({ domain: Schema.String }) }),
);

/**
 * How long a failed create waits for the store to show in the org's list. CLI
 * 5.0.0's status poll fails on its first answer, "Unable to determine store
 * creation status", while Shopify goes on to make the store, and the list shows
 * a new store some seconds after the create. The CLI itself polls every 2 seconds.
 */
const APPEAR_POLL = Duration.seconds(2);
const APPEAR_WITHIN = Duration.minutes(2);

/** `--json` prints an AbortError's message on stdout too. */
const CreateFailure = CliResult(Schema.Struct({ message: Schema.String }));

export class ShopifyCli extends Context.Service<
  ShopifyCli,
  {
    /**
     * Every store in the organization. `--type dev` would hide a listed store
     * that is another type, and a pool name a non-dev store holds.
     */
    readonly listStores: (
      organization: OrganizationId,
    ) => Effect.Effect<
      readonly OrgStore[],
      ShopifyCliError | StoreListTruncatedError
    >;
    /**
     * Resolves to the domain Shopify gave the store, which a taken name
     * suffixes. A failed create first waits for the store in the org's list.
     */
    readonly createDevStore: (
      organization: OrganizationId,
      name: string,
    ) => Effect.Effect<string, ShopifyCliError | StoreListTruncatedError>;
  }
>()("app/ShopifyCli") {
  static readonly layer = Layer.effect(
    ShopifyCli,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // Progress goes to stderr; create's streams to the terminal because it
      // can take minutes.
      const shopify = (args: readonly string[], stderr: "pipe" | "inherit") => {
        const command = `shopify ${args.join(" ")}`;
        return Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make("shopify", [...args, "--json", "--no-input"], {
                stdin: "ignore",
                stderr,
              }),
            );
            const [stdout, errors, exitCode] = yield* Effect.all(
              [
                Stream.mkString(Stream.decodeText(child.stdout)),
                stderr === "pipe"
                  ? Stream.mkString(Stream.decodeText(child.stderr))
                  : Effect.succeed(""),
                child.exitCode,
              ],
              { concurrency: "unbounded" },
            );
            return {
              command,
              stdout,
              stderr: errors,
              exitCode: Number(exitCode),
            };
          }),
        ).pipe(
          Effect.mapError(
            (error) =>
              new ShopifyCliError({
                command,
                detail:
                  error.reason._tag === "NotFound"
                    ? "shopify is not on PATH"
                    : error.message,
              }),
          ),
        );
      };

      const listStores = Effect.fn("ShopifyCli.listStores")(function* (
        organization: OrganizationId,
      ) {
        const args = ["store", "list", "--organization-id", organization];
        const output = yield* shopify(args, "pipe");
        if (output.exitCode !== 0)
          return yield* new ShopifyCliError({
            command: output.command,
            detail: output.stderr.trim(),
          });
        const list = yield* Schema.decodeUnknownEffect(StoreList)(
          output.stdout,
        ).pipe(
          Effect.mapError(
            (issue) =>
              new ShopifyCliError({
                command: output.command,
                detail: `berth cannot read its output: ${issue.message}`,
              }),
          ),
        );
        if (list.truncated === true)
          return yield* new StoreListTruncatedError({ organization });
        return list.stores.map((store): OrgStore => ({
          domain: store.store,
          name: store.name,
          type: store.type,
          plan: store.plan ?? undefined,
        }));
      });

      // planPool picks a name no org store holds, so a store by that name is this create's.
      const appearedAs = Effect.fn("ShopifyCli.appearedAs")(function* (
        organization: OrganizationId,
        name: string,
      ) {
        const deadline =
          (yield* Clock.currentTimeMillis) + Duration.toMillis(APPEAR_WITHIN);
        for (;;) {
          const stores = yield* listStores(organization);
          const store = stores.find((store) => store.name === name);
          if (store !== undefined) return Option.some(store.domain);
          if ((yield* Clock.currentTimeMillis) >= deadline)
            return Option.none<string>();
          yield* Effect.sleep(APPEAR_POLL);
        }
      });

      return {
        listStores,
        createDevStore: Effect.fn("ShopifyCli.createDevStore")(function* (
          organization: OrganizationId,
          name: string,
        ) {
          const args = [
            "store",
            "create",
            "dev",
            "--name",
            name,
            "--plan",
            "basic",
            "--organization-id",
            organization,
          ];
          const output = yield* shopify(args, "inherit");
          if (output.exitCode !== 0) {
            // A failed create can still make the store, so a rerun that does
            // not see it yet would make another at a suffixed domain.
            const appeared = yield* appearedAs(organization, name);
            if (Option.isSome(appeared)) return appeared.value;
            return yield* new ShopifyCliError({
              command: output.command,
              detail: Option.match(
                Schema.decodeUnknownOption(CreateFailure)(output.stdout),
                {
                  onNone: () => `exit ${String(output.exitCode)}`,
                  onSome: (failure) => failure.message,
                },
              ),
            });
          }
          const created = yield* Schema.decodeUnknownEffect(CreatedStore)(
            output.stdout,
          ).pipe(
            Effect.mapError(
              (issue) =>
                new ShopifyCliError({
                  command: output.command,
                  detail: `berth cannot read its output, so the store may exist; if it is at ${name}.myshopify.com, the next berth pool ensure adopts it (${issue.message})`,
                }),
            ),
          );
          return created.store.domain;
        }),
      };
    }),
  );
}
