import * as Context from "effect/Context";
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

import { type CheckoutPath, type StoreDomain } from "./domain.ts";
import { type OrganizationId, type OrgStore } from "./pool.ts";

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

/** A Shopify CLI command that exited non-zero: signed out, refused, or timed out. */
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
    return `shopify store list returned only some of organization ${this.organization}'s dev stores, so berth cannot tell which exist`;
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

/** `--json` prints an AbortError's message on stdout too. */
const CreateFailure = CliResult(Schema.Struct({ message: Schema.String }));

export class ShopifyCli extends Context.Service<
  ShopifyCli,
  {
    readonly listDevStores: (
      organization: OrganizationId,
    ) => Effect.Effect<
      ReadonlyArray<OrgStore>,
      ShopifyCliError | StoreListTruncatedError
    >;
    /** Resolves to the domain Shopify gave the store, which a taken name suffixes. */
    readonly createDevStore: (
      organization: OrganizationId,
      name: string,
    ) => Effect.Effect<string, ShopifyCliError>;
  }
>()("app/ShopifyCli") {
  static readonly layer = Layer.effect(
    ShopifyCli,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // Progress goes to stderr; create's streams to the terminal because it
      // can take minutes.
      const shopify = (
        args: ReadonlyArray<string>,
        stderr: "pipe" | "inherit",
      ) =>
        Effect.scoped(
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
            return { stdout, stderr: errors, exitCode: Number(exitCode) };
          }),
        ).pipe(Effect.orDie);

      return {
        listDevStores: Effect.fn("ShopifyCli.listDevStores")(function* (
          organization: OrganizationId,
        ) {
          const args = [
            "store",
            "list",
            "--type",
            "dev",
            "--organization-id",
            organization,
          ];
          const output = yield* shopify(args, "pipe");
          if (output.exitCode !== 0)
            return yield* new ShopifyCliError({
              command: `shopify ${args.join(" ")}`,
              detail: output.stderr.trim(),
            });
          const list = yield* Schema.decodeUnknownEffect(StoreList)(
            output.stdout,
          ).pipe(Effect.orDie);
          if (list.truncated === true)
            return yield* new StoreListTruncatedError({ organization });
          return list.stores.map((store): OrgStore => ({
            domain: store.store,
            name: store.name,
            type: store.type,
            plan: store.plan ?? undefined,
          }));
        }),
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
          if (output.exitCode !== 0)
            return yield* new ShopifyCliError({
              command: `shopify ${args.join(" ")}`,
              detail: Option.match(
                Schema.decodeUnknownOption(CreateFailure)(output.stdout),
                {
                  onNone: () => `exit ${String(output.exitCode)}`,
                  onSome: (failure) => failure.message,
                },
              ),
            });
          const created = yield* Schema.decodeUnknownEffect(CreatedStore)(
            output.stdout,
          ).pipe(Effect.orDie);
          return created.store.domain;
        }),
      };
    }),
  );
}
