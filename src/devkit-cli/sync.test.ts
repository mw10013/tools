import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import * as Devkit from "./sync.ts";

let scratch: string;
let tools: string;
let app: string;

const git = (directory: string, ...args: Array<string>) =>
  execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();

const write = (root: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};

const commit = () => {
  git(tools, "add", "-A");
  git(tools, "commit", "--quiet", "-m", "change");
};

const runEffect = <A, E>(
  effect: Effect.Effect<A, E, NodeServices.NodeServices>,
) => Effect.runPromiseExit(effect.pipe(Effect.provide(NodeServices.layer)));

const sync = (layer?: Devkit.Layer) =>
  runEffect(Devkit.sync(tools, app, Option.fromNullishOr(layer)));

const value = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isFailure(exit)) throw new Error(String(exit.cause));
  return exit.value;
};

const failureTag = (exit: Exit.Exit<unknown, { readonly _tag: string }>) =>
  Exit.isFailure(exit)
    ? Option.getOrUndefined(
        Option.map(Exit.findErrorOption(exit), (e) => e._tag),
      )
    : undefined;

const vendored = (file: string) =>
  fs.readFileSync(path.join(app, Devkit.VENDOR, file), "utf8");

beforeEach(() => {
  scratch = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "devkit-test-")),
  );
  tools = path.join(scratch, "tools");
  app = path.join(scratch, "app");
  fs.mkdirSync(tools);
  fs.mkdirSync(app);
  git(tools, "init", "--quiet");
  git(tools, "config", "user.email", "devkit@test");
  git(tools, "config", "user.name", "devkit");
  write(tools, "package.json", "{}\n");
  write(tools, "src/devkit/core/command.ts", "export const a = 1;\n");
  write(tools, "src/devkit/core/command.test.ts", "test\n");
  write(tools, "src/devkit/core/lint/rules.ts", "export const r = 1;\n");
  write(tools, "src/devkit/cloudflare/logs.ts", "export const l = 1;\n");
  write(tools, "src/devkit/shopify/store.ts", "export const s = 1;\n");
  commit();
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("devkit sync", () => {
  it("copies a layer's files at tools' HEAD, without tests or outer layers", async () => {
    const synced = value(await sync("core"));
    expect([...synced.added].sort()).toEqual([
      "core/command.ts",
      "core/lint/rules.ts",
    ]);
    expect(vendored("core/command.ts")).toBe("export const a = 1;\n");
    expect(fs.existsSync(path.join(app, Devkit.VENDOR, "cloudflare"))).toBe(
      false,
    );
    const stamp = JSON.parse(vendored("devkit.json"));
    expect(stamp.tools).toBe(git(tools, "rev-parse", "HEAD"));
    expect(stamp.layer).toBe("core");
  });

  it("includes inner layers in an outer one", async () => {
    const synced = value(await sync("shopify"));
    expect(synced.added).toHaveLength(4);
  });

  it("needs a layer the first time and reuses it after", async () => {
    expect(failureTag(await sync())).toBe("NoLayerError");
    value(await sync("cloudflare"));
    const again = value(await sync());
    expect(again.layer).toBe("cloudflare");
    expect(again.added).toEqual([]);
    expect(again.changed).toEqual([]);
  });

  it("ignores uncommitted changes in tools", async () => {
    write(tools, "src/devkit/core/command.ts", "export const a = 2;\n");
    value(await sync("core"));
    expect(vendored("core/command.ts")).toBe("export const a = 1;\n");
  });

  it("brings changes and removals, and status reports behind until then", async () => {
    value(await sync("core"));
    write(tools, "src/devkit/core/command.ts", "export const a = 2;\n");
    fs.rmSync(path.join(tools, "src/devkit/core/lint/rules.ts"));
    commit();
    expect(value(await runEffect(Devkit.status(tools, app))).behind).toBe(true);
    const synced = value(await sync());
    expect(synced.changed).toEqual(["core/command.ts"]);
    expect(synced.removed).toEqual(["core/lint/rules.ts"]);
    expect(vendored("core/command.ts")).toBe("export const a = 2;\n");
    expect(
      fs.existsSync(path.join(app, Devkit.VENDOR, "core/lint/rules.ts")),
    ).toBe(false);
    expect(value(await runEffect(Devkit.status(tools, app))).behind).toBe(
      false,
    );
  });

  it("stamps tools' Alchemy for a layer that imports it, and flags an app on another", async () => {
    write(
      tools,
      "package.json",
      JSON.stringify({ devDependencies: { alchemy: "2.0.0-beta.85" } }),
    );
    commit();
    value(await sync("core"));
    expect(JSON.parse(vendored("devkit.json")).alchemy).toBeUndefined();
    write(
      app,
      "node_modules/alchemy/package.json",
      JSON.stringify({ name: "alchemy", version: "2.0.0-beta.84" }),
    );
    const synced = value(await sync("cloudflare"));
    expect(JSON.parse(vendored("devkit.json")).alchemy).toBe("2.0.0-beta.85");
    expect(Option.getOrNull(synced.alchemyMismatch)).toEqual({
      devkit: "2.0.0-beta.85",
      app: "2.0.0-beta.84",
    });
    write(
      app,
      "node_modules/alchemy/package.json",
      JSON.stringify({ name: "alchemy", version: "2.0.0-beta.85" }),
    );
    expect(
      value(await runEffect(Devkit.status(tools, app))).alchemyMismatch,
    ).toEqual(Option.none());
  });

  it("refuses while a vendored file is edited, and status names it", async () => {
    value(await sync("core"));
    write(app, `${Devkit.VENDOR}/core/command.ts`, "export const a = 9;\n");
    expect(failureTag(await sync())).toBe("EditedVendorError");
    expect(value(await runEffect(Devkit.status(tools, app))).edited).toEqual([
      "core/command.ts",
    ]);
    expect(vendored("core/command.ts")).toBe("export const a = 9;\n");
  });
});
