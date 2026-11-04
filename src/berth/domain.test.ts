import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  CheckoutPath,
  checkState,
  EMPTY_STATE,
  EnvName,
  type LeaseKey,
  Manifest,
  MachineName,
  type Policy,
  ProjectName,
  reconcile,
  StoreDomain,
  release,
  type State,
  sweep,
} from "./domain.ts";

const machine = MachineName.make("test-mbp");
const domainOf = (handle: string) =>
  StoreDomain.make(`${handle}.myshopify.com`);
const policy: Policy = {
  machine,
  stores: ["pool-01", "pool-00"].map(domainOf),
};
const now = DateTime.makeUnsafe("2026-11-01T09:00:00Z");
const keyOf = (checkout: string, env = "dev"): LeaseKey => ({
  machine,
  checkout: CheckoutPath.make(checkout),
  env: EnvName.make(env),
});

const acquire = (
  state: State,
  key: LeaseKey,
  options: {
    adopt?: string;
    config?: string;
    stores?: ReadonlyArray<StoreDomain>;
    now?: DateTime.Utc;
  } = {},
) =>
  reconcile(
    state,
    {
      key,
      project: ProjectName.make("demo"),
      spec: { store: { config: options.config ?? "shopify.app.toml" } },
      adopt: Option.map(Option.fromNullishOr(options.adopt), domainOf),
    },
    {
      policy: { ...policy, stores: options.stores ?? policy.stores },
      now: options.now ?? now,
    },
  );

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(effect);
const fails = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runSync(Effect.flip(effect));
const handleOf = (lease: { readonly store: { readonly domain: string } }) =>
  lease.store.domain.replace(".myshopify.com", "");

describe("Manifest", () => {
  it("reads an env's store and ignores a store pool and ports", () => {
    const manifest = Schema.decodeUnknownSync(Manifest)({
      project: "demo",
      envs: {
        dev: {
          ports: ["web"],
          store: { pool: "pool", config: "shopify.app.toml" },
        },
      },
    });
    expect(manifest.envs[EnvName.make("dev")]).toEqual({
      store: { config: "shopify.app.toml" },
    });
  });

  it("rejects an env without a store, saying berth leases only stores", () => {
    const result = Schema.decodeUnknownResult(Manifest)({
      project: "demo",
      envs: { dev: { ports: ["web"] } },
    });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result))
      expect(result.failure.message).toContain(
        "berth leases only Shopify dev stores",
      );
  });
});

describe("reconcile", () => {
  it("grants the first free store in stores.json order, once", () => {
    const a = run(acquire(EMPTY_STATE, keyOf("/a")));
    const again = run(acquire(a.state, keyOf("/a")));
    const b = run(acquire(a.state, keyOf("/a", "e2e")));
    expect(handleOf(a.lease)).toBe("pool-01");
    expect(again.state).toEqual(a.state);
    expect(handleOf(b.lease)).toBe("pool-00");
    expect(checkState(b.state)).toEqual(Option.none());
  });

  it("keeps the store and acquiredAt when the config changes", () => {
    const a = run(acquire(EMPTY_STATE, keyOf("/a")));
    const later = run(
      acquire(a.state, keyOf("/a"), {
        config: "shopify.app.e2e.toml",
        now: DateTime.makeUnsafe("2026-11-02T09:00:00Z"),
      }),
    );
    expect(later.lease).toEqual({
      ...a.lease,
      store: { ...a.lease.store, config: "shopify.app.e2e.toml" },
    });
  });

  it("fails naming the pool's size when every store is leased", () => {
    const a = run(acquire(EMPTY_STATE, keyOf("/a")));
    const b = run(acquire(a.state, keyOf("/b")));
    const error = fails(acquire(b.state, keyOf("/c")));
    expect([error._tag, error.message]).toEqual([
      "StorePoolExhaustedError",
      "all 2 stores in stores.json are leased",
    ]);
  });

  it("gives a released store to the next caller", () => {
    const a = run(acquire(EMPTY_STATE, keyOf("/a")));
    const b = run(acquire(release(a.state, [keyOf("/a")]), keyOf("/b")));
    expect(b.lease.store).toEqual(a.lease.store);
  });

  it("adopts a listed store and refuses a held or unlisted one", () => {
    const a = run(acquire(EMPTY_STATE, keyOf("/a"), { adopt: "pool-00" }));
    expect(handleOf(a.lease)).toBe("pool-00");
    const reasonOf = (handle: string) => {
      const error = fails(acquire(a.state, keyOf("/b"), { adopt: handle }));
      return error._tag === "AdoptRefusedError" ? error.reason : error._tag;
    };
    expect(reasonOf("pool-00")).toBe("held");
    expect(reasonOf("mw10013-staging-shop-00")).toBe("not-in-pool");
  });

  it("moves off a store that stores.json no longer lists", () => {
    const a = run(acquire(EMPTY_STATE, keyOf("/a")));
    const delisted = run(
      acquire(a.state, keyOf("/a"), { stores: [domainOf("pool-00")] }),
    );
    expect(handleOf(delisted.lease)).toBe("pool-00");
  });
});

describe("sweep and release", () => {
  it("ends only this machine's leases whose checkout is gone", () => {
    const a = run(acquire(EMPTY_STATE, keyOf("/a")));
    const b = run(acquire(a.state, keyOf("/b")));
    const elsewhere: State = {
      leases: [
        ...b.state.leases,
        {
          ...a.lease,
          key: { ...a.lease.key, machine: MachineName.make("other") },
          store: { ...a.lease.store, domain: domainOf("pool-09") },
        },
      ],
    };
    const swept = sweep(elsewhere, machine, new Set([CheckoutPath.make("/a")]));
    expect(
      swept.leases.map((lease) => [lease.key.machine, lease.key.checkout]),
    ).toEqual([
      [machine, "/b"],
      ["other", "/a"],
    ]);
  });

  it("ignores the release of an absent lease", () => {
    const a = run(acquire(EMPTY_STATE, keyOf("/a")));
    expect(release(a.state, [keyOf("/a"), keyOf("/gone")]).leases).toEqual([]);
  });
});

describe("checkState", () => {
  it("rejects a key or a store held twice", () => {
    const a = run(acquire(EMPTY_STATE, keyOf("/a")));
    const storeTwice: State = {
      leases: [...a.state.leases, { ...a.lease, key: keyOf("/b") }],
    };
    const keyTwice: State = {
      leases: [
        ...a.state.leases,
        { ...a.lease, store: { ...a.lease.store, domain: domainOf("x") } },
      ],
    };
    expect(Option.isSome(checkState(storeTwice))).toBe(true);
    expect(Option.isSome(checkState(keyTwice))).toBe(true);
    expect(checkState(a.state)).toEqual(Option.none());
  });
});
