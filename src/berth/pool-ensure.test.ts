import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ensure, StoreDomainTakenError } from "./pool-ensure.ts";
import type { OrgStore } from "./pool.ts";
import { ShopifyCli } from "./shopify.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

const storesFile = (stores: readonly string[]) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "berth-pool-"));
  directories.push(directory);
  const file = path.join(directory, "stores.json");
  fs.writeFileSync(
    file,
    `${JSON.stringify({ organization: "1", prefix: "shop-", stores }, null, 2)}\n`,
  );
  return file;
};

const devStore = (name: string): OrgStore => ({
  domain: `${name}.myshopify.com`,
  name,
  type: "dev",
  plan: "basic",
});

/** A Shopify CLI over an in-memory org; `domains` overrides the domain a create returns. */
const fakeCli = (
  orgStores: OrgStore[],
  domains: Readonly<Record<string, string>> = {},
) =>
  Layer.succeed(ShopifyCli, {
    listStores: () => Effect.succeed([...orgStores]),
    createDevStore: (_, name) =>
      Effect.sync(() => {
        const domain = domains[name] ?? `${name}.myshopify.com`;
        orgStores.push({ ...devStore(name), domain });
        return domain;
      }),
  });

const run = (file: string, count: number, cli: ReturnType<typeof fakeCli>) =>
  Effect.runPromise(
    ensure(file, Option.some(count)).pipe(
      Effect.result,
      Effect.provide(Layer.merge(cli, NodeServices.layer)),
    ),
  );

const listed = (file: string): unknown =>
  (JSON.parse(fs.readFileSync(file, "utf8")) as { stores: unknown }).stores;

describe("ensure", () => {
  it("refuses a stores.json that lists a store twice and creates nothing", async () => {
    const file = storesFile(["shop-00", "shop-00"]);
    const orgStores = [devStore("shop-00")];
    const result = await run(file, 3, fakeCli(orgStores));
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SettingsInvalidError" },
    });
    expect(orgStores).toHaveLength(1);
  });

  it("writes each store it creates into stores.json", async () => {
    const file = storesFile(["shop-00"]);
    const result = await run(file, 3, fakeCli([devStore("shop-00")]));
    expect(result._tag).toBe("Success");
    expect(listed(file)).toEqual(["shop-00", "shop-01", "shop-02"]);
  });

  it("leaves a store with a suffixed domain out and keeps the ones made before it", async () => {
    const file = storesFile(["shop-00"]);
    const result = await run(
      file,
      3,
      fakeCli([devStore("shop-00")], {
        "shop-02": "shop-02-x7k2.myshopify.com",
      }),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { name: "shop-02", domain: "shop-02-x7k2.myshopify.com" },
    });
    if (result._tag === "Failure")
      expect(result.failure).toBeInstanceOf(StoreDomainTakenError);
    expect(listed(file)).toEqual(["shop-00", "shop-01"]);
  });

  it("does not rewrite stores.json when nothing changed", async () => {
    const file = storesFile(["shop-00"]);
    const before = fs.statSync(file).ino;
    await run(file, 1, fakeCli([devStore("shop-00")]));
    expect(fs.statSync(file).ino).toBe(before);
  });
});

/** A run paused inside `shopify store list`, holding the org as it was then. */
const pausedRun = (file: string, orgStores: readonly OrgStore[]) => {
  let listed!: () => void;
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => {
    listed = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const snapshot = [...orgStores];
  const result = Effect.runPromise(
    ensure(file, Option.none()).pipe(
      Effect.result,
      Effect.provide(
        Layer.merge(
          Layer.succeed(ShopifyCli, {
            listStores: () =>
              Effect.promise(async () => {
                listed();
                await gate;
                return snapshot;
              }),
            createDevStore: () => Effect.die("a check creates nothing"),
          }),
          NodeServices.layer,
        ),
      ),
    ),
  );
  return { paused, resume, result };
};

describe("ensure beside a concurrent run", () => {
  it("keeps a store that a parallel run created after this run loaded the file", async () => {
    const file = storesFile(["shop-00"]);
    const orgStores = [devStore("shop-00")];
    const check = pausedRun(file, orgStores);
    await check.paused;
    await run(file, 2, fakeCli(orgStores));
    check.resume();
    expect(await check.result).toMatchObject({
      _tag: "Success",
      success: {
        pool: { stores: ["shop-00.myshopify.com", "shop-01.myshopify.com"] },
      },
    });
    expect(listed(file)).toEqual(["shop-00", "shop-01"]);
  });

  it("fails typed when the file on disk names another organization", async () => {
    const file = storesFile(["shop-00"]);
    const check = pausedRun(file, [devStore("shop-00"), devStore("shop-01")]);
    await check.paused;
    fs.writeFileSync(
      file,
      JSON.stringify({ organization: "2", prefix: "shop-", stores: [] }),
    );
    check.resume();
    expect(await check.result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "PoolFileChangedError",
        organization: "1",
        foundOrganization: "2",
      },
    });
    expect(listed(file)).toEqual([]);
  });
});
