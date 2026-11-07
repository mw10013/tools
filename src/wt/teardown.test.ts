import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import * as Teardown from "./teardown.ts";

let root: string;

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "wt-teardown-")),
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const write = (relative: string, text = "{}") => {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

const discover = () =>
  Effect.runPromise(
    Teardown.discover(root).pipe(Effect.provide(NodeServices.layer)),
  );

describe("Teardown.discover", () => {
  it("finds nothing in a worktree with no servers and no berth.json", async () => {
    write("package.json");
    write("src/index.ts", "");
    expect(await discover()).toStrictEqual([]);
  });

  it("stops a single-app root's recorded servers, then releases its leases", async () => {
    write("berth.json");
    write(".bosun/dev/record.json");
    write(".bosun/e2e/record.json");
    write(".bosun/stale/log/current", "");
    expect(await discover()).toStrictEqual([
      { kind: "bosun-stop", dir: root, name: "dev" },
      { kind: "bosun-stop", dir: root, name: "e2e" },
      { kind: "berth-release", dir: root },
    ]);
  });

  it("finds a monorepo app's servers and berth.json in its own folder", async () => {
    const app = path.join(root, "apps", "x");
    write("package.json");
    write("apps/x/berth.json");
    write("apps/x/.bosun/dev/record.json");
    write("apps/y/package.json");
    expect(await discover()).toStrictEqual([
      { kind: "bosun-stop", dir: app, name: "dev" },
      { kind: "berth-release", dir: app },
    ]);
  });

  it("skips node_modules, .git and symlinked folders", async () => {
    write("node_modules/pkg/berth.json");
    write("node_modules/pkg/.bosun/dev/record.json");
    write(".git/berth.json");
    const elsewhere = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "wt-teardown-link-")),
    );
    try {
      fs.writeFileSync(path.join(elsewhere, "berth.json"), "{}");
      fs.symlinkSync(elsewhere, path.join(root, "refs"));
      expect(await discover()).toStrictEqual([]);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
