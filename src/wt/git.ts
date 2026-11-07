import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { capture, run } from "./process.ts";

export class NotARepositoryError extends Schema.TaggedError<NotARepositoryError>()(
  "NotARepositoryError",
  { directory: Schema.String },
) {
  override get message() {
    return `${this.directory} is not inside a git repository`;
  }
}

export interface Worktree {
  readonly path: string;
  readonly head: string;
  readonly branch: Option.Option<string>;
  readonly main: boolean;
}

// git lists the main checkout first.
export const parseWorktrees = (porcelain: string): readonly Worktree[] =>
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

export interface Repository {
  readonly root: string;
  /** T3 Code groups worktrees by this. */
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

/**
 * The app a directory belongs to: the nearest directory from it upward that
 * holds a `package.json`, never above the git toplevel, which is the answer
 * when none does. bosun and devkit key on it, so each app in a monorepo is its
 * own unit and a single-app repo's is its toplevel.
 */
export const appRoot = Effect.fn("Git.appRoot")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const toplevel = (yield* run(directory, "git", [
    "rev-parse",
    "--show-toplevel",
  ]).pipe(
    Effect.catchTag("CommandFailedError", () =>
      Effect.fail(new NotARepositoryError({ directory })),
    ),
  )).trim();
  // git prints the toplevel with symlinks resolved, so the walk compares real paths.
  let candidate = yield* Effect.orDie(fs.realPath(directory));
  while (candidate !== toplevel && candidate !== path.dirname(candidate)) {
    if (yield* Effect.orDie(fs.exists(path.join(candidate, "package.json"))))
      return candidate;
    candidate = path.dirname(candidate);
  }
  return toplevel;
});

export const worktrees = Effect.fn("Git.worktrees")(function* (
  repository: Repository,
) {
  return parseWorktrees(
    yield* run(repository.root, "git", ["worktree", "list", "--porcelain"]),
  );
});

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

/** Offline, wt carries on with the refs it has. */
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

export const isDirty = Effect.fn("Git.isDirty")(function* (path: string) {
  return (yield* run(path, "git", ["status", "--porcelain"])).trim().length > 0;
});

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

/** A squash merge puts none of the branch's commits on the base; the merged PR is the evidence. */
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
