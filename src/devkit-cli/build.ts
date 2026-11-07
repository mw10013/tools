/**
 * Builds `src/devkit` into the package `@mw10013/devkit`: `<out>/package.json` and `<out>/dist/`,
 * JavaScript and `.d.mts` files. `src/devkit/package.json` is the one list of the public surface.
 * The build's entries are its `exports` and `bin` targets, and the built manifest maps each of
 * them into `dist/`, so no second list exists to drift. A module no entry names still builds, as
 * a chunk the entries import, but has no `.d.mts` and no `exports` key, so an app cannot import
 * it.
 *
 * @module
 */
import * as path from "node:path";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { run } from "#wt/process.ts";

const TOOLS = path.resolve(import.meta.dirname, "../..");
export const SOURCE = path.join(TOOLS, "src/devkit");
export const OUTPUT = path.join(TOOLS, "dist/devkit");

const Targets = Schema.Record(Schema.String, Schema.String);
const Source = Schema.Struct({ exports: Targets, bin: Targets });
const decodeSource = Schema.decodeUnknownSync(Source);

const JsonObject = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Unknown),
);
const decodeJsonObject = Schema.decodeUnknownEffect(JsonObject);

const built = (target: string, extension: ".d.mts" | ".mjs") =>
  `./dist/${target.replace(/^\.\//u, "").replace(/\.ts$/u, extension)}`;

/**
 * The source manifest's source files, as {@link build} compiles them: every `exports` and `bin`
 * target, relative to `src/devkit`.
 */
export const entriesOf = (source: unknown): readonly string[] => {
  const { exports, bin } = decodeSource(source);
  return [...Object.values(exports), ...Object.values(bin)];
};

/**
 * The published manifest: the source's, with each export mapped to its types and its code in
 * `dist/` and each bin to its code. `imports` serves the source tree alone, `private` keeps the
 * source from being published to a registry by accident, and `//` is a note for the source's
 * readers.
 * A release stamps its `version`, which `pnpm list` reports as the locked version.
 */
export const builtManifest = (
  source: Record<string, unknown>,
  version?: string,
) => {
  const { exports, bin } = decodeSource(source);
  const { "//": _note, imports: _imports, private: _private, ...rest } = source;
  return {
    ...rest,
    ...(version === undefined ? {} : { version }),
    exports: Object.fromEntries(
      Object.entries(exports).map(([key, target]) => [
        key,
        { types: built(target, ".d.mts"), default: built(target, ".mjs") },
      ]),
    ),
    bin: Object.fromEntries(
      Object.entries(bin).map(([key, target]) => [key, built(target, ".mjs")]),
    ),
  };
};

/**
 * Builds the package into `outDirectory`, replacing what was there, and stamps `version` into its
 * manifest when given. `vp pack` runs in
 * `src/devkit`, so Rolldown reads `src/devkit/package.json`'s peer dependencies and leaves them
 * external, and `tsconfig.build.json` limits type-checking to devkit instead of all of tools.
 */
export const build = Effect.fn("DevkitBuild.build")(function* (
  outDirectory: string = OUTPUT,
  version?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* decodeJsonObject(
    yield* fs.readFileString(path.join(SOURCE, "package.json")),
  );
  const entries = entriesOf(source);
  yield* fs.remove(outDirectory, { recursive: true, force: true });
  yield* run(SOURCE, path.join(TOOLS, "node_modules/.bin/vp"), [
    "pack",
    ...entries,
    "--unbundle",
    "--dts",
    "--root",
    ".",
    "--tsconfig",
    "tsconfig.build.json",
    "--no-config",
    "-d",
    path.join(outDirectory, "dist"),
  ]);
  const manifest = builtManifest(source, version);
  yield* fs.writeFileString(
    path.join(outDirectory, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  for (const target of Object.values(manifest.bin))
    yield* fs.chmod(path.join(outDirectory, target), 0o755);
  return { directory: outDirectory, entries: entries.length };
});
