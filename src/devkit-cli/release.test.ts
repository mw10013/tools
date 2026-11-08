import * as fs from "node:fs";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import * as CoreRelease from "#devkit/core/release.ts";

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

describe("core/release for another repository", () => {
  const SOURCE_PATH = "packages/lib";

  const publishLib = (
    version: string,
    overrides: Partial<
      CoreRelease.Options<{ readonly _tag: string }, never>
    > & {
      readonly dryRun?: boolean;
    } = {},
  ) =>
    runEffect(
      CoreRelease.release({
        repo: tools,
        version,
        dryRun: false,
        name: "lib",
        tagPrefix: "v",
        sourcePath: SOURCE_PATH,
        readme: (stamped) => `# lib ${stamped}\n`,
        verify,
        build: (directory, stamped) =>
          Effect.sync(() => {
            write(
              directory,
              "package.json",
              JSON.stringify({ version: stamped }),
            );
            write(
              directory,
              "dist/index.mjs",
              `export const output = "${output}";\n`,
            );
          }),
        ...overrides,
      }),
    );

  const vTags = (directory: string) =>
    git(directory, "tag", "--list", "v*").split("\n").filter(Boolean);

  const mergeLib = (message: string) => {
    write(
      tools,
      `${SOURCE_PATH}/index.ts`,
      `export const changed = "${message}";\n`,
    );
    commitAll(tools, message);
    git(tools, "push", "--quiet", "origin", "main");
  };

  beforeEach(() => {
    mergeLib("add the lib");
  });

  it("tags the first release v0.1.0 on an orphan commit holding only the build and its README", async () => {
    const source = git(tools, "rev-parse", "HEAD");
    const released = value(await publishLib("0.1.0"));

    expect(released).toMatchObject({
      tag: "v0.1.0",
      source,
      parent: null,
      existing: false,
      tagged: true,
      pushed: true,
    });
    expect(released.files).toEqual([
      "README.md",
      "dist/index.mjs",
      "package.json",
    ]);
    expect(git(tools, "cat-file", "-t", "v0.1.0")).toBe("tag");
    expect(git(tools, "show", "v0.1.0:README.md")).toBe("# lib 0.1.0");
    expect(git(tools, "log", "-1", "--format=%B", released.commit)).toBe(
      `lib 0.1.0\n\nSource: ${source}\n\nFirst release.`,
    );
    expect(vTags(origin)).toEqual(["v0.1.0"]);
    expect(tagsOf(origin)).toEqual([]);
    expect(git(tools, "status", "--porcelain")).toBe("");
  });

  it("lists the sourcePath commits since the previous release", async () => {
    const first = value(await publishLib("0.1.0"));
    mergeLib("fix the lib");
    mergeToMain("touch only devkit");
    output = "second";
    const second = value(await publishLib("0.2.0"));

    expect(second.parent).toBe(first.commit);
    const message = git(tools, "tag", "-l", "--format=%(contents)", "v0.2.0");
    expect(message).toContain(`Changes to ${SOURCE_PATH} since v0.1.0:`);
    expect(message).toContain("fix the lib");
    expect(message).not.toContain("touch only devkit");
  });

  it("succeeds again for the same version and tree, creating nothing", async () => {
    const first = value(await publishLib("0.1.0"));
    verified = 0;
    const again = value(await publishLib("0.1.0"));

    expect(again).toMatchObject({
      existing: true,
      commit: first.commit,
      tree: first.tree,
      tagged: false,
      pushed: false,
    });
    expect(verified).toBe(0);
    expect(vTags(origin)).toEqual(["v0.1.0"]);
  });

  it("refuses to move a tag whose tree differs", async () => {
    const first = value(await publishLib("0.1.0"));
    mergeLib("change the lib");
    output = "changed";

    expect(failureTag(await publishLib("0.1.0"))).toBe("TagTreeMismatchError");
    expect(git(tools, "rev-parse", "v0.1.0^{commit}")).toBe(first.commit);
    expect(git(origin, "rev-parse", "v0.1.0^{commit}")).toBe(first.commit);
  });

  it("keeps each prefix's releases apart", async () => {
    value(await publish("0.5.0"));
    const lib = value(await publishLib("0.1.0"));

    expect(lib.parent).toBeNull();
    expect(tagsOf(origin)).toEqual(["devkit-v0.5.0"]);
    expect(vTags(origin)).toEqual(["v0.1.0"]);
  });

  it("builds the commit but creates no tag and pushes nothing on a dry run", async () => {
    const dry = value(await publishLib("0.1.0", { dryRun: true }));

    expect(dry).toMatchObject({
      tag: "v0.1.0",
      dryRun: true,
      tagged: false,
      pushed: false,
      existing: false,
    });
    expect(git(tools, "cat-file", "-t", dry.commit)).toBe("commit");
    expect(vTags(tools)).toEqual([]);
    expect(vTags(origin)).toEqual([]);
    expect(value(await publishLib("0.1.0")).tree).toBe(dry.tree);
  });

  it("refuses a dirty checkout and a HEAD that is not origin/main", async () => {
    write(tools, `${SOURCE_PATH}/index.ts`, "export const dirty = 1;\n");
    expect(failureTag(await publishLib("0.1.0"))).toBe("DirtyCheckoutError");
    commitAll(tools, "local only");
    expect(failureTag(await publishLib("0.1.0"))).toBe("NotAtOriginMainError");
    expect(vTags(tools)).toEqual([]);
    expect(vTags(origin)).toEqual([]);
  });

  it("publishes nothing when verify edits a tracked file", async () => {
    const edits = Effect.sync(() => {
      write(tools, `${SOURCE_PATH}/index.ts`, "export const edited = 1;\n");
    });
    expect(failureTag(await publishLib("0.1.0", { verify: edits }))).toBe(
      "DirtyCheckoutError",
    );
    expect(vTags(tools)).toEqual([]);
    expect(vTags(origin)).toEqual([]);
  });

  it("publishes nothing when verify commits", async () => {
    const commits = Effect.sync(() => {
      write(tools, `${SOURCE_PATH}/index.ts`, "export const edited = 1;\n");
      commitAll(tools, "verify commits");
    });
    expect(failureTag(await publishLib("0.1.0", { verify: commits }))).toBe(
      "SourceMovedError",
    );
    expect(vTags(tools)).toEqual([]);
    expect(vTags(origin)).toEqual([]);
  });

  it("publishes nothing when the build edits a tracked file", async () => {
    const build = (directory: string) =>
      Effect.sync(() => {
        write(directory, "package.json", "{}");
        write(tools, `${SOURCE_PATH}/index.ts`, "export const built = 1;\n");
      });
    expect(failureTag(await publishLib("0.1.0", { build }))).toBe(
      "DirtyCheckoutError",
    );
    expect(vTags(tools)).toEqual([]);
    expect(vTags(origin)).toEqual([]);
  });

  it.each(["lightweight", "annotated"])(
    "refuses a %s v-tag on a main commit as the chain's parent",
    async (kind) => {
      git(
        tools,
        "tag",
        ...(kind === "annotated" ? ["-a", "-m", "old scheme"] : []),
        "v0.0.1",
      );
      git(tools, "push", "--quiet", "origin", "v0.0.1");

      const exit = await publishLib("0.1.0");

      expect(failureTag(exit)).toBe("NotReleaseTagError");
      expect(String(exit)).toContain("v0.0.1");
      expect(vTags(origin)).toEqual(["v0.0.1"]);
    },
  );

  it("releases a scoped package name", async () => {
    const released = value(
      await publishLib("0.1.0", { name: "@mw10013/shopify-app-workers" }),
    );
    expect(git(tools, "log", "-1", "--format=%s", released.commit)).toBe(
      "@mw10013/shopify-app-workers 0.1.0",
    );
    expect(
      value(await publishLib("0.1.0", { name: "@mw10013/shopify-app-workers" }))
        .existing,
    ).toBe(true);
  });

  it("refuses a sourcePath HEAD lacks and a repo below the top level", async () => {
    expect(
      failureTag(await publishLib("0.1.0", { sourcePath: "packages/missing" })),
    ).toBe("SourcePathNotFoundError");
    expect(
      failureTag(
        await publishLib("0.1.0", {
          repo: path.join(tools, SOURCE_PATH),
          sourcePath: "index.ts",
        }),
      ),
    ).toBe("NotRepositoryRootError");
    expect(vTags(origin)).toEqual([]);
  });

  it("pushes on the next run a tag whose push failed", async () => {
    const hook = path.join(origin, "hooks", "pre-receive");
    write(origin, "hooks/pre-receive", "#!/bin/sh\nexit 1\n");
    fs.chmodSync(hook, 0o755);
    expect(failureTag(await publishLib("0.1.0"))).toBe("CommandError");
    const local = git(tools, "rev-parse", "v0.1.0^{commit}");
    expect(vTags(origin)).toEqual([]);

    fs.rmSync(hook);
    const again = value(await publishLib("0.1.0"));

    expect(again).toMatchObject({
      existing: true,
      pushed: true,
      commit: local,
    });
    expect(git(origin, "rev-parse", "v0.1.0^{commit}")).toBe(local);
  });
});
