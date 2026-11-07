/**
 * Where a directory declares `@mw10013/devkit`, and what pnpm resolved. An app declares it in its
 * `package.json`, or as `catalog:` there with the spec in the workspace's `pnpm-workspace.yaml`.
 * A directory with only a `vendor/devkit/devkit.json` stamp still vendors an old copy.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as Yaml from "effect/encoding/Yaml";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { capture } from "#wt/process.ts";

import { PACKAGE } from "./spec.ts";

export class UnreadableFileError extends Schema.TaggedError<UnreadableFileError>()(
  "UnreadableFileError",
  { file: Schema.String },
) {
  override get message() {
    return `${this.file} is not valid`;
  }
}

export class SpecEditError extends Schema.TaggedError<SpecEditError>()(
  "SpecEditError",
  { file: Schema.String, matches: Schema.Number },
) {
  override get message() {
    return `${this.file} names ${PACKAGE} on ${String(this.matches)} lines, so the spec to edit is ambiguous; edit it by hand`;
  }
}

/** Where the spec is written: the `package.json` that depends on devkit, or the workspace catalog it names. */
export interface Declaration {
  readonly file: string;
  /** `dependencies`, `devDependencies`, `catalog` or `catalogs.<name>`. */
  readonly field: string;
  readonly spec: string;
}

const Dependencies = Schema.Record(Schema.String, Schema.String);
const Manifest = Schema.Struct({
  dependencies: Schema.optional(Dependencies),
  devDependencies: Schema.optional(Dependencies),
});
const Workspace = Schema.Struct({
  packages: Schema.optional(Schema.Array(Schema.String)),
  catalog: Schema.optional(Dependencies),
  catalogs: Schema.optional(Schema.Record(Schema.String, Dependencies)),
});

const readJson = <A, I>(schema: Schema.Codec<A, I>, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(file))) return Option.none<A>();
    const text = yield* fs.readFileString(file);
    return Option.some(
      yield* Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: () => new UnreadableFileError({ file }),
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(schema)),
        Effect.mapError(() => new UnreadableFileError({ file })),
      ),
    );
  });

const readWorkspace = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(file))) return Option.none<typeof Workspace.Type>();
    const text = yield* fs.readFileString(file);
    return Option.some(
      yield* Effect.try({
        try: () => Yaml.parse(text),
        catch: () => new UnreadableFileError({ file }),
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Workspace)),
        Effect.mapError(() => new UnreadableFileError({ file })),
      ),
    );
  });

/** The nearest `pnpm-workspace.yaml` from `directory` up to the repository's top, if any. */
const workspaceFileOf = Effect.fn("Consumer.workspaceFileOf")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = directory;
  for (;;) {
    const file = path.join(current, "pnpm-workspace.yaml");
    if (yield* fs.exists(file)) return Option.some(file);
    const parent = path.dirname(current);
    if ((yield* fs.exists(path.join(current, ".git"))) || parent === current)
      return Option.none<string>();
    current = parent;
  }
});

/**
 * The declaration `directory`'s `package.json` makes of devkit, `None` when it makes none. A
 * `catalog:` spec resolves to the workspace catalog's entry; a missing entry leaves the raw
 * `catalog:` spec, which is not a pin.
 */
export const declarationOf = Effect.fn("Consumer.declarationOf")(function* (
  directory: string,
) {
  const path = yield* Path.Path;
  const file = path.join(directory, "package.json");
  const manifest = yield* readJson(Manifest, file);
  const field = (["dependencies", "devDependencies"] as const).find(
    (name) => Option.getOrUndefined(manifest)?.[name]?.[PACKAGE] !== undefined,
  );
  const spec =
    field === undefined
      ? undefined
      : Option.getOrUndefined(manifest)?.[field]?.[PACKAGE];
  if (field === undefined || spec === undefined)
    return Option.none<Declaration>();
  const own: Declaration = { file, field, spec };
  if (!spec.startsWith("catalog:")) return Option.some(own);
  const name = spec.slice("catalog:".length);
  const workspaceFile = yield* workspaceFileOf(directory);
  if (Option.isNone(workspaceFile)) return Option.some(own);
  const workspace = yield* readWorkspace(workspaceFile.value);
  const catalogs = Option.getOrUndefined(workspace);
  const [catalogField, entries] =
    name === "" || name === "default"
      ? catalogs?.catalog === undefined
        ? (["catalogs.default", catalogs?.catalogs?.default] as const)
        : (["catalog", catalogs.catalog] as const)
      : ([`catalogs.${name}`, catalogs?.catalogs?.[name]] as const);
  const resolved = entries?.[PACKAGE];
  return Option.some(
    resolved === undefined
      ? own
      : { file: workspaceFile.value, field: catalogField, spec: resolved },
  );
});

