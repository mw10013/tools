/**
 * Releases a repository's built package as an annotated tag `<tagPrefix><x.y.z>`. The tag names
 * an orphan release commit whose tree is what the caller's `build` writes plus a README, and
 * nothing else: an app installs that commit as `github:<owner>/<repo>#<tag>`, and no branch holds
 * it. Each release commit's parent is the previous one, so `git log <tag>` is the release history.
 * The commit is written through a throwaway index, so the working tree is never touched.
 *
 * A tag is never moved, because lockfiles pin its commit. Releasing a version that exists again
 * succeeds and creates nothing when the build gives the same tree.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { runCommand } from "./command.ts";

const ORIGIN = "origin";
const MAIN = "main";

/** A release version: `major.minor.patch` and nothing after it. Releases carry no prerelease. */
export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const STABLE = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$/u;

export const parseVersion = (text: string): Option.Option<Version> => {
  const groups = STABLE.exec(text)?.groups;
  if (groups === undefined) return Option.none();
  return Option.some({
    major: Number(groups.major),
    minor: Number(groups.minor),
    patch: Number(groups.patch),
  });
};

export const compareVersions = (a: Version, b: Version) =>
  a.major - b.major || a.minor - b.minor || a.patch - b.patch;

/** The version a `<tagPrefix><x.y.z>` tag names, `None` for any other name. */
export const versionOfTag = (tagPrefix: string, tag: string) =>
  tag.startsWith(tagPrefix)
    ? Option.filter(Option.some(tag.slice(tagPrefix.length)), (version) =>
        Option.isSome(parseVersion(version)),
      )
    : Option.none<string>();

/** A published release. `commit` is the release commit the tag names, which lockfiles pin. */
export interface Tag {
  readonly version: string;
  readonly tag: string;
  readonly commit: string;
}

const byVersion = (a: Tag, b: Tag) =>
  Option.match(
    Option.all({ a: parseVersion(a.version), b: parseVersion(b.version) }),
    { onNone: () => 0, onSome: ({ a, b }) => compareVersions(a, b) },
  );

/**
 * The `<tagPrefix><x.y.z>` tags in the `refs/tags/` lines of `ls-remote`, oldest first. A peeled
 * `^{}` line names the commit.
 */
export const parseTags = (
  tagPrefix: string,
  lsRemote: string,
): readonly Tag[] => {
  const commits = new Map<string, string>();
  for (const line of lsRemote.split("\n")) {
    const [sha = "", ref = ""] = line.split("\t");
    if (!ref.startsWith("refs/tags/")) continue;
    const name = ref.slice("refs/tags/".length);
    const peeled = name.endsWith("^{}");
    const tag = peeled ? name.slice(0, -3) : name;
    if (peeled || !commits.has(tag)) commits.set(tag, sha);
  }
  return [...commits]
    .flatMap(([tag, commit]) =>
      Option.match(versionOfTag(tagPrefix, tag), {
        onNone: () => [],
        onSome: (version): Tag[] => [{ version, tag, commit }],
      }),
    )
    .toSorted(byVersion);
};

export const latestOf = (tags: readonly Tag[]) =>
  Option.fromNullishOr(tags.at(-1));

export class TagsUnreachableError extends Schema.TaggedError<TagsUnreachableError>()(
  "TagsUnreachableError",
  { remote: Schema.String, tagPrefix: Schema.String, detail: Schema.String },
) {
  override get message() {
    return `cannot list the ${this.tagPrefix}* releases of ${this.remote}: ${this.detail}`;
  }
}

const git = (
  directory: string,
  args: readonly string[],
  env?: Record<string, string>,
) => runCommand("git", ["-C", directory, ...args], undefined, env);

const lastLine = (text: string) =>
  text.trim().split("\n").at(-1) ?? "no output";

/**
 * The releases `remote` (a URL, or `.` for the local tags) holds, oldest first, run from
 * `directory`. Fails when it cannot be reached.
 */
export const listTags = Effect.fn("Release.listTags")(function* (
  directory: string,
  remote: string,
  tagPrefix: string,
) {
  const output = yield* git(directory, [
    "ls-remote",
    "--tags",
    remote,
    `refs/tags/${tagPrefix}*`,
  ]).pipe(
    Effect.mapError(
      (error) =>
        new TagsUnreachableError({
          remote,
          tagPrefix,
          detail: lastLine(error.message),
        }),
    ),
  );
  return parseTags(tagPrefix, output);
});

