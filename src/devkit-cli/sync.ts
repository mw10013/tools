/**
 * `devkit sync` copies devkit's source, `src/devkit/<layer>/` at tools' HEAD,
 * into an app's `vendor/devkit/`, which the app commits and imports through
 * `"#devkit/*": "./vendor/devkit/*"`. The copy is read-only: `devkit.json`
 * records each file's SHA-256, and a sync refuses while any vendored file
 * differs from it, so a fix is made in tools and synced, never made in place.
 *
 * Layers nest: `shopify` includes `cloudflare`, which includes `core`. Tests
 * (`*.test.ts`) stay in tools.
 *
 * @module
 */
import { createHash } from "node:crypto";

import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { run } from "#wt/process.ts";

export const LAYERS = ["core", "cloudflare", "shopify"] as const;
export const Layer = Schema.Literals(LAYERS);
export type Layer = typeof Layer.Type;

/** `vendor/devkit/devkit.json`: what the last sync wrote. */
export const Stamp = Schema.Struct({
  devkit: Schema.Literal(1),
  tools: Schema.String,
  layer: Layer,
  files: Schema.Record(Schema.String, Schema.String),
});
export type Stamp = typeof Stamp.Type;
const StampJson = Schema.fromJsonString(Stamp);

export const VENDOR = "vendor/devkit";
const STAMP = `${VENDOR}/devkit.json`;
const SOURCE = "src/devkit";

export class NoLayerError extends Schema.TaggedError<NoLayerError>()(
  "NoLayerError",
  {},
) {
  override get message() {
    return `no layer: run devkit sync ${LAYERS.join("|")} once; later syncs reuse it`;
  }
}

/** A vendored file no longer matches `devkit.json`. */
export class EditedVendorError extends Schema.TaggedError<EditedVendorError>()(
  "EditedVendorError",
  { files: Schema.Array(Schema.String) },
) {
  override get message() {
    return `edited in place: ${this.files.join(", ")}. Make the change in ~/projects/tools/src/devkit, commit it, then sync; or git checkout ${VENDOR} to drop the edit`;
  }
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** The layers `layer` includes, innermost first. */
const layersOf = (layer: Layer) => LAYERS.slice(0, LAYERS.indexOf(layer) + 1);

/** devkit's files for `layer` at tools' HEAD, keyed by their path under `vendor/devkit/`. */
export const source = Effect.fn("Devkit.source")(function* (
  tools: string,
  layer: Layer,
) {
  const head = (yield* run(tools, "git", ["rev-parse", "HEAD"])).trim();
  const listed = (yield* run(tools, "git", [
    "ls-tree",
    "-r",
    "--name-only",
    "HEAD",
    "--",
    ...layersOf(layer).map((name) => `${SOURCE}/${name}/`),
  ]))
    .split("\n")
    .filter((file) => file.length > 0 && !file.endsWith(".test.ts"));
  const files = new Map<string, string>();
  for (const file of listed)
    files.set(
      file.slice(SOURCE.length + 1),
      yield* run(tools, "git", ["show", `HEAD:${file}`]),
    );
  const dirty = yield* run(tools, "git", [
    "status",
    "--porcelain",
    "--",
    SOURCE,
  ]);
  if (dirty.trim() !== "")
    yield* Console.error(
      `devkit: ${SOURCE} has uncommitted changes in tools; syncing HEAD (${head.slice(0, 7)}) without them`,
    );
  return { head, files };
});

const readStamp = Effect.fn("Devkit.readStamp")(function* (app: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(app, STAMP);
  if (!(yield* fs.exists(file))) return Option.none<Stamp>();
  return Option.some(
    yield* Schema.decodeEffect(StampJson)(yield* fs.readFileString(file)),
  );
});

/** Vendored files that differ from the stamp, or are gone. */
const editedFiles = Effect.fn("Devkit.editedFiles")(function* (
  app: string,
  stamp: Stamp,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const edited: Array<string> = [];
  for (const [file, hash] of Object.entries(stamp.files)) {
    const at = path.join(app, VENDOR, file);
    if (
      !(yield* fs.exists(at)) ||
      sha256(yield* fs.readFileString(at)) !== hash
    )
      edited.push(file);
  }
  return edited;
});

export interface Synced {
  readonly tools: string;
  readonly layer: Layer;
  readonly added: ReadonlyArray<string>;
  readonly changed: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
}

/** Makes `vendor/devkit/` in the app at `app` match tools' HEAD for `layer`, or the last sync's. */
export const sync = Effect.fn("Devkit.sync")(function* (
  tools: string,
  app: string,
  requested: Option.Option<Layer>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stamp = yield* readStamp(app);
  const layer = yield* Option.orElse(requested, () =>
    Option.map(stamp, (s) => s.layer),
  ).pipe(
    Effect.fromOption,
    Effect.mapError(() => new NoLayerError()),
  );
  if (Option.isSome(stamp)) {
    const edited = yield* editedFiles(app, stamp.value);
    if (edited.length > 0)
      return yield* new EditedVendorError({ files: edited });
  }
  const { head, files } = yield* source(tools, layer);
  const before = Option.match(stamp, {
    onNone: () => ({}) as Record<string, string>,
    onSome: (s) => s.files,
  });
  const removed = Object.keys(before).filter((file) => !files.has(file));
  for (const file of removed)
    yield* fs.remove(path.join(app, VENDOR, file), { force: true });
  const added: Array<string> = [];
  const changed: Array<string> = [];
  const hashes: Record<string, string> = {};
  for (const [file, text] of files) {
    const hash = sha256(text);
    hashes[file] = hash;
    if (before[file] === hash) continue;
    (file in before ? changed : added).push(file);
    const at = path.join(app, VENDOR, file);
    yield* fs.makeDirectory(path.dirname(at), { recursive: true });
    yield* fs.writeFileString(at, text);
  }
  yield* fs.writeFileString(
    path.join(app, STAMP),
    `${JSON.stringify(
      { devkit: 1, tools: head, layer, files: hashes } satisfies Stamp,
      null,
      2,
    )}\n`,
  );
  return { tools: head, layer, added, changed, removed } satisfies Synced;
});

export interface Status {
  readonly tools: Option.Option<string>;
  readonly head: string;
  readonly layer: Option.Option<Layer>;
  readonly behind: boolean;
  readonly edited: ReadonlyArray<string>;
}

/** Whether the app's vendored devkit is edited, and whether a sync would change it. */
export const status = Effect.fn("Devkit.status")(function* (
  tools: string,
  app: string,
) {
  const stamp = yield* readStamp(app);
  if (Option.isNone(stamp)) {
    const head = (yield* run(tools, "git", ["rev-parse", "HEAD"])).trim();
    return {
      tools: Option.none(),
      head,
      layer: Option.none(),
      behind: true,
      edited: [],
    } satisfies Status;
  }
  const { head, files } = yield* source(tools, stamp.value.layer);
  const vendored = stamp.value.files;
  const behind =
    files.size !== Object.keys(vendored).length ||
    [...files].some(([file, text]) => vendored[file] !== sha256(text));
  return {
    tools: Option.some(stamp.value.tools),
    head,
    layer: Option.some(stamp.value.layer),
    behind,
    edited: yield* editedFiles(app, stamp.value),
  } satisfies Status;
});
