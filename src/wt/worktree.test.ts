import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { parseWorktrees } from "./git.ts";
import * as Worktree from "./worktree.ts";

const git = (directory: string, ...args: Array<string>) =>
  execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();

const runEffect = <A, E>(
  effect: Effect.Effect<A, E, NodeServices.NodeServices>,
) => Effect.runPromiseExit(effect.pipe(Effect.provide(NodeServices.layer)));

const failureTag = (exit: Exit.Exit<unknown, { readonly _tag: string }>) =>
  Exit.isFailure(exit)
    ? Option.getOrUndefined(
        Option.map(Exit.findErrorOption(exit), (e) => e._tag),
      )
    : undefined;

let scratch: string;
let repo: string;

beforeEach(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wt-test-")));
  const origin = path.join(scratch, "origin.git");
  repo = path.join(scratch, "demo");
  git(scratch, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(scratch, "clone", "--quiet", origin, repo);
  git(repo, "config", "user.email", "wt@test");
  git(repo, "config", "user.name", "wt");
  fs.writeFileSync(path.join(repo, "README.md"), "demo\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "first");
  git(repo, "push", "--quiet", "origin", "main");
  git(repo, "remote", "set-head", "origin", "main");
  process.env.WT_ROOT = path.join(scratch, "worktrees");
});

afterEach(() => {
  delete process.env.WT_ROOT;
  fs.rmSync(scratch, { recursive: true, force: true });
});

const create = (words: Array<string>, exact = false) =>
  runEffect(Worktree.create(repo, words, { from: Option.none(), exact }));

const remove = (target: string, force = false) =>
  runEffect(Worktree.remove(repo, Option.some(target), { force }));

describe("parseWorktrees", () => {
  it("reads the main checkout, a branch and a detached HEAD", () => {
    const parsed = parseWorktrees(
      "worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /w\nHEAD bbb\ndetached\n",
    );
    expect(parsed).toStrictEqual([
      { path: "/r", head: "aaa", branch: Option.some("main"), main: true },
      { path: "/w", head: "bbb", branch: Option.none(), main: false },
    ]);
  });
});

describe("wt new", () => {
  it("makes the worktree under the repo's folder, on a branch of the same name, from origin's default branch", async () => {
    const exit = await create(["Fix", "plan labels"]);
    expect(Exit.isSuccess(exit)).toBe(true);
    const created = Exit.isSuccess(exit) ? exit.value : undefined;
    expect(created?.path).toBe(
      path.join(scratch, "worktrees", "demo", "fix-plan-labels"),
    );
    expect(created?.base).toBe("origin/main");
    expect(git(created?.path ?? repo, "branch", "--show-current")).toBe(
      "fix-plan-labels",
    );
    expect(() =>
      git(repo, "config", "--get", "branch.fix-plan-labels.merge"),
    ).toThrow();
  }, 30_000);

  it("adds -2 to a taken name, and --exact refuses it", async () => {
    await create(["fix"]);
    const second = await create(["fix"]);
    expect(Exit.isSuccess(second) && second.value.branch).toBe("fix-2");
    expect(failureTag(await create(["fix"], true))).toBe("NameTakenError");
  }, 30_000);

  it("refuses words with no letter or digit", async () => {
    expect(failureTag(await create(["!!"]))).toBe("InvalidNameError");
  });
});

describe("wt rm", () => {
  it("finds a worktree by name from the main checkout, whatever the process's directory", async () => {
    await create(["by-name"]);
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      const removed = await runEffect(
        Worktree.remove(repo, Option.some("by-name"), { force: false }),
      );
      expect(Exit.isSuccess(removed)).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  }, 30_000);

  it("refuses a name no worktree has", async () => {
    expect(failureTag(await remove("nothing-here"))).toBe(
      "WorktreeNotFoundError",
    );
  });

  it("removes a worktree with no commits beyond the base, and its branch", async () => {
    const exit = await create(["empty"]);
    const worktree = Exit.isSuccess(exit) ? exit.value.path : "";
    const removed = await remove("empty");
    expect(Exit.isSuccess(removed)).toBe(true);
    expect(fs.existsSync(worktree)).toBe(false);
    expect(git(repo, "branch", "--list", "empty")).toBe("");
  }, 30_000);

  it("removes a branch whose commits reached the base", async () => {
    const exit = await create(["landed"]);
    const worktree = Exit.isSuccess(exit) ? exit.value.path : "";
    fs.writeFileSync(path.join(worktree, "a.txt"), "a\n");
    git(worktree, "add", ".");
    git(worktree, "commit", "--quiet", "-m", "a");
    git(worktree, "push", "--quiet", "origin", "HEAD:main");
    expect(Exit.isSuccess(await remove("landed"))).toBe(true);
  }, 30_000);

  it("refuses unlanded commits unless forced", async () => {
    const exit = await create(["unlanded"]);
    const worktree = Exit.isSuccess(exit) ? exit.value.path : "";
    fs.writeFileSync(path.join(worktree, "b.txt"), "b\n");
    git(worktree, "add", ".");
    git(worktree, "commit", "--quiet", "-m", "b");
    expect(failureTag(await remove("unlanded"))).toBe("UnlandedWorkError");
    expect(fs.existsSync(worktree)).toBe(true);
    expect(Exit.isSuccess(await remove("unlanded", true))).toBe(true);
    expect(fs.existsSync(worktree)).toBe(false);
  }, 30_000);

  it("refuses uncommitted changes, even forced", async () => {
    const exit = await create(["dirty"]);
    const worktree = Exit.isSuccess(exit) ? exit.value.path : "";
    fs.writeFileSync(path.join(worktree, "c.txt"), "c\n");
    expect(failureTag(await remove("dirty", true))).toBe(
      "UncommittedChangesError",
    );
    expect(fs.existsSync(worktree)).toBe(true);
  }, 30_000);

  it("never removes the main checkout", async () => {
    expect(failureTag(await remove(repo))).toBe("MainCheckoutError");
  });

  it("finds the worktree a path inside it names", async () => {
    const exit = await create(["nested"]);
    const worktree = Exit.isSuccess(exit) ? exit.value.path : "";
    fs.mkdirSync(path.join(worktree, "sub"));
    const removed = await runEffect(
      Worktree.remove(path.join(worktree, "sub"), Option.none(), {
        force: false,
      }),
    );
    expect(Exit.isSuccess(removed)).toBe(true);
  }, 30_000);
});

describe("wt init", () => {
  const shareMain = () => {
    fs.writeFileSync(
      path.join(repo, ".gitignore"),
      "/refs\n.env\n.env.*\n!.env.example\n",
    );
    fs.writeFileSync(path.join(repo, ".env.example"), "A=\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "ignores");
    git(repo, "push", "--quiet", "origin", "main");
    fs.writeFileSync(path.join(repo, ".env"), "A=1\nB=2\n");
    fs.writeFileSync(path.join(repo, ".env.staging"), "S=1\n");
    fs.mkdirSync(path.join(repo, "refs"));
  };

  it("copies .env and links refs and untracked .env files, leaving tracked ones", async () => {
    shareMain();
    const exit = await create(["shared"]);
    const worktree = Exit.isSuccess(exit) ? exit.value.path : "";
    expect(fs.readFileSync(path.join(worktree, ".env"), "utf8")).toBe(
      "A=1\nB=2\n",
    );
    expect(fs.lstatSync(path.join(worktree, ".env")).isSymbolicLink()).toBe(
      false,
    );
    expect(fs.readlinkSync(path.join(worktree, ".env.staging"))).toBe(
      path.join(repo, ".env.staging"),
    );
    expect(fs.readlinkSync(path.join(worktree, "refs"))).toBe(
      path.join(repo, "refs"),
    );
    expect(
      fs.lstatSync(path.join(worktree, ".env.example")).isSymbolicLink(),
    ).toBe(false);
    expect(git(worktree, "status", "--porcelain")).toBe("");
  }, 30_000);

  it("rebuilds .env from the main checkout's on a second run", async () => {
    shareMain();
    const exit = await create(["again"]);
    const worktree = Exit.isSuccess(exit) ? exit.value.path : "";
    fs.writeFileSync(path.join(repo, ".env"), "A=1\nC=3\n");
    expect(
      Exit.isSuccess(await runEffect(Worktree.init(worktree, Option.none()))),
    ).toBe(true);
    expect(fs.readFileSync(path.join(worktree, ".env"), "utf8")).toBe(
      "A=1\nC=3\n",
    );
  }, 30_000);

  it("refuses a real file where a link belongs", async () => {
    shareMain();
    const exit = await create(["shadow"]);
    const worktree = Exit.isSuccess(exit) ? exit.value.path : "";
    fs.rmSync(path.join(worktree, ".env.staging"));
    fs.writeFileSync(path.join(worktree, ".env.staging"), "S=2\n");
    expect(
      failureTag(await runEffect(Worktree.init(worktree, Option.none()))),
    ).toBe("SharedPathError");
  }, 30_000);

  it("refuses the main checkout", async () => {
    expect(
      failureTag(await runEffect(Worktree.init(repo, Option.none()))),
    ).toBe("MainCheckoutError");
  });
});
