/**
 * Worktrees live at `~/.t3/worktrees/<repo>/<name>`, the layout T3 Code
 * lists.
 *
 * @module
 */
import * as os from "node:os";

import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  describeOrphan,
  orphansIn,
  stopOrphans,
} from "#devkit/core/orphans.ts";

import * as Git from "./git.ts";
import { firstFree, fromWords, NAME_MAX, type WorktreeName } from "./name.ts";
import { run, stream } from "./process.ts";
import { share } from "./share.ts";
import * as Teardown from "./teardown.ts";

export class InvalidNameError extends Schema.TaggedError<InvalidNameError>()(
  "InvalidNameError",
  { words: Schema.String },
) {
  override get message() {
    return `"${this.words}" has no letter or digit to name a worktree with (kebab case, at most ${String(NAME_MAX)} characters)`;
  }
}

export class NameTakenError extends Schema.TaggedError<NameTakenError>()(
  "NameTakenError",
  { name: Schema.String },
) {
  override get message() {
    return `${this.name} is taken: a branch or directory has that name`;
  }
}

export class WorktreeNotFoundError extends Schema.TaggedError<WorktreeNotFoundError>()(
  "WorktreeNotFoundError",
  { target: Schema.String },
) {
  override get message() {
    return `no worktree matches ${this.target}; see wt list`;
  }
}

export class MainCheckoutError extends Schema.TaggedError<MainCheckoutError>()(
  "MainCheckoutError",
  { path: Schema.String },
) {
  override get message() {
    return `${this.path} is the main checkout; wt changes linked worktrees only`;
  }
}

export class UncommittedChangesError extends Schema.TaggedError<UncommittedChangesError>()(
  "UncommittedChangesError",
  { path: Schema.String },
) {
  override get message() {
    return `${this.path} has uncommitted changes; commit or discard them first`;
  }
}

export class UnlandedWorkError extends Schema.TaggedError<UnlandedWorkError>()(
  "UnlandedWorkError",
  { branch: Schema.String, base: Schema.String, commits: Schema.Int },
) {
  override get message() {
    return `${this.branch} has ${String(this.commits)} commit(s) not on ${this.base} and no merged pull request at its tip; land it, or pass --force to discard it`;
  }
}

const worktreesRoot = Effect.gen(function* () {
  const path = yield* Path.Path;
  return process.env.WT_ROOT ?? path.join(os.homedir(), ".t3", "worktrees");
});

export interface Created {
  readonly path: string;
  readonly branch: WorktreeName;
  readonly base: string;
  readonly steps: readonly string[];
}

export const create = Effect.fn("Worktree.create")(function* (
  directory: string,
  words: readonly string[],
  options: { readonly from: Option.Option<string>; readonly exact: boolean },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repository = yield* Git.repositoryOf(directory);
  const requested = yield* Effect.fromOption(fromWords(words)).pipe(
    Effect.mapError(() => new InvalidNameError({ words: words.join(" ") })),
  );
  const parent = path.join(yield* worktreesRoot, repository.name);
  yield* Git.fetchOrigin(repository);
  const branches = new Set(
    (yield* run(repository.root, "git", [
      "for-each-ref",
      "--format=%(refname:lstrip=-1)",
      "refs/heads",
      "refs/remotes/origin",
    ]))
      .split("\n")
      .filter((line) => line.length > 0),
  );
  const directories = new Set(
    (yield* fs.exists(parent)) ? yield* fs.readDirectory(parent) : [],
  );
  const taken = (candidate: string) =>
    branches.has(candidate) || directories.has(candidate);
  if (options.exact && taken(requested))
    return yield* new NameTakenError({ name: requested });
  const branch = firstFree(requested, taken);
  const base = Option.isSome(options.from)
    ? options.from.value
    : yield* Git.baseRef(repository);
  const worktree = path.join(parent, branch);
  yield* fs.makeDirectory(parent, { recursive: true });
  yield* run(repository.root, "git", [
    "worktree",
    "add",
    "--no-track",
    "-b",
    branch,
    worktree,
    base,
  ]);
  yield* Console.error(`wt: created ${worktree} on ${branch} from ${base}`);
  const steps: string[] = ["git worktree add"];
  yield* share(worktree, repository.root);
  steps.push("share");
  if (yield* fs.exists(path.join(worktree, "package.json"))) {
    yield* stream(worktree, "vp", ["install", "--frozen-lockfile"]);
    steps.push("vp install");
  }
  return { path: worktree, branch, base, steps } satisfies Created;
});

export interface Initialized {
  readonly path: string;
  readonly steps: readonly string[];
}

