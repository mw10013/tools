import * as os from "node:os";

import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  Config as BerthConfig,
  CheckoutPath,
  MachineName,
  Manifest,
  type Policy,
} from "./domain.ts";
import { Pool } from "./pool.ts";

export class ManifestNotFoundError extends Schema.TaggedError<ManifestNotFoundError>()(
  "ManifestNotFoundError",
  { from: Schema.String },
) {
  override get message() {
    return `no berth.json in ${this.from} or any parent directory`;
  }
}

export class SettingsInvalidError extends Schema.TaggedError<SettingsInvalidError>()(
  "SettingsInvalidError",
  { file: Schema.String, issue: Schema.String },
) {
  override get message() {
    return `${this.file} is invalid: ${this.issue}`;
  }
}

export interface Checkout {
  readonly path: CheckoutPath;
  readonly manifest: Manifest;
}

const decodeFile = <
  S extends Schema.Top & { readonly DecodingServices: never },
>(
  schema: S,
  file: string,
  text: string,
) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError(
      (issue) => new SettingsInvalidError({ file, issue: issue.message }),
    ),
  );

export const findCheckout = Effect.fn("Settings.findCheckout")(function* (
  from: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const start = yield* fs.realPath(from).pipe(Effect.orDie);
  let directory = start;
  for (;;) {
    const file = path.join(directory, "berth.json");
    if (yield* fs.exists(file).pipe(Effect.orDie)) {
      const text = yield* fs.readFileString(file).pipe(Effect.orDie);
      return {
        path: CheckoutPath.make(directory),
        manifest: yield* decodeFile(Manifest, file, text),
      } satisfies Checkout;
    }
    const parent = path.dirname(directory);
    if (parent === directory)
      return yield* new ManifestNotFoundError({ from: start });
    directory = parent;
  }
});

/** `stores.json` sits at the root of this repository, beside berth's source. */
export const poolFile = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.resolve(
    path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))),
    "../../stores.json",
  );
});

const poolText = (pool: Pool) =>
  `${JSON.stringify(Schema.encodeSync(Pool)(pool), null, 2)}\n`;

export const loadPool = Effect.fn("Settings.loadPool")(function* (
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* decodeFile(
    Pool,
    file,
    yield* fs.readFileString(file).pipe(Effect.orDie),
  );
});

/** Another writer changed `stores.json` to a different pool while this run held it. */
export class PoolFileChangedError extends Schema.TaggedError<PoolFileChangedError>()(
  "PoolFileChangedError",
  {
    file: Schema.String,
    organization: Schema.String,
    prefix: Schema.String,
    foundOrganization: Schema.String,
    foundPrefix: Schema.String,
  },
) {
  override get message() {
    return `${this.file} now names organization ${this.foundOrganization} and prefix ${this.foundPrefix}, not the ${this.organization} and ${this.prefix} this run loaded; run berth pool ensure again`;
  }
}

/**
 * Writes the stores on disk, then those of `pool` the disk lacks, so a
 * concurrent run's stores survive. Writes through a temp file and a rename, so
 * a reader never sees a partial file. Returns the pool written and whether the
 * file changed: one that already holds it is not written.
 */
export const savePool = Effect.fn("Settings.savePool")(function* (
  file: string,
  pool: Pool,
) {
  const fs = yield* FileSystem.FileSystem;
  const disk = yield* loadPool(file);
  if (disk.organization !== pool.organization || disk.prefix !== pool.prefix)
    return yield* new PoolFileChangedError({
      file,
      organization: pool.organization,
      prefix: pool.prefix,
      foundOrganization: disk.organization,
      foundPrefix: disk.prefix,
    });
  const merged: Pool = {
    ...disk,
    stores: [
      ...disk.stores,
      ...pool.stores.filter((store) => !disk.stores.includes(store)),
    ],
  };
  const text = poolText(merged);
  if ((yield* fs.readFileString(file).pipe(Effect.orDie)) === text)
    return { pool: merged, changed: false };
  const temp = `${file}.${String(process.pid)}.tmp`;
  yield* fs.writeFileString(temp, text).pipe(Effect.orDie);
  yield* fs.rename(temp, file).pipe(Effect.orDie);
  return { pool: merged, changed: true };
});

const xdgDirectory = (variable: string, fallback: string) =>
  Effect.gen(function* () {
    return yield* Config.String(variable).pipe(Config.withDefault(fallback));
  }).pipe(Effect.orDie);

export const ledgerDirectory = Effect.gen(function* () {
  const path = yield* Path.Path;
  const state = yield* xdgDirectory(
    "XDG_STATE_HOME",
    path.join(os.homedir(), ".local", "state"),
  );
  return path.join(state, "berth", "ledger");
});

export const loadPolicy = Effect.fn("Settings.loadPolicy")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* xdgDirectory(
    "XDG_CONFIG_HOME",
    path.join(os.homedir(), ".config"),
  );
  const file = path.join(home, "berth", "config.json");
  const config = (yield* fs.exists(file).pipe(Effect.orDie))
    ? yield* decodeFile(
        BerthConfig,
        file,
        yield* fs.readFileString(file).pipe(Effect.orDie),
      )
    : {};
  return {
    machine:
      config.machine ??
      MachineName.make(os.hostname().replace(/\.local$/u, "")),
    stores: (yield* loadPool(yield* poolFile)).stores,
  } satisfies Policy;
});
