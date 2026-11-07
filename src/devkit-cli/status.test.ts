import * as fs from "node:fs";
import * as path from "node:path";

import * as Option from "effect/Option";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  failureTag,
  publishedTags,
  runEffect,
  scratch,
  value,
  write,
} from "./fixture.ts";
import { checkPin, latestOn, rowOf, scan } from "./status.ts";

const PINNED = "github:mw10013/tools#devkit-v0.1.0";

let root: string;
let remote: string;

const manifest = (spec: string, field = "devDependencies") =>
  `${JSON.stringify({ name: "app", [field]: { "@mw10013/devkit": spec } }, null, 2)}\n`;

const lockfile = (version: string, importer = ".") => `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  ${importer}:
    devDependencies:
      '@mw10013/devkit':
        specifier: ${PINNED}
        version: https://codeload.github.com/mw10013/tools/tar.gz/0123456789abcdef0123456789abcdef01234567

packages:

  '@mw10013/devkit@https://codeload.github.com/mw10013/tools/tar.gz/0123456789abcdef0123456789abcdef01234567':
    resolution: {integrity: sha512-AAAA, tarball: https://codeload.github.com/mw10013/tools/tar.gz/0123456789abcdef0123456789abcdef01234567}
    version: ${version}

snapshots:

  '@mw10013/devkit@https://codeload.github.com/mw10013/tools/tar.gz/0123456789abcdef0123456789abcdef01234567': {}
`;

const row = async (directory: string, remoteUrl = remote) => {
  const latest = value(await runEffect(latestOn(directory, remoteUrl)));
  return value(await runEffect(rowOf(directory, latest)));
};