export const init = Effect.fn("Worktree.init")(function* (
  directory: string,
  target: Option.Option<string>,
) {
  const repository = yield* Git.repositoryOf(directory);
  const worktree = yield* find(
    repository,
    directory,
    Option.getOrElse(target, () => "."),
  );
  if (worktree.main)
    return yield* new MainCheckoutError({ path: worktree.path });
  yield* share(worktree.path, repository.root);
  return { path: worktree.path, steps: ["share"] } satisfies Initialized;
});

const find = Effect.fn("Worktree.find")(function* (
  repository: Git.Repository,
  directory: string,
  target: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const all = yield* Git.worktrees(repository);
  const named = all.find(
    (worktree) =>
      !worktree.main &&
      (path.basename(worktree.path) === target ||
        Option.contains(worktree.branch, target)),
  );
  if (named !== undefined) return named;
  const resolved = path.resolve(directory, target);
  if (!(yield* fs.exists(resolved)))
    return yield* new WorktreeNotFoundError({ target });
  const real = yield* fs.realPath(resolved);
  const inside = all
    .filter(
      (worktree) =>
        real === worktree.path || real.startsWith(`${worktree.path}/`),
    )
    .toSorted((a, b) => b.path.length - a.path.length);
  return yield* Effect.fromNullishOr(inside[0]).pipe(
    Effect.mapError(() => new WorktreeNotFoundError({ target })),
  );
});

export interface Removed {
  readonly path: string;
  readonly branch: Option.Option<string>;
  readonly landed: string;
  readonly steps: readonly string[];
}

export const remove = Effect.fn("Worktree.remove")(function* (
  directory: string,
  target: Option.Option<string>,
  options: { readonly force: boolean },
) {
  const repository = yield* Git.repositoryOf(directory);
  const worktree = yield* find(
    repository,
    directory,
    Option.getOrElse(target, () => "."),
  );
  if (worktree.main)
    return yield* new MainCheckoutError({ path: worktree.path });
  if (yield* Git.isDirty(worktree.path))
    return yield* new UncommittedChangesError({ path: worktree.path });
  yield* Git.fetchOrigin(repository);
  const base = yield* Git.baseRef(repository);
  const ahead = yield* Git.commitsAhead(repository, base, worktree.head);
  let landed = `no commits beyond ${base}`;
  if (ahead > 0) {
    const pr = Option.isSome(worktree.branch)
      ? yield* Git.mergedPullRequest(
          repository,
          worktree.branch.value,
          worktree.head,
        )
      : Option.none<number>();
    if (Option.isSome(pr)) landed = `merged in PR #${String(pr.value)}`;
    else if (options.force) landed = `discarded by --force`;
    else
      return yield* new UnlandedWorkError({
        branch: Option.getOrElse(worktree.branch, () => worktree.head),
        base,
        commits: ahead,
      });
  }
  const steps = yield* Teardown.run(
    yield* Teardown.discover(worktree.path),
    worktree.path,
  );
  // What is still running inside the worktree with no owner, a leaked workerd for one, would
  // keep working in a directory that no longer exists.
  const orphans = yield* Effect.sync(() => orphansIn(worktree.path));
  if (orphans.length > 0) {
    yield* Effect.sync(() => {
      stopOrphans(orphans);
    });
    yield* Console.error(
      `wt: stopped what ${worktree.path} left running: ${orphans.map(describeOrphan).join(", ")}`,
    );
    steps.push("stopped orphans");
  }
  yield* run(repository.root, "git", ["worktree", "remove", worktree.path]);
  steps.push("git worktree remove");
  if (Option.isSome(worktree.branch)) {
    yield* run(repository.root, "git", ["branch", "-D", worktree.branch.value]);
    steps.push("git branch -D");
  }
  yield* Console.error(`wt: removed ${worktree.path} (${landed})`);
  return {
    path: worktree.path,
    branch: worktree.branch,
    landed,
    steps,
  } satisfies Removed;
});

export interface Listed {
  readonly path: string;
  readonly branch: Option.Option<string>;
  readonly head: string;
  readonly main: boolean;
  readonly dirty: boolean;
}

export const list = Effect.fn("Worktree.list")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const repository = yield* Git.repositoryOf(directory);
  return yield* Effect.forEach(yield* Git.worktrees(repository), (worktree) =>
    Effect.gen(function* () {
      const present = yield* fs.exists(worktree.path);
      return {
        ...worktree,
        dirty: present ? yield* Git.isDirty(worktree.path) : false,
      } satisfies Listed;
    }),
  );
});
