import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import * as Share from "./share.ts";

const runEffect = <A, E>(
  effect: Effect.Effect<A, E, NodeServices.NodeServices>,
) => Effect.runPromiseExit(effect.pipe(Effect.provide(NodeServices.layer)));

const git = (directory: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();

let scratch: string;
let main: string;
let worktree: string;

const write = (root: string, file: string, content = "") => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
};

const commit = (files: Record<string, string>) => {
  for (const [file, content] of Object.entries(files))
    write(main, file, content);
  git(main, "add", ".");
  git(main, "commit", "--quiet", "-m", "files");
};

const discovered = async () => {
  const exit = await runEffect(Share.discover(main));
  return Exit.isSuccess(exit) ? exit.value.map((s) => s.path) : exit;
};

const share = () => runEffect(Share.share(worktree, main));

beforeEach(() => {
  scratch = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "wt-share-")),
  );
  main = path.join(scratch, "main");
  worktree = path.join(scratch, "worktree");
  fs.mkdirSync(main);
  fs.mkdirSync(worktree);
  git(main, "init", "--quiet", "--initial-branch=main");
  git(main, "config", "user.email", "wt@test");
  git(main, "config", "user.name", "wt");
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("discover", () => {
  it("finds a single app's .env, .env.<suffix> and refs", async () => {
    commit({ ".gitignore": "/refs\n.env\n.env.*\n", "package.json": "{}" });
    write(main, ".env", "A=1\n");
    write(main, ".env.staging", "S=1\n");
    write(main, "refs/effect/README.md");
    expect(await discovered()).toStrictEqual([".env", ".env.staging", "refs"]);
  });

  it("finds an app's files at any depth in a monorepo", async () => {
    commit({
      ".gitignore": "refs/\n.env\n.env.*\nnode_modules/\n",
      "apps/x/package.json": "{}",
    });
    write(main, "apps/x/.env", "A=1\n");
    write(main, "apps/x/.env.staging", "S=1\n");
    write(main, "apps/x/refs/effect/README.md");
    write(main, "refs/alchemy/README.md");
    expect(await discovered()).toStrictEqual([
      "apps/x/.env",
      "apps/x/.env.staging",
      "apps/x/refs",
      "refs",
    ]);
  });

  it("skips a tracked .env.example", async () => {
    commit({
      ".gitignore": ".env\n.env.*\n!.env.example\n",
      ".env.example": "A=\n",
    });
    write(main, ".env", "A=1\n");
    expect(await discovered()).toStrictEqual([".env"]);
  });

  it("skips node_modules, a tracked file in it included", async () => {
    commit({
      "node_modules/pkg/package.json": "{}",
      "apps/x/package.json": "{}",
    });
    write(main, "node_modules/pkg/.env", "A=1\n");
    write(main, "apps/x/node_modules/pkg/.env", "A=1\n");
    write(main, "apps/x/node_modules/refs/index.js");
    expect(await discovered()).toStrictEqual([]);
  });

  it("skips a symlink", async () => {
    commit({ "package.json": "{}" });
    write(scratch, "elsewhere/.env", "A=1\n");
    fs.symlinkSync(
      path.join(scratch, "elsewhere/.env"),
      path.join(main, ".env"),
    );
    fs.symlinkSync(path.join(scratch, "elsewhere"), path.join(main, "refs"));
    expect(await discovered()).toStrictEqual([]);
  });
});

describe("share", () => {
  beforeEach(() => {
    commit({
      ".gitignore": "refs/\n.env\n.env.*\n",
      "apps/x/package.json": "{}",
    });
    write(main, ".env", "A=1\n");
    write(main, "apps/x/.env", "X=1\n");
    write(main, "apps/x/.env.staging", "S=1\n");
    write(main, "refs/effect/README.md");
  });

  const linkOf = (file: string) => {
    const at = path.join(worktree, file);
    return fs.lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink()
      ? fs.readlinkSync(at)
      : undefined;
  };

  const failure = <E>(exit: Exit.Exit<unknown, E>) =>
    Exit.isFailure(exit) ? Exit.findErrorOption(exit) : Option.none();

  it("links each share whose parent folder the worktree has", async () => {
    fs.mkdirSync(path.join(worktree, "apps/x"), { recursive: true });
    expect(Exit.isSuccess(await share())).toBe(true);
    for (const file of [".env", "apps/x/.env", "apps/x/.env.staging", "refs"])
      expect(linkOf(file)).toBe(path.join(main, file));
  });

  it("skips a share whose parent folder the worktree lacks", async () => {
    expect(Exit.isSuccess(await share())).toBe(true);
    expect(linkOf(".env")).toBe(path.join(main, ".env"));
    expect(fs.existsSync(path.join(worktree, "apps"))).toBe(false);
  });

  it("leaves the links alone on a second run", async () => {
    expect(Exit.isSuccess(await share())).toBe(true);
    expect(Exit.isSuccess(await share())).toBe(true);
    expect(linkOf(".env")).toBe(path.join(main, ".env"));
    write(main, ".env", "A=2\n");
    expect(fs.readFileSync(path.join(worktree, ".env"), "utf8")).toBe("A=2\n");
  });

  it("replaces a copied .env with the main checkout's content by a link", async () => {
    write(worktree, ".env", "A=1\n");
    expect(Exit.isSuccess(await share())).toBe(true);
    expect(linkOf(".env")).toBe(path.join(main, ".env"));
  });

  it("refuses a copied .env that differs, keeping it", async () => {
    write(worktree, ".env", "A=edited\n");
    expect(failure(await share())).toStrictEqual(
      Option.some(
        new Share.SharedPathError({
          path: path.join(worktree, ".env"),
          expected: path.join(main, ".env"),
        }),
      ),
    );
    expect(fs.readFileSync(path.join(worktree, ".env"), "utf8")).toBe(
      "A=edited\n",
    );
  });

  it("refuses a link that points elsewhere", async () => {
    fs.symlinkSync(path.join(scratch, "nowhere"), path.join(worktree, "refs"));
    expect(failure(await share())).toStrictEqual(
      Option.some(
        new Share.SharedPathError({
          path: path.join(worktree, "refs"),
          expected: path.join(main, "refs"),
        }),
      ),
    );
  });
});