beforeEach(() => {
  root = scratch();
  remote = publishedTags(root, {
    "0.1.0": "devkit 0.1.0",
    "0.2.0": "devkit 0.2.0",
  });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("status of one app", () => {
  it("reads a package dependency, its lockfile version and the latest release", async () => {
    const app = path.join(root, "app");
    write(app, "package.json", manifest(PINNED));
    write(app, "pnpm-lock.yaml", lockfile("0.1.0"));

    expect(await row(app)).toMatchObject({
      state: "behind",
      spec: PINNED,
      declaredIn: `${path.join(app, "package.json")}#devDependencies`,
      declared: "0.1.0",
      locked: "0.1.0",
      latest: "0.2.0",
      unpinned: null,
      legacy: null,
    });
  });

  it("is current at the latest release", async () => {
    const app = path.join(root, "app");
    write(
      app,
      "package.json",
      manifest("github:mw10013/tools#devkit-v0.2.0", "dependencies"),
    );

    expect(await row(app)).toMatchObject({
      state: "current",
      declared: "0.2.0",
      locked: null,
      declaredIn: `${path.join(app, "package.json")}#dependencies`,
    });
  });

  it("reads a spec a workspace catalog holds, for the root and an app alike", async () => {
    const mono = path.join(root, "mono");
    write(
      mono,
      "pnpm-workspace.yaml",
      `packages:\n  - apps/*\ncatalog:\n  effect: 4.1.2\n  "@mw10013/devkit": ${PINNED}\n`,
    );
    write(mono, "package.json", manifest("catalog:"));
    write(
      mono,
      "apps/testbed/package.json",
      manifest("catalog:", "dependencies"),
    );
    write(mono, "pnpm-lock.yaml", lockfile("0.1.0", "apps/testbed"));
    fs.mkdirSync(path.join(mono, ".git"));

    const expected = {
      state: "behind",
      spec: PINNED,
      declaredIn: `${path.join(mono, "pnpm-workspace.yaml")}#catalog`,
      declared: "0.1.0",
    };
    expect(await row(mono)).toMatchObject(expected);
    expect(await row(path.join(mono, "apps/testbed"))).toMatchObject({
      ...expected,
      locked: "0.1.0",
    });
  });

  it("reads a named catalog", async () => {
    const mono = path.join(root, "mono");
    write(
      mono,
      "pnpm-workspace.yaml",
      `catalogs:\n  tools:\n    "@mw10013/devkit": ${PINNED}\n`,
    );
    write(mono, "package.json", manifest("catalog:tools"));
    fs.mkdirSync(path.join(mono, ".git"));

    expect(await row(mono)).toMatchObject({
      spec: PINNED,
      declaredIn: `${path.join(mono, "pnpm-workspace.yaml")}#catalogs.tools`,
    });
  });

  it.each([
    ["file:../tools/dist/devkit", "file"],
    ["link:../tools/src/devkit", "link"],
    ["github:mw10013/tools#main", "branch"],
    ["github:mw10013/tools#4b75272", "sha"],
    ["github:mw10013/tools#devkit-v0.3.0-rc.1", "prerelease"],
  ])("flags %s as unpinned", async (spec, kind) => {
    const app = path.join(root, "app");
    write(app, "package.json", manifest(spec));

    expect(await row(app)).toMatchObject({
      state: "unpinned",
      unpinned: kind,
      declared: null,
      spec,
    });
  });

  it("reports a legacy vendor stamp with its tools sha", async () => {
    const app = path.join(root, "app");
    write(app, "package.json", "{}\n");
    write(
      app,
      "vendor/devkit/devkit.json",
      JSON.stringify({ devkit: 1, tools: "ee36b2c", layer: "core", files: {} }),
    );

    expect(await row(app)).toMatchObject({
      state: "legacy",
      legacy: "ee36b2c",
      spec: null,
    });
  });

  it("is none for a directory that neither declares nor vendors devkit", async () => {
    const app = path.join(root, "app");
    write(app, "package.json", "{}\n");

    expect(await row(app)).toMatchObject({ state: "none", spec: null });
  });

  it("reports the latest as unknown offline", async () => {
    const app = path.join(root, "app");
    write(app, "package.json", manifest(PINNED));

    expect(await row(app, path.join(root, "nowhere.git"))).toMatchObject({
      state: "unknown",
      declared: "0.1.0",
      latest: "unknown",
    });
    expect(
      Option.isNone(
        value(await runEffect(latestOn(root, path.join(root, "nowhere.git")))),
      ),
    ).toBe(true);
  });
});

describe("status of a projects directory", () => {
  it("lists each repository root and workspace package that consumes devkit, one row each", async () => {
    const projects = path.join(root, "projects");
    write(
      projects,
      "baton/package.json",
      manifest("github:mw10013/tools#devkit-v0.2.0"),
    );
    write(projects, "old/package.json", "{}\n");
    write(
      projects,
      "old/vendor/devkit/devkit.json",
      JSON.stringify({ tools: "abc1234" }),
    );
    write(
      projects,
      "mono/pnpm-workspace.yaml",
      `packages:\n  - apps/*\ncatalog:\n  "@mw10013/devkit": ${PINNED}\n`,
    );
    write(projects, "mono/package.json", manifest("catalog:"));
    write(projects, "mono/apps/testbed/package.json", manifest("catalog:"));
    write(projects, "mono/apps/other/package.json", "{}\n");
    write(
      projects,
      "trial/package.json",
      manifest("link:../../tools/src/devkit"),
    );
    write(projects, "plain/package.json", "{}\n");
    write(projects, "self/pnpm-workspace.yaml", "packages:\n  - .\n");
    write(projects, "self/package.json", manifest(PINNED));
    write(projects, "node_modules/stray/package.json", manifest(PINNED));
    write(projects, "refs/effect/package.json", manifest(PINNED));
    write(projects, "notes.txt", "not a directory\n");

    const scanned = value(await runEffect(scan(projects, remote)));

    expect(scanned.latest).toBe("0.2.0");
    expect(scanned.rows.map(({ path: at, state }) => [at, state])).toEqual([
      ["baton", "current"],
      ["mono", "behind"],
      ["mono/apps/testbed", "behind"],
      ["old", "legacy"],
      ["self", "behind"],
      ["trial", "unpinned"],
    ]);
  });

  it("reports a repository whose manifest cannot be read, and carries on", async () => {
    const projects = path.join(root, "projects");
    write(projects, "broken/package.json", "{ not json\n");
    write(projects, "baton/package.json", manifest(PINNED));

    const { rows } = value(await runEffect(scan(projects, remote)));

    expect(rows.map(({ path: at, state }) => [at, state])).toEqual([
      ["baton", "behind"],
      ["broken", "unreadable"],
    ]);
  });
});

describe("check-pin", () => {
  const check = (directory: string) => runEffect(checkPin(directory));

  it("passes a pinned spec, a catalog entry and a workspace of both", async () => {
    const app = path.join(root, "app");
    write(app, "package.json", manifest(PINNED));
    expect(value(await check(app)).pinned).toEqual([
      { path: app, spec: PINNED, version: "0.1.0" },
    ]);

    const mono = path.join(root, "mono");
    write(
      mono,
      "pnpm-workspace.yaml",
      `packages:\n  - apps/*\ncatalog:\n  "@mw10013/devkit": ${PINNED}\n`,
    );
    write(mono, "package.json", manifest("catalog:"));
    write(mono, "apps/testbed/package.json", manifest("catalog:"));
    fs.mkdirSync(path.join(mono, ".git"));
    expect(value(await check(mono)).pinned.map((found) => found.path)).toEqual([
      mono,
      path.join(mono, "apps/testbed"),
    ]);
  });

  it.each([
    "file:../tools/dist/devkit",
    "link:../tools/src/devkit",
    "github:mw10013/tools#main",
    "github:mw10013/tools#4b752728e1c0f3e4f2e3a7a0a4d0f2b1c3d4e5f6",
    "github:mw10013/tools#devkit-v0.3.0-rc.1",
  ])("fails %s", async (spec) => {
    const app = path.join(root, "app");
    write(app, "package.json", manifest(spec));
    expect(failureTag(await check(app))).toBe("UnpinnedDevkitError");
  });

  it("fails a workspace package that pins a trial while the root is pinned", async () => {
    const mono = path.join(root, "mono");
    write(mono, "pnpm-workspace.yaml", "packages:\n  - apps/*\n");
    write(mono, "package.json", manifest(PINNED));
    write(
      mono,
      "apps/testbed/package.json",
      manifest("link:../../../tools/src/devkit"),
    );
    expect(failureTag(await check(mono))).toBe("UnpinnedDevkitError");
  });

  it("fails a legacy stamp and a directory that declares nothing", async () => {
    const old = path.join(root, "old");
    write(old, "package.json", "{}\n");
    write(
      old,
      "vendor/devkit/devkit.json",
      JSON.stringify({ tools: "abc1234" }),
    );
    expect(failureTag(await check(old))).toBe("UnpinnedDevkitError");

    const plain = path.join(root, "plain");
    write(plain, "package.json", "{}\n");
    expect(failureTag(await check(plain))).toBe("NoDevkitError");
  });
});
