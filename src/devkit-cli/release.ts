/**
 * `devkit release <x.y.z>` publishes devkit as the tag `devkit-v<x.y.z>`. The tag names an orphan
 * release commit whose tree is the built package, `LICENSE` and a short README, and nothing else:
 * apps install that commit as `github:mw10013/tools#devkit-v<x.y.z>`, and no branch holds it. Each
 * release commit's parent is the previous one, so `git log <tag>` is the release history. The
 * commit is written through a throwaway index, so the working tree is never touched.
 *
 * A tag is never moved, because lockfiles pin its commit.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { capture, run } from "#wt/process.ts";

import { requireClean } from "./checkout.ts";
import * as Spec from "./spec.ts";
import * as Tags from "./tags.ts";

const ORIGIN = "origin";
const MAIN = "main";
const SOURCE_PATH = "src/devkit";

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

/** The steps a release runs around its own git work, so a test can stand in for them. */
export interface Steps<E, R> {
  /** Refuses a source that does not pass its checks. */
  readonly verify: Effect.Effect<void, E, R>;
  /** Builds the package into `directory`, stamping `version` into its manifest. */
  readonly build: (
    directory: string,
    version: string,
  ) => Effect.Effect<unknown, E, R>;
}

const readmeOf = (version: string) =>
  `# @mw10013/devkit

The dev tooling shared by the apps, built from \`${SOURCE_PATH}\` in https://github.com/mw10013/tools at the commit this release commit's message names.

Install it as \`${Spec.specOf(version)}\`.

This commit holds build output only. Fix devkit in tools and release a new version.
`;

const SOURCE_LINE = /^Source: (?<sha>[0-9a-f]{40})$/mu;

export const release = Effect.fn("Release.release")(function* <E, R>(
  tools: string,
  version: string,
  options: { readonly dryRun: boolean } & Steps<E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = (...args: string[]) => run(tools, "git", args);
  const tag = Spec.tagOf(version);

  yield* requireClean(tools);
  const head = (yield* git("rev-parse", "HEAD")).trim();
  const origin = (yield* git("ls-remote", ORIGIN, `refs/heads/${MAIN}`))
    .split("\t")
    .at(0)
    ?.trim();
  if (head !== origin)
    return yield* new NotAtOriginMainError({ head, origin: origin ?? "" });
  if (Option.isNone(Spec.parseVersion(version)))
    return yield* new InvalidVersionError({ version });

  yield* git(
    "fetch",
    "--quiet",
    ORIGIN,
    `refs/tags/${Spec.TAG_PREFIX}*:refs/tags/${Spec.TAG_PREFIX}*`,
  );
  const published = yield* Tags.listTags(tools, ".");
  const latest = Tags.latestOf(published);
  const existing = published.find((entry) => entry.version === version);
  if (existing === undefined) {
    const greater = Option.match(
      Option.all({
        next: Spec.parseVersion(version),
        last: Option.flatMap(latest, (entry) =>
          Spec.parseVersion(entry.version),
        ),
      }),
      {
        onNone: () => true,
        onSome: ({ next, last }) => Spec.compareVersions(next, last) > 0,
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
        prefix: "devkit-release-",
      });
      const built = path.join(work, "package");
      yield* options.build(built, version);
      yield* fs.copyFile(
        path.join(tools, "LICENSE"),
        path.join(built, "LICENSE"),
      );
      yield* fs.writeFileString(
        path.join(built, "README.md"),
        readmeOf(version),
      );
      const env = { GIT_INDEX_FILE: path.join(work, "index") };
      yield* run(
        tools,
        "git",
        ["--work-tree", built, "add", "--all", "--force"],
        env,
      );
      return (yield* run(tools, "git", ["write-tree"], env)).trim();
    }),
  );
  const files = (yield* git("ls-tree", "-r", "--name-only", tree))
    .split("\n")
    .filter((file) => file.length > 0);
  const push = git("push", ORIGIN, `refs/tags/${tag}`);

  if (existing !== undefined) {
    const existingTree = (yield* git("rev-parse", `${tag}^{tree}`)).trim();
    if (existingTree !== tree)
      return yield* new TagTreeMismatchError({
        tag,
        existing: existingTree,
        built: tree,
      });
    const onOrigin =
      (yield* git("ls-remote", ORIGIN, `refs/tags/${tag}`)).trim() !== "";
    const publish = !onOrigin && !options.dryRun;
    if (publish) yield* push;
    return {
      version,
      tag,
      commit: existing.commit,
      tree,
      parent: Option.getOrNull(
        parentOf(yield* git("log", "-1", "--format=%P", existing.commit)),
      ),
      source: head,
      files,
      existing: true,
      dryRun: options.dryRun,
      tagged: false,
      pushed: publish,
    };
  }

  const parent = Option.map(latest, (entry) => entry.commit);
  const message = yield* releaseMessage(tools, version, head, latest);
  const commit = (yield* git(
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
  if (!options.dryRun) {
    yield* git("tag", "-a", tag, commit, "-m", message);
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
    dryRun: options.dryRun,
    tagged: !options.dryRun,
    pushed: !options.dryRun,
  };
});

const parentOf = (parents: string) =>
  Option.fromNullishOr(parents.trim().split(" ").at(0)).pipe(
    Option.filter((sha) => sha.length > 0),
  );

/**
 * The release commit's message and its tag's annotation, which `devkit upgrade` prints: the
 * version, the source commit it was built from, and the `src/devkit` commits since the previous
 * release's source.
 */
const releaseMessage = Effect.fn("Release.message")(function* (
  tools: string,
  version: string,
  source: string,
  previous: Option.Option<Tags.Tag>,
) {
  const header = `devkit ${version}\n\nSource: ${source}\n\n`;
  if (Option.isNone(previous)) return `${header}First release.\n`;
  const since = SOURCE_LINE.exec(
    yield* run(tools, "git", [
      "log",
      "-1",
      "--format=%B",
      previous.value.commit,
    ]),
  )?.groups?.sha;
  const reachable =
    since !== undefined &&
    (yield* capture(tools, "git", [
      "merge-base",
      "--is-ancestor",
      since,
      source,
    ])).exitCode === 0;
  if (!reachable)
    return `${header}Changes since ${previous.value.tag} are not listed: its source is not in this history.\n`;
  const changes = (yield* run(tools, "git", [
    "log",
    "--format=- %h %s",
    `${since}..${source}`,
    "--",
    SOURCE_PATH,
  ])).trim();
  return changes === ""
    ? `${header}No changes to ${SOURCE_PATH} since ${previous.value.tag}.\n`
    : `${header}Changes to ${SOURCE_PATH} since ${previous.value.tag}:\n${changes}\n`;
});
