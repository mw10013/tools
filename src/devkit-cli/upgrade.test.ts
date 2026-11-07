import * as fs from "node:fs";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  commitAll,
  failureTag,
  git,
  initRepository,
  publishedTags,
  runEffect,
  scratch,
  value,
  write,
} from "./fixture.ts";
import { upgrade } from "./upgrade.ts";

const spec = (version: string) => `github:mw10013/tools#devkit-v${version}`;

let root: string;
let remote: string;
let installs: string[];

const upgradeTo = (directory: string, version?: string) =>
  runEffect(
    upgrade(
      directory,
      remote,
      Option.fromNullishOr(version),
      Effect.sync(() => {
        installs.push(
          fs.readFileSync(path.join(directory, "package.json"), "utf8"),
        );
      }),
    ),
  );

const read = (directory: string, file: string) =>
  fs.readFileSync(path.join(directory, file), "utf8");

beforeEach(() => {
  root = scratch();
  installs = [];
  remote = publishedTags(root, {
    "0.1.0": "devkit 0.1.0\n\nFirst release.",
    "0.2.0": "devkit 0.2.0\n\n- abc1234 rename the stage bin",
    "0.3.0": "devkit 0.3.0\n\n- def5678 app() takes a directory",
  });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("upgrade", () => {
  it("edits the workspace catalog, keeping its comments and quotes, and prints the release log", async () => {
    const mono = path.join(root, "mono");
    initRepository(mono);
    write(
      mono,
      "pnpm-workspace.yaml",
      `packages:\n  - apps/*\n# the shared tooling\ncatalog:\n  effect: 4.1.2\n  "@mw10013/devkit": "${spec("0.1.0")}" # pinned\n  vite: 1.4.0\n`,
    );
    write(
      mono,
      "package.json",
      `{\n  "name": "mono",\n  "devDependencies": { "@mw10013/devkit": "catalog:" }\n}\n`,
    );
    write(
      mono,
      "apps/testbed/package.json",
      `{\n  "name": "testbed",\n  "dependencies": { "@mw10013/devkit": "catalog:" }\n}\n`,
    );
    commitAll(mono, "initial");

    const upgraded = value(await upgradeTo(path.join(mono, "apps/testbed")));

    expect(read(mono, "pnpm-workspace.yaml")).toBe(
      `packages:\n  - apps/*\n# the shared tooling\ncatalog:\n  effect: 4.1.2\n  "@mw10013/devkit": "${spec("0.3.0")}" # pinned\n  vite: 1.4.0\n`,
    );
    expect(git(mono, "diff", "--name-only")).toBe("pnpm-workspace.yaml");
    expect(read(mono, "apps/testbed/package.json")).toContain('"catalog:"');
    expect(installs).toHaveLength(1);
    expect(upgraded).toMatchObject({
      from: "0.1.0",
      to: "0.3.0",
      previousSpec: spec("0.1.0"),
      spec: spec("0.3.0"),
      declaredIn: `${path.join(mono, "pnpm-workspace.yaml")}#catalog`,
    });
    expect(upgraded.log.map((entry) => entry.tag)).toEqual([
      "devkit-v0.3.0",
      "devkit-v0.2.0",
    ]);
    expect(upgraded.log[1]?.message).toContain("rename the stage bin");
  });

  it("edits an app's package.json when no catalog holds the spec, to the version asked for", async () => {
    const app = path.join(root, "app");
    initRepository(app);
    write(
      app,
      "package.json",
      `{\n  "name": "app",\n  "scripts": { "check": "vp check" },\n  "devDependencies": {\n    "@mw10013/devkit": "${spec("0.1.0")}",\n    "effect": "4.1.2"\n  }\n}\n`,
    );
    commitAll(app, "initial");

    const upgraded = value(await upgradeTo(app, "0.2.0"));

    expect(read(app, "package.json")).toBe(
      `{\n  "name": "app",\n  "scripts": { "check": "vp check" },\n  "devDependencies": {\n    "@mw10013/devkit": "${spec("0.2.0")}",\n    "effect": "4.1.2"\n  }\n}\n`,
    );
    expect(installs[0]).toContain(spec("0.2.0"));
    expect(upgraded.log.map((entry) => entry.tag)).toEqual(["devkit-v0.2.0"]);
  });

  it("moves a trial spec to a release and logs only that release", async () => {
    const app = path.join(root, "app");
    initRepository(app);
    write(
      app,
      "package.json",
      `{\n  "devDependencies": { "@mw10013/devkit": "link:../tools/src/devkit" }\n}\n`,
    );
    commitAll(app, "initial");

    const upgraded = value(await upgradeTo(app));

    expect(upgraded).toMatchObject({ from: null, to: "0.3.0" });
    expect(upgraded.log.map((entry) => entry.tag)).toEqual(["devkit-v0.3.0"]);
    expect(read(app, "package.json")).toContain(spec("0.3.0"));
  });

  it("refuses a dirty tree, an unpublished version and an app that does not use devkit, changing nothing", async () => {
    const app = path.join(root, "app");
    initRepository(app);
    const original = `{\n  "devDependencies": { "@mw10013/devkit": "${spec("0.1.0")}" }\n}\n`;
    write(app, "package.json", original);
    commitAll(app, "initial");

    expect(failureTag(await upgradeTo(app, "0.9.0"))).toBe(
      "UnknownReleaseError",
    );
    expect(failureTag(await upgradeTo(app, "0.2.0-rc.1"))).toBe(
      "UnknownReleaseError",
    );

    write(app, "notes.txt", "dirty\n");
    expect(failureTag(await upgradeTo(app))).toBe("DirtyCheckoutError");
    fs.rmSync(path.join(app, "notes.txt"));
    expect(read(app, "package.json")).toBe(original);

    const plain = path.join(root, "plain");
    initRepository(plain);
    write(plain, "package.json", "{}\n");
    commitAll(plain, "initial");
    expect(failureTag(await upgradeTo(plain))).toBe("NotAConsumerError");
    expect(installs).toEqual([]);
  });

  it("refuses to guess when the file names devkit on more than one line", async () => {
    const app = path.join(root, "app");
    initRepository(app);
    write(
      app,
      "package.json",
      `{\n  "dependencies": {\n    "@mw10013/devkit": "${spec("0.1.0")}"\n  },\n  "devDependencies": {\n    "@mw10013/devkit": "${spec("0.1.0")}"\n  }\n}\n`,
    );
    commitAll(app, "initial");

    expect(failureTag(await upgradeTo(app))).toBe("SpecEditError");
    expect(git(app, "status", "--porcelain")).toBe("");
  });
});
