/**
 * What wt asks of git and gh. Paths are absolute and real.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { capture, run } from "./process.ts";

/** The directory is not inside a git repository. */
export class NotARepositoryError extends Schema.TaggedError<NotARepositoryError>()(
  "NotARepositoryError",
  { directory: Schema.String },
) {
  override get message() {
    return `${this.directory} is not inside a git repository`;
  }
}

/** One entry of `git worktree list`. The first is the main checkout. */
export interface Worktree {
  readonly path: string;
  readonly head: string;
  readonly branch: Option.Option<string>;
  readonly main: boolean;
}

/** Parses `git worktree list --porcelain`. */
export const parseWorktrees = (porcelain: string): ReadonlyArray<Worktree> =>
  porcelain
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block, index) => {
      const lines = block.split("\n");
      const field = (key: string) =>
        Option.fromNullishOr(
          lines
            .find((line) => line.startsWith(`${key} `))
            ?.slice(key.length + 1),
        );
      return {
        path: Option.getOrElse(field("worktree"), () => ""),
        head: Option.getOrElse(field("HEAD"), () => ""),
        branch: Option.map(field("branch"), (ref) =>
          ref.replace(/^refs\/heads\//u, ""),
        ),
        main: index === 0,
      };
    });

/** A repository, from any of its checkouts. */
export interface Repository {
  /** The main checkout's directory. */
  readonly root: string;
  /** The main checkout's directory name, which T3 Code groups worktrees by. */
  readonly name: string;
  readonly hasOrigin: boolean;
}

export const repositoryOf = Effect.fn("Git.repositoryOf")(function* (
  directory: string,
) {
  const path = yield* Path.Path;
  const commonDir = yield* run(directory, "git", [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]).pipe(
    Effect.catchTag("CommandFailedError", () =>
      Effect.fail(new NotARepositoryError({ directory })),
    ),
  );
  const root = path.dirname(commonDir.trim());
  const remotes = yield* run(root, "git", ["remote"]);
  return {
    root,
    name: path.basename(root),
    hasOrigin: remotes.split("\n").includes("origin"),
  } satisfies Repository;
});

export const worktrees = Effect.fn("Git.worktrees")(function* (
  repository: Repository,
) {
  return parseWorktrees(
    yield* run(repository.root, "git", ["worktree", "list", "--porcelain"]),
  );
});

/** Whether `ref` (a full ref name) exists. */
export const refExists = Effect.fn("Git.refExists")(function* (
  repository: Repository,
  ref: string,
) {
  const output = yield* capture(repository.root, "git", [
    "show-ref",
    "--verify",
    "--quiet",
    ref,
  ]);
  return output.exitCode === 0;
});

/**
 * Updates the remote-tracking refs, so a base and a landed check see what
 * GitHub has. Offline, wt carries on with the refs it has.
 */
export const fetchOrigin = Effect.fn("Git.fetchOrigin")(function* (
  repository: Repository,
) {
  if (!repository.hasOrigin) return false;
  const output = yield* capture(repository.root, "git", [
    "fetch",
    "--quiet",
    "--prune",
    "origin",
  ]);
  return output.exitCode === 0;
});

/**
 * Where new work starts and what landed work is in: `origin/<default>` when
 * the repository has a remote, else the main checkout's branch.
 */
export const baseRef = Effect.fn("Git.baseRef")(function* (
  repository: Repository,
) {
  if (repository.hasOrigin) {
    const head = yield* capture(repository.root, "git", [
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    if (head.exitCode === 0) return head.stdout.trim();
    if (yield* refExists(repository, "refs/remotes/origin/main"))
      return "origin/main";
  }
  const branch = (yield* run(repository.root, "git", [
    "branch",
    "--show-current",
  ])).trim();
  return branch.length > 0 ? branch : "HEAD";
});

/** Whether the checkout has changes git would lose: modified, staged or untracked. */
export const isDirty = Effect.fn("Git.isDirty")(function* (path: string) {
  return (yield* run(path, "git", ["status", "--porcelain"])).trim().length > 0;
});

/** Commits on `ref` that `base` lacks. */
export const commitsAhead = Effect.fn("Git.commitsAhead")(function* (
  repository: Repository,
  base: string,
  ref: string,
) {
  return Number(
    (yield* run(repository.root, "git", [
      "rev-list",
      "--count",
      `${base}..${ref}`,
    ])).trim(),
  );
});

const MergedPullRequests = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({ number: Schema.Int, headRefOid: Schema.String }),
  ),
);

/**
 * The merged pull request whose head was `head`, the evidence a squash merge
 * leaves, since a squash puts none of the branch's commits on the base.
 * `None` when gh finds none or cannot ask.
 */
export const mergedPullRequest = Effect.fn("Git.mergedPullRequest")(function* (
  repository: Repository,
  branch: string,
  head: string,
) {
  if (!repository.hasOrigin) return Option.none<number>();
  const output = yield* capture(repository.root, "gh", [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "merged",
    "--json",
    "number,headRefOid",
  ]);
  if (output.exitCode !== 0) return Option.none<number>();
  return Option.map(
    Option.flatMap(
      Schema.decodeUnknownOption(MergedPullRequests)(output.stdout),
      (prs) => Option.fromNullishOr(prs.find((pr) => pr.headRefOid === head)),
    ),
    (pr) => pr.number,
  );
});