const JSON_SPEC = /(?<head>"@mw10013\/devkit"\s*:\s*")(?<value>[^"]*)(?=")/gu;
const YAML_SPEC =
  /^(?<head>\s*["']?@mw10013\/devkit["']?\s*:[ \t]+)(?<value>"[^"]*"|'[^']*'|[^\s"'][^\s]*)/gmu;

/**
 * Rewrites the one line that holds the declared spec, keeping the rest of the file and the
 * value's quotes as they are. A file that names devkit on more than one line is refused.
 */
export const setSpec = Effect.fn("Consumer.setSpec")(function* (
  declaration: Declaration,
  spec: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(declaration.file);
  const json = declaration.file.endsWith(".json");
  const matches = [...text.matchAll(json ? JSON_SPEC : YAML_SPEC)];
  const [match, ...rest] = matches;
  const head = match?.groups?.head;
  const value = match?.groups?.value;
  if (
    match?.index === undefined ||
    head === undefined ||
    value === undefined ||
    rest.length > 0
  )
    return yield* new SpecEditError({
      file: declaration.file,
      matches: matches.length,
    });
  const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : "";
  const start = match.index + head.length;
  yield* fs.writeFileString(
    declaration.file,
    `${text.slice(0, start)}${quote}${spec}${quote}${text.slice(start + value.length)}`,
  );
});

const Stamp = Schema.Struct({ tools: Schema.String });

/** The tools commit a legacy `vendor/devkit/devkit.json` stamp records, `None` without one. */
export const legacyOf = Effect.fn("Consumer.legacyOf")(function* (
  directory: string,
) {
  const path = yield* Path.Path;
  return Option.map(
    yield* readJson(Stamp, path.join(directory, "vendor/devkit/devkit.json")),
    (stamp) => stamp.tools,
  );
});

const Lists = Schema.Array(
  Schema.Struct({
    dependencies: Schema.optional(
      Schema.Record(Schema.String, Schema.Struct({ version: Schema.String })),
    ),
    devDependencies: Schema.optional(
      Schema.Record(Schema.String, Schema.Struct({ version: Schema.String })),
    ),
    optionalDependencies: Schema.optional(
      Schema.Record(Schema.String, Schema.Struct({ version: Schema.String })),
    ),
  }),
);
const decodeLists = Schema.decodeUnknownOption(Schema.fromJsonString(Lists));

/**
 * The version pnpm resolved for devkit from the lockfile alone, which for a release is the
 * `version` its manifest was stamped with. `None` when pnpm fails or the lockfile lacks devkit.
 */
export const lockedOf = Effect.fn("Consumer.lockedOf")(function* (
  directory: string,
) {
  const output = yield* capture(directory, "pnpm", [
    "list",
    "--json",
    "--lockfile-only",
  ]).pipe(Effect.option);
  if (Option.isNone(output) || output.value.exitCode !== 0)
    return Option.none<string>();
  return Option.flatMap(decodeLists(output.value.stdout), (lists) =>
    Option.fromNullishOr(
      lists
        .map(
          (list) =>
            (list.dependencies ??
              list.devDependencies ??
              list.optionalDependencies)?.[PACKAGE]?.version,
        )
        .find((version) => version !== undefined),
    ),
  );
});

/**
 * `root` and each workspace package its `pnpm-workspace.yaml` lists, as directories that hold a
 * `package.json`. A pattern ending in `/*` or `/**` lists the folders directly under its base.
 */
export const packagesOf = Effect.fn("Consumer.packagesOf")(function* (
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspace = yield* readWorkspace(
    path.join(root, "pnpm-workspace.yaml"),
  );
  const patterns = (Option.getOrUndefined(workspace)?.packages ?? []).filter(
    (pattern) => !pattern.startsWith("!"),
  );
  const found: string[] = [root];
  for (const pattern of patterns) {
    const wide = /\/\*\*?$/u.test(pattern);
    const base = path.join(root, pattern.replace(/\/\*\*?$/u, ""));
    const candidates = wide
      ? (yield* fs
          .readDirectory(base)
          .pipe(Effect.orElseSucceed(() => []))).map((name) =>
          path.join(base, name),
        )
      : [base];
    for (const candidate of candidates)
      if (
        !candidate.split(path.sep).includes("node_modules") &&
        (yield* fs.exists(path.join(candidate, "package.json")))
      )
        found.push(candidate);
  }
  return found;
});
