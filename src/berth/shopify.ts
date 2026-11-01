/**
 * Everything berth asks of the Shopify CLI and its files: the org's dev
 * stores, the dev-preview clean, and whether a checkout's `shopify app dev`
 * is running on a store. No CLI JSON shape leaves this module.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { type CheckoutPath, StoreDomain } from "./domain.ts";

/** `shopify store list` failed: logged out, offline, or the wrong org. */
export class StoreListError extends Schema.TaggedError<StoreListError>()(
  "StoreListError",
  { organizationId: Schema.String, detail: Schema.String },
) {
  override get message() {
    return `shopify store list --organization-id ${this.organizationId} failed: ${this.detail}`;
  }
}

/** `shopify app dev clean` failed; the lease stays, so a rerun retries it. */
export class StoreCleanError extends Schema.TaggedError<StoreCleanError>()(
  "StoreCleanError",
  { store: Schema.String, config: Schema.String, detail: Schema.String },
) {
  override get message() {
    return `shopify app dev clean --config ${this.config} --store ${this.store} failed, so the lease stays: ${this.detail}`;
  }
}

/** The part of `shopify store list --json` berth reads. */
const StoreList = Schema.fromJsonString(
  Schema.Struct({
    stores: Schema.Array(Schema.Struct({ store: Schema.String })),
  }),
);

/** The part of `.shopify/dev/app-dev-*.json` berth reads. */
const DevSession = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.Int,
    details: Schema.Struct({ storeFqdn: Schema.String }),
  }),
);

/** What `--json` prints on stdout when a command fails. */
const Failure = Schema.fromJsonString(
  Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }),
);

/**
 * Runs `shopify` in `directory`: the exit code, stdout, and why it failed,
 * from the `--json` error on stdout or else stderr's last line.
 */
const shopify = Effect.fn("Shopify.run")(
  function* (directory: string, args: ReadonlyArray<string>) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const process = yield* spawner.spawn(
      ChildProcess.make("shopify", [...args, "--json", "--no-input"], {
        cwd: directory,
        stdin: "ignore",
        extendEnv: true,
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(process.stdout)),
        Stream.mkString(Stream.decodeText(process.stderr)),
        process.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    const reason = Option.match(Schema.decodeUnknownOption(Failure)(stdout), {
      onSome: (failure) => failure.error.message,
      onNone: () => stderr.trim().split("\n").at(-1) ?? "",
    });
    return { exitCode, stdout, detail: `exit ${String(exitCode)}: ${reason}` };
  },
  Effect.scoped,
  Effect.orDie,
);

/**
 * The org's dev stores, as domains. The staging and production stores are
 * listed too; the pool patterns keep them out.
 */
export const listStores = Effect.fn("Shopify.listStores")(function* (
  organizationId: string,
) {
  const result = yield* shopify(".", [
    "store",
    "list",
    "--type",
    "dev",
    "--organization-id",
    organizationId,
  ]);
  if (result.exitCode !== 0)
    return yield* new StoreListError({ organizationId, detail: result.detail });
  const list = yield* Schema.decodeUnknownEffect(StoreList)(result.stdout).pipe(
    Effect.orDie,
  );
  return list.stores.flatMap((store) =>
    Option.toArray(Schema.decodeUnknownOption(StoreDomain)(store.store)),
  );
});

/**
 * `shopify app dev clean --config <config> --store <domain>`, run in the
 * checkout so the app config resolves. Cleaning a store with no preview
 * succeeds.
 */
export const clean = Effect.fn("Shopify.clean")(function* (
  checkout: CheckoutPath,
  config: string,
  store: StoreDomain,
) {
  const result = yield* shopify(checkout, [
    "app",
    "dev",
    "clean",
    "--config",
    config,
    "--store",
    store,
  ]);
  if (result.exitCode !== 0)
    return yield* new StoreCleanError({ store, config, detail: result.detail });
});

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * The pid of a live `shopify app dev` in `checkout` on `store`, from the CLI's
 * session files. A file that does not decode is not a session berth knows.
 */
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
