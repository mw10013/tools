import { spawn } from "node:child_process";
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
  it("finds nothing in a worktree with no servers", async () => {
    write("package.json");
    write("src/index.ts", "");
    expect(await discover()).toStrictEqual([]);
  });

  it("stops a single-app root's recorded servers", async () => {
    write(".rigging/servers/dev/record.json");
    write(".rigging/servers/e2e/record.json");
    write(".rigging/servers/stale/log/current", "");
    expect(await discover()).toStrictEqual([
      { kind: "rigging-stop", dir: root, name: "dev" },
      { kind: "rigging-stop", dir: root, name: "e2e" },
    ]);
  });

  it("finds a monorepo app's servers in its own folder", async () => {
    const app = path.join(root, "apps", "x");
    write("package.json");
    write("apps/x/.rigging/servers/dev/record.json");
    write("apps/y/package.json");
    expect(await discover()).toStrictEqual([
      { kind: "rigging-stop", dir: app, name: "dev" },
    ]);
  });

  it("skips node_modules, .git and symlinked folders", async () => {
    write("node_modules/pkg/.rigging/servers/dev/record.json");
    write(".git/.rigging/servers/dev/record.json");
    const elsewhere = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "wt-teardown-link-")),
    );
    try {
      fs.mkdirSync(path.join(elsewhere, ".rigging/servers/dev"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(elsewhere, ".rigging/servers/dev/record.json"),
        "{}",
      );
      fs.symlinkSync(elsewhere, path.join(root, "refs"));
      expect(await discover()).toStrictEqual([]);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

const run = (actions: readonly Teardown.Teardown[]) =>
  Effect.runPromise(
    Teardown.run(actions, root).pipe(Effect.provide(NodeServices.layer)),
  );

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("Teardown.run on a rigging server", () => {
  it("runs the app's own rigging bin", async () => {
    const calls = path.join(root, "calls");
    write("node_modules/.bin/rigging", `#!/bin/sh\necho "$@" >> ${calls}\n`);
    fs.chmodSync(path.join(root, "node_modules/.bin/rigging"), 0o755);
    expect(
      await run([{ kind: "rigging-stop", dir: root, name: "dev" }]),
    ).toStrictEqual(["rigging server stop dev in ."]);
    expect(fs.readFileSync(calls, "utf8")).toBe("server stop dev\n");
  });

  it("stops the recorded process group when the app has no rigging bin", async () => {
    const server = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    const pid = server.pid ?? 0;
    write(
      ".rigging/servers/dev/record.json",
      JSON.stringify({ pid, group: pid }),
    );
    try {
      expect(
        await run([{ kind: "rigging-stop", dir: root, name: "dev" }]),
      ).toStrictEqual(["stopped dev from its record in ."]);
      expect(alive(pid)).toBe(false);
      expect(fs.existsSync(path.join(root, ".rigging/servers/dev"))).toBe(
        false,
      );
    } finally {
      if (alive(pid)) process.kill(-pid, "SIGKILL");
    }
  });
});