export class DirtyCheckoutError extends Schema.TaggedError<DirtyCheckoutError>()(
  "DirtyCheckoutError",
  { directory: Schema.String, changes: Schema.Array(Schema.String) },
) {
  override get message() {
    return `${this.directory} has uncommitted changes: ${this.changes.join(", ")}`;
  }
}

/** Fails while the checkout holds a change, a deleted file or an untracked one. */
export const requireClean = Effect.fn("Release.requireClean")(function* (
  directory: string,
) {
  const changes = (yield* git(directory, ["status", "--porcelain"]))
    .split("\n")
    .filter((line) => line.length > 0);
  if (changes.length > 0)
    return yield* new DirtyCheckoutError({
      directory,
      changes: changes.slice(0, 5).map((line) => line.slice(3)),
    });
});

export class NotAtOriginMainError extends Schema.TaggedError<NotAtOriginMainError>()(
  "NotAtOriginMainError",
  { head: Schema.String, origin: Schema.String },
) {
  override get message() {
    return `HEAD ${this.head.slice(0, 7)} is not ${ORIGIN}/${MAIN} ${this.origin.slice(0, 7)}: release from the merged commit`;
  }
}

export class InvalidVersionError extends Schema.TaggedError<InvalidVersionError>()(
  "InvalidVersionError",
  { version: Schema.String },
) {
  override get message() {
    return `${this.version} is not a release version: write major.minor.patch, with no prefix or prerelease`;
  }
}

export class VersionNotGreaterError extends Schema.TaggedError<VersionNotGreaterError>()(
  "VersionNotGreaterError",
  { version: Schema.String, latest: Schema.String },
) {
  override get message() {
    return `${this.version} is not greater than the latest release ${this.latest}`;
  }
}

export class TagTreeMismatchError extends Schema.TaggedError<TagTreeMismatchError>()(
  "TagTreeMismatchError",
  { tag: Schema.String, existing: Schema.String, built: Schema.String },
) {
  override get message() {
    return `${this.tag} already exists with tree ${this.existing.slice(0, 7)}, but this checkout builds ${this.built.slice(0, 7)}; a release tag is never moved, so release the next version`;
  }
}

/** What one repository's releases are: where they come from, what they are called and what they hold. */
export interface Options<E, R> {
  /** The checkout to release from. Its `HEAD` must be `origin/main`, with no change. */
  readonly repo: string;
  /** The release commit's first line is `<name> <version>`. */
  readonly name: string;
  /** Each release is the tag `<tagPrefix><version>`. */
  readonly tagPrefix: string;
  /** The path whose commits since the previous release the message lists. */
  readonly sourcePath: string;
  /** The tree's `README.md`. */
  readonly readme: (version: string) => string;
  /** Refuses a source that does not pass its checks. Skipped when the version exists. */
  readonly verify: Effect.Effect<void, E, R>;
  /** Writes the tree, except its README, into `directory`, which does not exist yet. */
  readonly build: (
    directory: string,
    version: string,
  ) => Effect.Effect<unknown, E, R>;
}

const SOURCE_LINE = /^Source: (?<sha>[0-9a-f]{40})$/mu;

const parentOf = (parents: string) =>
  Option.fromNullishOr(parents.trim().split(" ").at(0)).pipe(
    Option.filter((sha) => sha.length > 0),
  );

/**
 * Releases `version`. A dry run builds the tree and writes the release commit, but creates no tag
 * and pushes nothing. When the version exists, its tree must equal the built one; the tag is then
 * pushed if origin lacks it, and nothing else is created.
 */
