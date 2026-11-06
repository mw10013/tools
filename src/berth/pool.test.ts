import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { handleOf } from "./domain.ts";
import {
  domainOf,
  type OrgStore,
  planPool,
  PoolNamesExhaustedError,
  PoolPrefix,
  PoolStoresUnfitError,
} from "./pool.ts";

const prefix = PoolPrefix.make("shop-");
const devStore = (
  name: string,
  overrides: Partial<OrgStore> = {},
): OrgStore => ({
  domain: `${name}.myshopify.com`,
  name,
  type: "dev",
  plan: "basic",
  ...overrides,
});

const plan = (input: {
  listed: ReadonlyArray<string>;
  orgStores: ReadonlyArray<OrgStore>;
  count?: number;
}) =>
  planPool({
    listed: input.listed.map(domainOf),
    orgStores: input.orgStores,
    prefix,
    count: input.count ?? 0,
  });

const planned = (input: Parameters<typeof plan>[0]) => {
  const { adopt, create } = Effect.runSync(plan(input));
  return { adopt: adopt.map(handleOf), create };
};
const fails = (input: Parameters<typeof plan>[0]) =>
  Effect.runSync(Effect.flip(plan(input)));

describe("planPool", () => {
  it("does nothing when every listed store is a dev store on basic", () => {
    expect(
      planned({
        listed: ["shop-00", "shop-01"],
        orgStores: [
          devStore("shop-00"),
          devStore("shop-01"),
          devStore("other"),
        ],
      }),
    ).toEqual({ adopt: [], create: [] });
  });

  it("names every listed store that is missing or not dev on basic", () => {
    const error = fails({
      listed: ["shop-00", "shop-01", "shop-02", "shop-03"],
      orgStores: [
        devStore("shop-00"),
        devStore("shop-02", { plan: "advanced" }),
        devStore("shop-03", { type: "client-transfer" }),
      ],
      count: 9,
    });
    expect(error).toBeInstanceOf(PoolStoresUnfitError);
    expect(error).toMatchObject({
      stores: [
        { store: "shop-01", reason: "missing" },
        { store: "shop-02", reason: "plan", found: "advanced" },
        { store: "shop-03", reason: "type", found: "client-transfer" },
      ],
    });
  });

  it("finds a listed store by domain, whatever its name now is", () => {
    expect(
      planned({
        listed: ["shop-00"],
        orgStores: [devStore("shop-00", { name: "Renamed" })],
      }),
    ).toEqual({ adopt: [], create: [] });
  });

  it("adopts an unlisted pool store that is dev on basic, and nothing else", () => {
    expect(
      planned({
        listed: ["shop-00"],
        orgStores: [
          devStore("shop-00"),
          devStore("shop-03"),
          devStore("shop-01"),
          devStore("shop-02", { plan: "plus" }),
          devStore("shop-04", { domain: "shop-04-abc1.myshopify.com" }),
          devStore("shop-100"),
          devStore("other-05"),
        ],
      }),
    ).toEqual({ adopt: ["shop-01", "shop-03"], create: [] });
  });

  it("creates at the lowest free names, skipping names an org store uses", () => {
    expect(
      planned({
        listed: ["shop-00", "shop-02"],
        orgStores: [
          devStore("shop-00"),
          devStore("shop-02"),
          devStore("shop-01", { plan: "plus" }),
          devStore("shop-03", { domain: "shop-03-abc1.myshopify.com" }),
          devStore("Shop Four", {
            domain: "shop-04.myshopify.com",
            type: "production",
          }),
        ],
        count: 5,
      }),
    ).toEqual({ adopt: [], create: ["shop-05", "shop-06", "shop-07"] });
  });

  it("counts adoptions toward the count", () => {
    expect(
      planned({
        listed: ["shop-00"],
        orgStores: [devStore("shop-00"), devStore("shop-01")],
        count: 3,
      }),
    ).toEqual({ adopt: ["shop-01"], create: ["shop-02"] });
  });

  it("creates nothing when the count is at or below the pool's size", () => {
    const input = {
      listed: ["shop-00", "shop-01"],
      orgStores: [devStore("shop-00"), devStore("shop-01")],
    };
    expect(planned({ ...input, count: 2 })).toEqual({ adopt: [], create: [] });
    expect(planned({ ...input, count: 1 })).toEqual({ adopt: [], create: [] });
  });

  it("fails before creating anything when the names past 99 would be needed", () => {
    const names = Array.from(
      { length: 99 },
      (_, index) => `shop-${String(index).padStart(2, "0")}`,
    );
    const input = {
      listed: names,
      orgStores: names.map((name) => devStore(name)),
    };
    expect(planned({ ...input, count: 100 }).create).toEqual(["shop-99"]);
    expect(fails({ ...input, count: 101 })).toBeInstanceOf(
      PoolNamesExhaustedError,
    );
  });
});
