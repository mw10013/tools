import * as fs from "node:fs";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  commitAll,
  failureTag,
  git,
  initRepository,
  runEffect,
  scratch,
  value,
  write,
} from "./fixture.ts";
import { release } from "./release.ts";

let root: string;
let origin: string;
let tools: string;
let output: string;
let verified: number;
let failVerify: boolean;

/** Stands in for `devkit build`: a manifest stamped with the version, a script and an executable bin. */
const build = (directory: string, version: string) =>
  Effect.sync(() => {
    write(
      directory,
      "package.json",
      JSON.stringify({ name: "@mw10013/devkit", version }),
    );
    write(
      directory,
      "dist/core/app.mjs",
      `export const output = "${output}";\n`,
    );
    write(directory, "dist/bin/stage.mjs", "#!/usr/bin/env vpx\n");
    fs.chmodSync(path.join(directory, "dist/bin/stage.mjs"), 0o755);
  });

const verify = Effect.suspend(() => {
  verified += 1;
  return failVerify
    ? Effect.fail({ _tag: "VerifyFailed", message: "checks failed" })
    : Effect.void;
});

const publish = (version: string, dryRun = false) =>
  runEffect(release(tools, version, { dryRun, verify, build }));

const tagsOf = (directory: string) =>
  git(directory, "tag", "--list", "devkit-v*").split("\n").filter(Boolean);

const mergeToMain = (message: string, file = "src/devkit/core/app.ts") => {
  write(tools, file, `export const changed = "${message}";\n`);
  commitAll(tools, message);
  git(tools, "push", "--quiet", "origin", "main");
};

