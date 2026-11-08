/**
 * `devkit status` and `devkit check-pin`: what each app declares of devkit, what its lockfile
 * resolved and which release is latest. Consumers are derived by looking, never listed: a repository
 * is one when its root or a workspace package declares `@mw10013/devkit` or still holds a legacy
 * `vendor/devkit/devkit.json` stamp.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  compareVersions,
  latestOf,
  listTags,
  parseVersion,
  type Tag,
} from "#devkit/core/release.ts";

import * as Consumer from "./consumer.ts";
import * as Spec from "./spec.ts";

/**
 * `current` and `behind` compare the declared release with the latest, `unknown` when the latest
 * cannot be listed. `unpinned` is a trial spec, `legacy` a vendored copy with no declaration.
 */
export type State =
  | "current"
  | "behind"
  | "unknown"
  | "unpinned"
  | "legacy"
  | "none"
  | "unreadable";

export interface Row {
  readonly path: string;
  readonly state: State;
  readonly spec: string | null;
  /** The file and field that hold `spec`. */
  readonly declaredIn: string | null;
  /** The release `spec` pins. */
  readonly declared: string | null;
  /** What the lockfile resolved: the version the release's manifest was stamped with. */
  readonly locked: string | null;
  /** The latest release, or `unknown` when the tags cannot be listed. */
  readonly latest: string;
  /** Which trial an unpinned spec is. */
  readonly unpinned: Spec.UnpinnedKind | null;
  /** The tools commit a legacy stamp records. */
  readonly legacy: string | null;
  readonly error: string | null;
}

const UNKNOWN = "unknown";

const latestVersion = (tags: Option.Option<readonly Tag[]>) =>
  Option.flatMap(tags, (all) =>
    Option.map(latestOf(all), (entry) => entry.version),
  );

const stateOf = (
  declaration: Option.Option<Consumer.Declaration>,
  legacy: Option.Option<string>,
  latest: Option.Option<string>,
): State => {
  if (Option.isNone(declaration))
    return Option.isSome(legacy) ? "legacy" : "none";
  const pin = Spec.pinOf(declaration.value.spec);
  if (pin._tag === "Unpinned") return "unpinned";
  const ordered = Option.all({
    declared: parseVersion(pin.version),
    latest: Option.flatMap(latest, parseVersion),
  });
  return Option.match(ordered, {
    onNone: () => "unknown",
    onSome: ({ declared, latest: newest }) =>
      compareVersions(declared, newest) < 0 ? "behind" : "current",
  });
};

/** One directory's row. `latest` is looked up once by the caller. */
export const rowOf = Effect.fn("Status.rowOf")(function* (
  directory: string,
  latest: Option.Option<string>,
) {
  const declaration = yield* Consumer.declarationOf(directory);
  const legacy = yield* Consumer.legacyOf(directory);
  const locked = Option.isSome(declaration)
    ? yield* Consumer.lockedOf(directory)
    : Option.none<string>();
  const pin = Option.map(declaration, (found) => Spec.pinOf(found.spec));
  return {
    path: directory,
    state: stateOf(declaration, legacy, latest),
    spec: Option.getOrNull(Option.map(declaration, (found) => found.spec)),
    declaredIn: Option.getOrNull(
      Option.map(declaration, (found) => `${found.file}#${found.field}`),
    ),
    declared: Option.getOrNull(
      Option.flatMap(pin, (found) =>
        found._tag === "Pinned" ? Option.some(found.version) : Option.none(),
      ),
    ),
    locked: Option.getOrNull(locked),
    latest: Option.getOrElse(latest, () => UNKNOWN),
    unpinned: Option.getOrNull(
      Option.flatMap(pin, (found) =>
        found._tag === "Unpinned" ? Option.some(found.kind) : Option.none(),
      ),
    ),
    legacy: Option.getOrNull(legacy),
    error: null,
  } satisfies Row;
});

/** The latest release `remote` holds, `None` when it cannot be reached. */
export const latestOn = (directory: string, remote: string) =>
  listTags(directory, remote, Spec.TAG_PREFIX).pipe(
    Effect.option,
    Effect.map(latestVersion),
  );

const SKIPPED = new Set(["node_modules", ".git", "refs"]);

