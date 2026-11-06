import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ensure } from "./pool-ensure.ts";
import { resultText, ShopifyCli } from "./shopify.ts";

describe("resultText", () => {
  it("takes the last pretty-printed object after progress lines", () => {
    const stdout = [
      '{"event":"progress","status":"PENDING"}',
      "{",
      '  "store": { "domain": "shop-00.myshopify.com" }',
      "}",
      "",
    ].join("\n");
    expect(JSON.parse(resultText(stdout))).toEqual({
      store: { domain: "shop-00.myshopify.com" },
    });
  });
});

const directories: Array<string> = [];
const PATH = process.env.PATH;
afterEach(() => {
  process.env.PATH = PATH;
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

/**
 * Puts a `shopify` on PATH that runs `script` with the CLI's arguments, in a
 * directory that also holds a one-store `stores.json` and `files`.
 */
const stubShopify = (
  script: string,
  files: Readonly<Record<string, unknown>> = {},
) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "berth-shopify-"));
  directories.push(directory);
  const bin = path.join(directory, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "shopify"),
    `#!/bin/sh\ncd "${directory}"\n${script}\n`,
    { mode: 0o755 },
  );
  for (const [name, value] of Object.entries(files))
    fs.writeFileSync(path.join(directory, name), JSON.stringify(value));
  const file = path.join(directory, "stores.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ organization: "1", prefix: "shop-", stores: ["shop-00"] }),
  );
  process.env.PATH = `${bin}:${PATH ?? ""}`;
  return file;
};

const runEnsure = (file: string, count: number) =>
  Effect.runPromise(
    ensure(file, Option.some(count)).pipe(
      Effect.result,
      Effect.provide(Layer.provideMerge(ShopifyCli.layer, NodeServices.layer)),
    ),
  );

const store = (name: string, type: string, plan?: string) => ({
  store: `${name}.myshopify.com`,
  name,
  type,
  ...(plan === undefined ? {} : { plan }),
});

/** Like the real CLI, `--type dev` hides every other type. */
const FILTERING_LIST = `case "$*" in
  *"--type dev"*) cat dev.json ;;
  "store list"*) cat all.json ;;
  "store create"*) printf '{"store":{"domain":"%s.myshopify.com"}}\\n' "$5" ;;
esac`;

describe("ShopifyCli.layer", () => {
  it("sees a listed store of another type, so the run names its type", async () => {
    const file = stubShopify(FILTERING_LIST, {
      "all.json": { stores: [store("shop-00", "client-transfer")] },
      "dev.json": { stores: [] },
    });
    expect(await runEnsure(file, 0)).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "PoolStoresUnfitError",
        stores: [
          { store: "shop-00", reason: "type", found: "client-transfer" },
        ],
      },
    });
  });

  it("skips a pool name that a store of another type holds", async () => {
    const pooled = store("shop-00", "dev", "basic");
    const file = stubShopify(FILTERING_LIST, {
      "all.json": { stores: [pooled, store("shop-01", "client-transfer")] },
      "dev.json": { stores: [pooled] },
    });
    expect(await runEnsure(file, 2)).toMatchObject({
      _tag: "Success",
      success: { created: ["shop-02.myshopify.com"] },
    });
  });
});

describe("ShopifyCli.layer failures", () => {
  const cliError = (detail: string) => ({
    _tag: "Failure",
    failure: {
      _tag: "ShopifyCliError",
      detail: expect.stringContaining(detail),
    },
  });

  it("fails typed when shopify is not on PATH", async () => {
    const file = stubShopify("exit 0");
    process.env.PATH = path.dirname(file);
    expect(await runEnsure(file, 0)).toMatchObject(
      cliError("shopify is not on PATH"),
    );
  });

  it("fails typed when the store list does not decode", async () => {
    const file = stubShopify("echo not json");
    expect(await runEnsure(file, 0)).toMatchObject(
      cliError("berth cannot read its output"),
    );
  });

  it("fails typed when a create's output does not decode, saying the next run adopts the store", async () => {
    const file = stubShopify(
      `case "$*" in
  "store list"*) cat all.json ;;
  *) echo not json ;;
esac`,
      { "all.json": { stores: [store("shop-00", "dev", "basic")] } },
    );
    expect(await runEnsure(file, 2)).toMatchObject(
      cliError(
        "if it is at shop-01.myshopify.com, the next berth pool ensure adopts it",
      ),
    );
  });
});