export const release = Effect.fn("Release.release")(function* <E, R>(
  options: Options<E, R> & {
    readonly version: string;
    readonly dryRun: boolean;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { repo, version, tagPrefix, dryRun } = options;
  const run = (...args: string[]) => git(repo, args);
  const tag = `${tagPrefix}${version}`;

  yield* requireClean(repo);
  const head = (yield* run("rev-parse", "HEAD")).trim();
  const origin = (yield* run("ls-remote", ORIGIN, `refs/heads/${MAIN}`))
    .split("\t")
    .at(0)
    ?.trim();
  if (head !== origin)
    return yield* new NotAtOriginMainError({ head, origin: origin ?? "" });
  if (Option.isNone(parseVersion(version)))
    return yield* new InvalidVersionError({ version });

  yield* run(
    "fetch",
    "--quiet",
    ORIGIN,
    `refs/tags/${tagPrefix}*:refs/tags/${tagPrefix}*`,
  );
  const published = yield* listTags(repo, ".", tagPrefix);
  const latest = latestOf(published);
  const existing = published.find((entry) => entry.version === version);
  if (existing === undefined) {
    const greater = Option.match(
      Option.all({
        next: parseVersion(version),
        last: Option.flatMap(latest, (entry) => parseVersion(entry.version)),
      }),
      {
        onNone: () => true,
        onSome: ({ next, last }) => compareVersions(next, last) > 0,
      },
    );
    if (!greater)
      return yield* new VersionNotGreaterError({
        version,
        latest: Option.match(latest, {
          onNone: () => "",
          onSome: (entry) => entry.version,
        }),
      });
    yield* options.verify;
  }

  const tree = yield* Effect.scoped(
    Effect.gen(function* () {
      const work = yield* fs.makeTempDirectoryScoped({
        prefix: `${options.name}-release-`,
      });
      const built = path.join(work, "package");
      yield* options.build(built, version);
      yield* fs.writeFileString(
        path.join(built, "README.md"),
        options.readme(version),
      );
      const env = { GIT_INDEX_FILE: path.join(work, "index") };
      yield* git(repo, ["--work-tree", built, "add", "--all", "--force"], env);
      return (yield* git(repo, ["write-tree"], env)).trim();
    }),
  );
  const files = (yield* run("ls-tree", "-r", "--name-only", tree))
    .split("\n")
    .filter((file) => file.length > 0);
  const push = run("push", ORIGIN, `refs/tags/${tag}`);

  if (existing !== undefined) {
    const existingTree = (yield* run("rev-parse", `${tag}^{tree}`)).trim();
    if (existingTree !== tree)
      return yield* new TagTreeMismatchError({
        tag,
        existing: existingTree,
        built: tree,
      });
    const onOrigin =
      (yield* run("ls-remote", ORIGIN, `refs/tags/${tag}`)).trim() !== "";
    const publish = !onOrigin && !dryRun;
    if (publish) yield* push;
    return {
      version,
      tag,
      commit: existing.commit,
      tree,
      parent: Option.getOrNull(
        parentOf(yield* run("log", "-1", "--format=%P", existing.commit)),
      ),
      source: head,
      files,
      existing: true,
      dryRun,
      tagged: false,
      pushed: publish,
    };
  }

  const parent = Option.map(latest, (entry) => entry.commit);
  const message = yield* releaseMessage(options, head, latest);
  const commit = (yield* run(
    "commit-tree",
    tree,
    ...Option.match(parent, {
      onNone: () => [],
      onSome: (sha) => ["-p", sha],
    }),
    "-m",
    message,
  )).trim();
  // A dry run stops before the tag: a local tag is a ref every worktree of the repository shares.
  if (!dryRun) {
    yield* run("tag", "-a", tag, commit, "-m", message);
    yield* push;
  }
  return {
    version,
    tag,
    commit,
    tree,
    parent: Option.getOrNull(parent),
    source: head,
    files,
    existing: false,
    dryRun,
    tagged: !dryRun,
    pushed: !dryRun,
  };
});

/**
 * The release commit's message and its tag's annotation: the version, the source commit it was
 * built from, and the `sourcePath` commits since the previous release's source.
 */
const releaseMessage = Effect.fn("Release.message")(function* (
  options: {
    readonly repo: string;
    readonly name: string;
    readonly version: string;
    readonly sourcePath: string;
  },
  source: string,
  previous: Option.Option<Tag>,
) {
  const { repo, sourcePath } = options;
  const header = `${options.name} ${options.version}\n\nSource: ${source}\n\n`;
  if (Option.isNone(previous)) return `${header}First release.\n`;
  const since = SOURCE_LINE.exec(
    yield* git(repo, ["log", "-1", "--format=%B", previous.value.commit]),
  )?.groups?.sha;
  const reachable =
    since !== undefined &&
    (yield* git(repo, ["merge-base", "--is-ancestor", since, source]).pipe(
      Effect.as(true),
      Effect.catchTag("CommandError", () => Effect.succeed(false)),
    ));
  if (!reachable)
    return `${header}Changes since ${previous.value.tag} are not listed: its source is not in this history.\n`;
  const changes = (yield* git(repo, [
    "log",
    "--format=- %h %s",
    `${since}..${source}`,
    "--",
    sourcePath,
  ])).trim();
  return changes === ""
    ? `${header}No changes to ${sourcePath} since ${previous.value.tag}.\n`
    : `${header}Changes to ${sourcePath} since ${previous.value.tag}:\n${changes}\n`;
});
