/**
 * What berth reads from disk besides its ledger: the checkout's `berth.json`,
 * the machine's `config.json`, and where the ledger lives. Raw JSON is decoded
 * into domain types here and goes no further.
 *
 * @module
 */
import * as os from "node:os";

import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  CheckoutPath,
  Config as BerthConfig,
  DEFAULT_PORTS,
  MachineName,
  Manifest,
  type Policy,
  Port,
} from "./domain.ts";

/** No `berth.json` in the directory or any parent. */
export class ManifestNotFoundError extends Schema.TaggedError<ManifestNotFoundError>()(
  "ManifestNotFoundError",
  { from: Schema.String },
) {
  override get message() {
    return `no berth.json in ${this.from} or any parent directory`;
  }
}

/** A `berth.json` or `config.json` that does not decode. */
export class SettingsInvalidError extends Schema.TaggedError<SettingsInvalidError>()(
  "SettingsInvalidError",
  { file: Schema.String, issue: Schema.String },
) {
  override get message() {
    return `${this.file} is invalid: ${this.issue}`;
  }
}

/** A checkout and what its manifest declares. */
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

/** The nearest directory at or above `from`'s real path holding a `berth.json`. */
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

const xdgDirectory = (variable: string, fallback: string) =>
  Effect.gen(function* () {
    return yield* Config.String(variable).pipe(Config.withDefault(fallback));
  }).pipe(Effect.orDie);

/** `$XDG_STATE_HOME/berth/ledger`, default `~/.local/state/berth/ledger`. */
export const ledgerDirectory = Effect.gen(function* () {
  const path = yield* Path.Path;
  const state = yield* xdgDirectory(
    "XDG_STATE_HOME",
    path.join(os.homedir(), ".local", "state"),
  );
  return path.join(state, "berth", "ledger");
});

/**
 * The machine's policy: `$XDG_CONFIG_HOME/berth/config.json` (default
 * `~/.config/berth/`) over the defaults. The machine name is the config's or
 * the host name without `.local`. A missing file is the defaults; an invalid
 * one fails rather than guessing.
 */
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
  const first = config.ports?.first ?? Port.make(DEFAULT_PORTS.first);
  const last = config.ports?.last ?? Port.make(DEFAULT_PORTS.last);
  if (first > last)
    return yield* new SettingsInvalidError({
      file,
      issue: `ports.first ${String(first)} is above ports.last ${String(last)}`,
    });
  return {
    machine:
      config.machine ??
      MachineName.make(os.hostname().replace(/\.local$/u, "")),
    ports: {
      first,
      last,
      reserved: new Set(
        config.ports?.reserved ??
          DEFAULT_PORTS.reserved.map((port) => Port.make(port)),
      ),
    },
  } satisfies Policy;
});
