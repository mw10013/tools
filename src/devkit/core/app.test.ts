import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { app, NoAppError } from "./app.ts";

const scratch = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "devkit-app-")),
);
afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

const manifest = (directory: string, name: string) => {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name }),
  );
};

/** A monorepo: the root and `apps/web` have manifests, `apps/web/src/deep` and `docs` do not. */
const repository = path.join(scratch, "repository");
fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
manifest(repository, "monorepo");
manifest(path.join(repository, "apps/web"), "web");
fs.mkdirSync(path.join(repository, "apps/web/src/deep"), { recursive: true });
fs.mkdirSync(path.join(repository, "docs"), { recursive: true });

describe("app", () => {
  it("is the directory's own package.json", () => {
    expect(app(path.join(repository, "apps/web"))).toEqual({
      root: path.join(repository, "apps/web"),
      name: "web",
    });
  });

  it("walks up to the nearest package.json", () => {
    expect(app(path.join(repository, "apps/web/src/deep"))).toEqual({
      root: path.join(repository, "apps/web"),
      name: "web",
    });
    expect(app(path.join(repository, "docs"))).toEqual({
      root: repository,
      name: "monorepo",
    });
  });

  it("defaults to the working directory", () => {
    expect(app().root).toBe(app(process.cwd()).root);
  });

  it("stops at the repository's top level: a manifest above it is another project's", () => {
    manifest(path.join(scratch, "outer"), "outer");
    const inner = path.join(scratch, "outer/inner");
    fs.mkdirSync(path.join(inner, ".git"), { recursive: true });
    fs.mkdirSync(path.join(inner, "src"), { recursive: true });
    expect(() => app(path.join(inner, "src"))).toThrow(NoAppError);
  });

  it("stops at a worktree's `.git` file", () => {
    const worktree = path.join(scratch, "worktrees/task");
    fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktree, ".git"), "gitdir: elsewhere\n");
    manifest(path.join(scratch, "worktrees"), "above");
    expect(() => app(path.join(worktree, "src"))).toThrow(NoAppError);
    manifest(worktree, "task");
    expect(app(path.join(worktree, "src")).name).toBe("task");
  });

  it("fails with a NoAppError outside any repository", () => {
    const outside = path.join(scratch, "nowhere/at/all");
    fs.mkdirSync(outside, { recursive: true });
    const error = (() => {
      try {
        app(outside);
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(NoAppError);
    expect((error as NoAppError).message).toContain(outside);
  });
});