beforeEach(() => {
  root = scratch();
  origin = path.join(root, "origin.git");
  tools = path.join(root, "tools");
  output = "first";
  verified = 0;
  failVerify = false;
  initRepository(origin, true);
  initRepository(tools);
  git(tools, "remote", "add", "origin", origin);
  write(tools, "LICENSE", "MIT License\n");
  write(tools, "package.json", "{}\n");
  write(tools, "src/devkit/core/app.ts", "export const app = 1;\n");
  write(tools, "src/devkit-cli/release.ts", "export const cli = 1;\n");
  commitAll(tools, "initial");
  git(tools, "push", "--quiet", "origin", "main");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("release", () => {
  it("writes an orphan commit and annotated tag holding only the package, and pushes only the tag", async () => {
    const source = git(tools, "rev-parse", "HEAD");
    const released = value(await publish("0.1.0"));

    expect(released.files).toEqual([
      "LICENSE",
      "README.md",
      "dist/bin/stage.mjs",
      "dist/core/app.mjs",
      "package.json",
    ]);
    expect(released).toMatchObject({
      tag: "devkit-v0.1.0",
      source,
      parent: null,
      existing: false,
      tagged: true,
      pushed: true,
    });
    expect(git(tools, "cat-file", "-t", "devkit-v0.1.0")).toBe("tag");
    expect(git(tools, "rev-parse", "devkit-v0.1.0^{commit}")).toBe(
      released.commit,
    );
    expect(git(tools, "rev-parse", "devkit-v0.1.0^{tree}")).toBe(released.tree);
    expect(git(tools, "log", "-1", "--format=%P", released.commit)).toBe("");
    expect(git(tools, "log", "-1", "--format=%B", released.commit)).toContain(
      `Source: ${source}`,
    );
    expect(
      git(tools, "ls-tree", "-r", "--name-only", released.tree).split("\n"),
    ).toEqual(released.files);
    expect(git(tools, "ls-tree", released.tree, "dist")).toContain("040000");
    expect(
      JSON.parse(git(tools, "show", "devkit-v0.1.0:package.json")),
    ).toEqual({
      name: "@mw10013/devkit",
      version: "0.1.0",
    });
    expect(git(tools, "show", "devkit-v0.1.0:LICENSE")).toBe("MIT License");
    expect(git(tools, "ls-tree", released.tree, "dist/bin/stage.mjs")).toMatch(
      /^100755 /u,
    );

    expect(tagsOf(origin)).toEqual(["devkit-v0.1.0"]);
    expect(git(origin, "rev-parse", "devkit-v0.1.0^{commit}")).toBe(
      released.commit,
    );
    expect(git(origin, "branch", "--contains", released.commit)).toBe("");
    expect(git(tools, "status", "--porcelain")).toBe("");
    expect(git(tools, "rev-parse", "HEAD")).toBe(source);
    expect(git(origin, "rev-parse", "main")).toBe(source);
  });

  it("parents each release on the previous one and lists the devkit commits it ships", async () => {
    const first = value(await publish("0.1.0"));
    mergeToMain("fix the stage bin");
    mergeToMain("touch only the cli", "src/devkit-cli/release.ts");
    output = "second";
    const second = value(await publish("0.1.1"));

    expect(second.parent).toBe(first.commit);
    expect(git(tools, "log", "-1", "--format=%P", second.commit)).toBe(
      first.commit,
    );
    const message = git(
      tools,
      "tag",
      "-l",
      "--format=%(contents)",
      "devkit-v0.1.1",
    );
    expect(message).toContain("devkit 0.1.1");
    expect(message).toContain("fix the stage bin");
    expect(message).not.toContain("touch only the cli");
  });

  it("succeeds again for the same version and tree, creating nothing", async () => {
    const first = value(await publish("0.1.0"));
    verified = 0;
    const again = value(await publish("0.1.0"));

    expect(again).toMatchObject({
      existing: true,
      commit: first.commit,
      tree: first.tree,
      tagged: false,
      pushed: false,
    });
    expect(verified).toBe(0);
    expect(tagsOf(tools)).toEqual(["devkit-v0.1.0"]);
    expect(tagsOf(origin)).toEqual(["devkit-v0.1.0"]);
  });

  it("pushes a tag that exists locally but not on origin", async () => {
    const first = value(await publish("0.1.0"));
    git(origin, "tag", "-d", "devkit-v0.1.0");

    const again = value(await publish("0.1.0"));

    expect(again).toMatchObject({
      existing: true,
      pushed: true,
      commit: first.commit,
    });
    expect(git(origin, "rev-parse", "devkit-v0.1.0^{commit}")).toBe(
      first.commit,
    );
  });

  it("fails, and never moves the tag, when the version exists with a different tree", async () => {
    const first = value(await publish("0.1.0"));
    mergeToMain("change the package");
    output = "changed";

    const exit = await publish("0.1.0");

    expect(failureTag(exit)).toBe("TagTreeMismatchError");
    expect(git(tools, "rev-parse", "devkit-v0.1.0^{commit}")).toBe(
      first.commit,
    );
    expect(git(origin, "rev-parse", "devkit-v0.1.0^{commit}")).toBe(
      first.commit,
    );
  });

  it("requires a version greater than the latest release", async () => {
    value(await publish("0.10.0"));
    for (const version of ["0.9.0", "0.2.0"])
      expect(failureTag(await publish(version)), version).toBe(
        "VersionNotGreaterError",
      );
    expect(tagsOf(origin)).toEqual(["devkit-v0.10.0"]);
    expect(value(await publish("0.10.1")).parent).not.toBeNull();
  });

  it("accepts only major.minor.patch", async () => {
    for (const version of ["v0.1.0", "0.1", "0.1.0-rc.1", "latest"])
      expect(failureTag(await publish(version)), version).toBe(
        "InvalidVersionError",
      );
    expect(tagsOf(origin)).toEqual([]);
  });

  it("refuses a dirty checkout", async () => {
    write(tools, "src/devkit/core/app.ts", "export const dirty = 1;\n");
    expect(failureTag(await publish("0.1.0"))).toBe("DirtyCheckoutError");
    git(tools, "checkout", "--", ".");
    write(tools, "untracked.txt", "x\n");
    expect(failureTag(await publish("0.1.0"))).toBe("DirtyCheckoutError");
    expect(tagsOf(origin)).toEqual([]);
  });

  it("refuses a HEAD that is not origin/main", async () => {
    write(tools, "src/devkit/core/app.ts", "export const local = 1;\n");
    commitAll(tools, "local only");
    expect(failureTag(await publish("0.1.0"))).toBe("NotAtOriginMainError");
    expect(tagsOf(origin)).toEqual([]);
  });

  it("creates nothing when the checks fail", async () => {
    failVerify = true;
    expect(failureTag(await publish("0.1.0"))).toBe("VerifyFailed");
    expect(tagsOf(tools)).toEqual([]);
    expect(tagsOf(origin)).toEqual([]);
  });

  it("builds the commit but creates no tag and pushes nothing on a dry run", async () => {
    const dry = value(await publish("0.1.0", true));

    expect(dry).toMatchObject({
      dryRun: true,
      tagged: false,
      pushed: false,
      existing: false,
    });
    expect(git(tools, "cat-file", "-t", dry.commit)).toBe("commit");
    expect(tagsOf(tools)).toEqual([]);
    expect(tagsOf(origin)).toEqual([]);
    expect(git(tools, "status", "--porcelain")).toBe("");

    const real = value(await publish("0.1.0"));
    expect(real.tree).toBe(dry.tree);
  });
});
