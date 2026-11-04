import * as os from "node:os";

import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import {
  CheckoutPath,
  Config as BerthConfig,
  MachineName,
  Manifest,
  type Policy,
  StoreDomain,
} from "./domain.ts";

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

const StoresFile = Schema.Array(
  Schema.String.pipe(
    Schema.decodeTo(
      StoreDomain,
      SchemaTransformation.transform({
        decode: (handle) => `${handle}.myshopify.com`,
        encode: (domain) => domain.slice(0, -".myshopify.com".length),
      }),
    ),
  ),
);

const loadStores = Effect.fn("Settings.loadStores")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.resolve(
    path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))),
    "../../stores.json",
  );
  return yield* decodeFile(
    StoresFile,
    file,
    yield* fs.readFileString(file).pipe(Effect.orDie),
  );
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
    stores: yield* loadStores(),
  } satisfies Policy;
});
