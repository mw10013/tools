/**
 * Making and removing worktrees. wt knows git and two optional repo hooks:
 * a repo opts into more by having it. With a `package.json`, `new` runs
 * `vp install`, then the `worktree:init` script when there is one; `rm` runs
 * the `worktree:teardown` script when there is one, then `berth release`
 * when the checkout has a `berth.json`, and last closes the herdr workspace
 * open on it when no pane there runs anything.
 *
 * Worktrees live at `~/.t3/worktrees/<repo>/<name>`, the layout T3 Code
 * lists, and the directory and the branch share the name.
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

import * as Git from "./git.ts";
import * as Herdr from "./herdr.ts";
import { firstFree, fromWords, NAME_MAX, type WorktreeName } from "./name.ts";
import { run, stream } from "./process.ts";

/** The words spell no name. */
export class InvalidNameError extends Schema.TaggedError<InvalidNameError>()(
  "InvalidNameError",
  { words: Schema.String },
) {
  override get message() {
    return `"${this.words}" has no letter or digit to name a worktree with (kebab case, at most ${String(NAME_MAX)} characters)`;
  }
}

/** `--exact` and the name's branch or directory exists. */
export class NameTakenError extends Schema.TaggedError<NameTakenError>()(
  "NameTakenError",
  { name: Schema.String },
) {
  override get message() {
    return `${this.name} is taken: a branch or directory has that name`;
  }
}

/** No worktree of the repository matches. */
export class WorktreeNotFoundError extends Schema.TaggedError<WorktreeNotFoundError>()(
  "WorktreeNotFoundError",
  { target: Schema.String },
) {
  override get message() {
    return `no worktree matches ${this.target}; see wt list`;
  }
}

/** The main checkout is never removed. */
export class MainCheckoutError extends Schema.TaggedError<MainCheckoutError>()(
  "MainCheckoutError",
  { path: Schema.String },
) {
  override get message() {
    return `${this.path} is the main checkout, which wt never removes`;
  }
}

/** The worktree has changes that removing it would lose. */
export class UncommittedChangesError extends Schema.TaggedError<UncommittedChangesError>()(
  "UncommittedChangesError",
  { path: Schema.String },
) {
  override get message() {
    return `${this.path} has uncommitted changes; commit or discard them first`;
  }
}

/** The branch has commits that are not on the base and no merged PR at its tip. */
export class UnlandedWorkError extends Schema.TaggedError<UnlandedWorkError>()(
  "UnlandedWorkError",
  { branch: Schema.String, base: Schema.String, commits: Schema.Int },
) {
  override get message() {
    return `${this.branch} has ${String(this.commits)} commit(s) not on ${this.base} and no merged pull request at its tip; land it, or pass --force to discard it`;
  }
}

/** `$WT_ROOT`, default `~/.t3/worktrees`. */
const worktreesRoot = Effect.gen(function* () {
  const path = yield* Path.Path;
  return process.env.WT_ROOT ?? path.join(os.homedir(), ".t3", "worktrees");
});

const PackageScripts = Schema.fromJsonString(
  Schema.Struct({
    scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
);

/** `package.json`'s scripts in `directory`; `None` without a `package.json`. */
const packageScripts = Effect.fn("Worktree.packageScripts")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(directory, "package.json");
  if (!(yield* fs.exists(file))) return Option.none<ReadonlySet<string>>();
  const text = yield* fs.readFileString(file);
  return Option.some<ReadonlySet<string>>(
    new Set(
      Object.keys(
        Option.getOrElse(
          Schema.decodeUnknownOption(PackageScripts)(text),
          () => ({
            scripts: undefined,
          }),
        ).scripts ?? {},
      ),
    ),
  );
});

export interface Created {
  readonly path: string;
  readonly branch: WorktreeName;
  readonly base: string;
  readonly steps: ReadonlyArray<string>;
}

/**
 * A new worktree and branch named from `words`, started at `from` or the
 * repository's base, set up by its hooks.
 */
export const create = Effect.fn("Worktree.create")(function* (
  directory: string,
  words: ReadonlyArray<string>,
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
  const steps: Array<string> = ["git worktree add"];
  const scripts = yield* packageScripts(worktree);
  if (Option.isSome(scripts)) {
    yield* stream(worktree, "vp", ["install", "--frozen-lockfile"]);
    steps.push("vp install");
    if (scripts.value.has("worktree:init")) {
      yield* stream(worktree, "vp", ["run", "worktree:init"]);
      steps.push("vp run worktree:init");
    }
  }
  return { path: worktree, branch, base, steps } satisfies Created;
});

/**
 * The worktree `target` names: a directory name or a branch, else a path,
 * relative to `directory`, to the worktree or inside it.
 */
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
    .sort((a, b) => b.path.length - a.path.length);
  return yield* Effect.fromNullishOr(inside[0]).pipe(
    Effect.mapError(() => new WorktreeNotFoundError({ target })),
  );
});

export interface Removed {
  readonly path: string;
  readonly branch: Option.Option<string>;
  readonly landed: string;
  readonly steps: ReadonlyArray<string>;
}

/**
 * Removes a worktree and its branch, once its work is safe: no uncommitted
 * changes, and every commit on the base or in a merged PR at the branch's
 * tip. `force` skips the second check, never the first.
 */
export const remove = Effect.fn("Worktree.remove")(function* (
  directory: string,
  target: Option.Option<string>,
  options: { readonly force: boolean },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
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
  const steps: Array<string> = [];
  const scripts = yield* packageScripts(worktree.path);
  if (Option.exists(scripts, (names) => names.has("worktree:teardown"))) {
    yield* stream(worktree.path, "vp", ["run", "worktree:teardown"]);
    steps.push("vp run worktree:teardown");
  }
  if (yield* fs.exists(path.join(worktree.path, "berth.json"))) {
    yield* stream(worktree.path, "berth", ["release"]);
    steps.push("berth release");
  }
  yield* run(repository.root, "git", ["worktree", "remove", worktree.path]);
  steps.push("git worktree remove");
  if (Option.isSome(worktree.branch)) {
    yield* run(repository.root, "git", ["branch", "-D", worktree.branch.value]);
    steps.push("git branch -D");
  }
  for (const outcome of yield* Herdr.closeWorkspaces(
    repository.root,
    worktree.path,
  )) {
    yield* Console.error(`wt: ${outcome}`);
    if (outcome.startsWith("closed")) steps.push("herdr workspace close");
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