/**
 * A row for every consumer one level under `projects`: each repository's root and its workspace
 * packages. `node_modules`, `.git` and `refs` are skipped, and a directory that consumes nothing
 * gives no row.
 */
export const scan = Effect.fn("Status.scan")(function* (
  projects: string,
  remote: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const latest = yield* latestOn(projects, remote);
  const repositories: string[] = [];
  for (const name of (yield* fs.readDirectory(projects)).toSorted()) {
    const directory = path.join(projects, name);
    if (
      !SKIPPED.has(name) &&
      (yield* fs.stat(directory).pipe(Effect.option)).pipe(
        Option.exists((info) => info.type === "Directory"),
      )
    )
      repositories.push(directory);
  }
  const rows = yield* Effect.forEach(
    repositories,
    (repository) =>
      Effect.gen(function* () {
        const packages = yield* Consumer.packagesOf(repository).pipe(
          Effect.orElseSucceed(() => [repository]),
        );
        return yield* Effect.forEach(
          packages,
          (directory) =>
            rowOf(directory, latest).pipe(
              Effect.catchTag("UnreadableFileError", (error) =>
                Effect.succeed({
                  ...unreadableRow(directory, latest),
                  error: error.message,
                }),
              ),
            ),
          { concurrency: 4 },
        );
      }),
    { concurrency: 4 },
  );
  return {
    latest: Option.getOrElse(latest, () => UNKNOWN),
    rows: rows
      .flat()
      .filter((row) => row.state !== "none")
      .map((row) => ({ ...row, path: path.relative(projects, row.path) })),
  };
});

const unreadableRow = (directory: string, latest: Option.Option<string>) =>
  ({
    path: directory,
    state: "unreadable",
    spec: null,
    declaredIn: null,
    declared: null,
    locked: null,
    latest: Option.getOrElse(latest, () => UNKNOWN),
    unpinned: null,
    legacy: null,
    error: null,
  }) satisfies Row;

export interface Finding {
  readonly path: string;
  readonly spec: string | null;
  readonly reason: Spec.UnpinnedKind | "legacy";
}

export class UnpinnedDevkitError extends Schema.TaggedError<UnpinnedDevkitError>()(
  "UnpinnedDevkitError",
  {
    findings: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        spec: Schema.NullOr(Schema.String),
        reason: Schema.String,
      }),
    ),
  },
) {
  override get message() {
    return `${Spec.PACKAGE} is not pinned to a release: ${this.findings
      .map(
        (finding) =>
          `${finding.path} (${finding.reason}${finding.spec === null ? "" : `: ${finding.spec}`})`,
      )
      .join(", ")}; use ${Spec.specOf("<x.y.z>")}`;
  }
}

export class NoDevkitError extends Schema.TaggedError<NoDevkitError>()(
  "NoDevkitError",
  { directory: Schema.String },
) {
  override get message() {
    return `${this.directory} does not declare ${Spec.PACKAGE}`;
  }
}

/**
 * Fails unless every declaration under `directory` pins a release: its own `package.json` and, in
 * a workspace root, each workspace package's. A trial spec (`file:`, `link:`, a branch, a bare sha
 * or a prerelease) or a legacy vendor stamp fails it, so an app's check or CI can refuse to merge one.
 */
export const checkPin = Effect.fn("Status.checkPin")(function* (
  directory: string,
) {
  const findings: Finding[] = [];
  const pinned: { path: string; spec: string; version: string }[] = [];
  for (const packageDirectory of yield* Consumer.packagesOf(directory)) {
    const declaration = yield* Consumer.declarationOf(packageDirectory);
    if (Option.isNone(declaration)) {
      if (Option.isSome(yield* Consumer.legacyOf(packageDirectory)))
        findings.push({ path: packageDirectory, spec: null, reason: "legacy" });
      continue;
    }
    const { spec } = declaration.value;
    const pin = Spec.pinOf(spec);
    if (pin._tag === "Unpinned")
      findings.push({ path: packageDirectory, spec, reason: pin.kind });
    else pinned.push({ path: packageDirectory, spec, version: pin.version });
  }
  if (findings.length > 0) return yield* new UnpinnedDevkitError({ findings });
  if (pinned.length === 0) return yield* new NoDevkitError({ directory });
  return { pinned };
});
