import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  type Adopt,
  CheckoutPath,
  checkState,
  EMPTY_STATE,
  EnvName,
  type LeaseKey,
  Manifest,
  MachineName,
  type Policy,
  Port,
  mergePool,
  pickStore,
  PoolName,
  ProjectName,
  reconcile,
  createArgs,
  createCommand,
  droppedStore,
  nextStoreName,
  siblingCheckouts,
  StoreDomain,
  release,
  Role,
  type State,
  sweep,
} from "./domain.ts";

const machine = MachineName.make("test-mbp");
const policy: Policy = {
  machine,
  ports: {
    first: Port.make(4000),
    last: Port.make(4005),
    reserved: new Set([Port.make(4001)]),
  },
  stores: {
    organizationId: "130059740",
    pools: new Map([
      [PoolName.make("dev"), /^mw10013-dev-shop-\d{2}$/u],
      [PoolName.make("e2e"), /^mw10013-e2e-shop-\d{2}$/u],
    ]),
  },
};
const now = DateTime.makeUnsafe("2026-11-01T09:00:00Z");
const keyOf = (checkout: string, env = "dev"): LeaseKey => ({
  machine,
  checkout: CheckoutPath.make(checkout),
  env: EnvName.make(env),
});
const web = Role.make("web");
const graphiql = Role.make("graphiql");
const api = Role.make("api");
const noAdopt: Adopt = { ports: new Map(), store: Option.none() };
const domainOf = (handle: string) =>
  StoreDomain.make(`${handle}.myshopify.com`);

const acquire = (
  state: State,
  key: LeaseKey,
  roles: ReadonlyArray<string>,
  options: {
    busy?: ReadonlyArray<number>;
    adopt?: Partial<Adopt>;
    store?: { pool: string; config?: string };
  } = {},
) =>
  reconcile(
    state,
    {
      key,
      project: ProjectName.make("demo"),
      spec: {
        ports: roles.map((role) => Role.make(role)),
        store:
          options.store === undefined
            ? undefined
            : {
                pool: PoolName.make(options.store.pool),
                config: options.store.config ?? "shopify.app.toml",
              },
      },
      adopt: { ...noAdopt, ...options.adopt },
    },
    {
      policy,
      now,
      isBindable: (port) =>
        Effect.succeed(!(options.busy ?? []).includes(port)),
    },
  );

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(effect);
const fails = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runSync(Effect.flip(effect));

describe("reconcile", () => {
  it("grants the lowest ports that are free, unreserved and bindable", () => {
    const { lease } = run(
      acquire(EMPTY_STATE, keyOf("/a"), ["web", "graphiql"], { busy: [4000] }),
    );
    expect(lease.ports).toEqual({ web: 4002, graphiql: 4003 });
  });

  it("returns an equal state for a lease that already matches", () => {
    const first = run(acquire(EMPTY_STATE, keyOf("/a"), ["web"]));
    const second = run(acquire(first.state, keyOf("/a"), ["web"]));
    expect(second.state).toEqual(first.state);
  });

  it("never grants a port another lease holds", () => {
    const a = run(acquire(EMPTY_STATE, keyOf("/a"), ["web"]));
    const b = run(acquire(a.state, keyOf("/b"), ["web"]));
    expect(b.lease.ports[web]).not.toBe(a.lease.ports[web]);
    expect(checkState(b.state, policy)).toEqual(Option.none());
  });

  it("keeps held ports when a role is added", () => {
    const one = run(acquire(EMPTY_STATE, keyOf("/a"), ["web"]));
    const two = run(acquire(one.state, keyOf("/a"), ["web", "graphiql"]));
    expect(two.lease.ports[web]).toBe(one.lease.ports[web]);
    expect(two.lease.ports[graphiql]).not.toBe(one.lease.ports[web]);
  });

  it("reads an env without ports as one that leases none", () => {
    const manifest = Schema.decodeUnknownSync(Manifest)({
      project: "demo",
      envs: { dev: { store: { pool: "dev", config: "shopify.app.toml" } } },
    });
    expect(manifest.envs[EnvName.make("dev")]?.ports).toEqual([]);
    const one = run(acquire(EMPTY_STATE, keyOf("/a"), ["web", "graphiql"]));
    const two = run(acquire(one.state, keyOf("/a"), []));
    expect(two.lease.ports).toEqual({});
    const other = run(acquire(two.state, keyOf("/b"), ["web"]));
    expect(other.lease.ports[web]).toBe(one.lease.ports[web]);
  });

  it("frees the port of a removed role", () => {
    const one = run(acquire(EMPTY_STATE, keyOf("/a"), ["web", "api"]));
    const two = run(acquire(one.state, keyOf("/a"), ["web"]));
    expect(two.lease.ports).toEqual({ web: one.lease.ports[web] });
    const other = run(acquire(two.state, keyOf("/b"), ["web"]));
    expect(other.lease.ports[web]).toBe(one.lease.ports[api]);
  });

  it("keeps a leased port even when it is busy now", () => {
    const one = run(acquire(EMPTY_STATE, keyOf("/a"), ["web"]));
    const two = run(
      acquire(one.state, keyOf("/a"), ["web"], {
        busy: [one.lease.ports[web]],
      }),
    );
    expect(two.lease.ports[web]).toBe(one.lease.ports[web]);
  });

  it("fails when every port is taken", () => {
    const error = fails(
      acquire(EMPTY_STATE, keyOf("/a"), ["a", "b", "c", "d", "e", "f"]),
    );
    expect(error._tag).toBe("PortsExhaustedError");
  });

  it("adopts an exact port and moves the role to it", () => {
    const one = run(acquire(EMPTY_STATE, keyOf("/a"), ["web", "graphiql"]));
    const adopt = { ports: new Map([[Role.make("web"), Port.make(13_900)]]) };
    const two = run(
      acquire(one.state, keyOf("/a"), ["web", "graphiql"], { adopt }),
    );
    expect(two.lease.ports).toEqual({
      web: 13_900,
      graphiql: one.lease.ports[graphiql],
    });
  });

  it("re-picks a role whose port another role adopts", () => {
    const one = run(acquire(EMPTY_STATE, keyOf("/a"), ["web", "graphiql"]));
    const adopt = {
      ports: new Map([[Role.make("graphiql"), one.lease.ports[web]]]),
    };
    const two = run(
      acquire(one.state, keyOf("/a"), ["web", "graphiql"], { adopt }),
    );
    expect(two.lease.ports[graphiql]).toBe(one.lease.ports[web]);
    expect(two.lease.ports[web]).not.toBe(one.lease.ports[web]);
    expect(checkState(two.state, policy)).toEqual(Option.none());
  });

  it("refuses to adopt a held, reserved or undeclared value", () => {
    const a = run(acquire(EMPTY_STATE, keyOf("/a"), ["web"]));
    const adoptOf = (role: string, port: number) => ({
      adopt: { ports: new Map([[Role.make(role), Port.make(port)]]) },
    });
    const reasons = [
      adoptOf("web", a.lease.ports[web]),
      adoptOf("web", 4001),
      adoptOf("api", 4500),
    ].map((options) => {
      const error = fails(acquire(a.state, keyOf("/b"), ["web"], options));
      return error._tag === "AdoptRefusedError" ? error.reason : error._tag;
    });
    expect(reasons).toEqual(["held", "reserved", "unknown-role"]);
  });
});

describe("sweep and release", () => {
  it("ends only this machine's leases whose checkout is gone", () => {
    const a = run(acquire(EMPTY_STATE, keyOf("/a"), ["web"]));
    const b = run(acquire(a.state, keyOf("/b"), ["web"]));
    const elsewhere: State = {
      ...b.state,
      leases: [
        ...b.state.leases,
        {
          ...a.lease,
          key: { ...a.lease.key, machine: MachineName.make("other") },
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

  it("frees a released lease's ports and ignores an absent one", () => {
    const a = run(acquire(EMPTY_STATE, keyOf("/a"), ["web"]));
    const released = release(a.state, [keyOf("/a"), keyOf("/gone")]);
    expect(released.leases).toEqual([]);
    const b = run(acquire(released, keyOf("/b"), ["web"]));
    expect(b.lease.ports[web]).toBe(a.lease.ports[web]);
  });
});

describe("checkState", () => {
  it("rejects a port held twice and a leased reserved port", () => {
    const a = run(acquire(EMPTY_STATE, keyOf("/a"), ["web"]));
    const twice: State = {
      ...a.state,
      leases: [...a.state.leases, { ...a.lease, key: keyOf("/b") }],
    };
    const reserved: State = {
      ...a.state,
      leases: [{ ...a.lease, ports: { [web]: Port.make(4001) } }],
    };
    expect(Option.isSome(checkState(twice, policy))).toBe(true);
    expect(Option.isSome(checkState(reserved, policy))).toBe(true);
    expect(checkState(a.state, policy)).toEqual(Option.none());
  });
});

const LISTED = [
  "mw10013-production-shop-00",
  "mw10013-staging-shop-00",
  "mw10013-dev-shop-01",
  "mw10013-dev-shop-00",
  "mw10013-e2e-shop-00",
  "sandbox-shop-00",
].map(domainOf);
const pooled = mergePool(EMPTY_STATE, LISTED, policy, now);
const devStore = { store: { pool: "dev" } };

describe("stores", () => {
  it("pools only stores whose handle matches a configured pool", () => {
    expect(pooled.pool.map((store) => store.domain)).toEqual(
      ["mw10013-dev-shop-00", "mw10013-dev-shop-01", "mw10013-e2e-shop-00"].map(
        domainOf,
      ),
    );
  });

  it("grants the lowest free store of the env's pool, once", () => {
    const a = run(acquire(pooled, keyOf("/a"), ["web"], devStore));
    const again = run(acquire(a.state, keyOf("/a"), ["web"], devStore));
    const b = run(acquire(a.state, keyOf("/b"), ["web"], devStore));
    const e2e = run(
      acquire(b.state, keyOf("/a", "e2e"), ["web"], { store: { pool: "e2e" } }),
    );
    expect(Option.map(a.lease.store, (store) => store.domain)).toEqual(
      Option.some(domainOf("mw10013-dev-shop-00")),
    );
    expect(again.state).toEqual(a.state);
    expect(Option.map(b.lease.store, (store) => store.domain)).toEqual(
      Option.some(domainOf("mw10013-dev-shop-01")),
    );
    expect(Option.map(e2e.lease.store, (store) => store.domain)).toEqual(
      Option.some(domainOf("mw10013-e2e-shop-00")),
    );
    expect(checkState(e2e.state, policy)).toEqual(Option.none());
  });

  it("gives a released key its last store back", () => {
    const a = run(acquire(pooled, keyOf("/a"), ["web"], devStore));
    const b = run(acquire(a.state, keyOf("/b"), ["web"], devStore));
    const freed = release(b.state, [keyOf("/a"), keyOf("/b")]);
    expect(pickStore(freed, keyOf("/b"), /^mw10013-dev-shop-\d{2}$/u)).toEqual(
      Option.some(domainOf("mw10013-dev-shop-01")),
    );
  });

  it("fails with NoFreeStoreError when the pool has no free store", () => {
    const a = run(acquire(pooled, keyOf("/a"), ["web"], devStore));
    const b = run(acquire(a.state, keyOf("/b"), ["web"], devStore));
    expect(fails(acquire(b.state, keyOf("/c"), ["web"], devStore))._tag).toBe(
      "NoFreeStoreError",
    );
    expect(
      fails(acquire(pooled, keyOf("/c"), ["web"], { store: { pool: "qa" } }))
        ._tag,
    ).toBe("UnknownPoolError");
  });

  it("adopts a pooled store and refuses a held or unpooled one", () => {
    const store = Option.some(domainOf("mw10013-dev-shop-01"));
    const a = run(
      acquire(pooled, keyOf("/a"), ["web"], { ...devStore, adopt: { store } }),
    );
    expect(Option.map(a.lease.store, (grant) => grant.domain)).toEqual(store);
    const reasonOf = (handle: string, state: State) => {
      const error = fails(
        acquire(state, keyOf("/b"), ["web"], {
          ...devStore,
          adopt: { store: Option.some(domainOf(handle)) },
        }),
      );
      return error._tag === "AdoptRefusedError" ? error.reason : error._tag;
    };
    expect(reasonOf("mw10013-dev-shop-01", a.state)).toBe("held");
    expect(reasonOf("mw10013-staging-shop-00", a.state)).toBe("not-in-pool");
    expect(reasonOf("mw10013-e2e-shop-00", a.state)).toBe("not-in-pool");
  });

  it("gives up the store when the spec drops it or changes pool", () => {
    const a = run(acquire(pooled, keyOf("/a"), ["web"], devStore));
    const dropped = run(acquire(a.state, keyOf("/a"), ["web"]));
    expect(dropped.lease.store).toEqual(Option.none());
    expect(dropped.released).toEqual(a.lease.store);
    const moved = run(
      acquire(a.state, keyOf("/a"), ["web"], { store: { pool: "e2e" } }),
    );
    expect(Option.map(moved.lease.store, (store) => store.domain)).toEqual(
      Option.some(domainOf("mw10013-e2e-shop-00")),
    );
    expect(moved.released).toEqual(a.lease.store);
  });

  it("keeps a held store that a sync no longer lists", () => {
    const a = run(acquire(pooled, keyOf("/a"), ["web"], devStore));
    const synced = mergePool(
      a.state,
      [domainOf("mw10013-dev-shop-01")],
      policy,
      now,
    );
    expect(synced.pool.map((store) => store.domain)).toEqual(
      ["mw10013-dev-shop-00", "mw10013-dev-shop-01"].map(domainOf),
    );
    expect(checkState(synced, policy)).toEqual(Option.none());
  });

  it("rejects a store held twice or held outside the pool", () => {
    const a = run(acquire(pooled, keyOf("/a"), ["web"], devStore));
    const twice: State = {
      ...a.state,
      leases: [...a.state.leases, { ...a.lease, key: keyOf("/b"), ports: {} }],
    };
    const unpooled: State = { ...a.state, pool: [] };
    expect(Option.isSome(checkState(twice, policy))).toBe(true);
    expect(Option.isSome(checkState(unpooled, policy))).toBe(true);
  });

  it("names the next store to create", () => {
    expect(nextStoreName(pooled, /^mw10013-dev-shop-\d{2}$/u)).toEqual(
      Option.some("mw10013-dev-shop-02"),
    );
    expect(nextStoreName(pooled, /^mw10013-qa-shop-\d{2}$/u)).toEqual(
      Option.some("mw10013-qa-shop-00"),
    );
    expect(nextStoreName(pooled, /^qa-/u)).toEqual(Option.none());
    expect(createArgs("mw10013-dev-shop-02", policy).join(" ")).toBe(
      "store create dev --name mw10013-dev-shop-02 --organization-id 130059740 --plan basic",
    );
    expect(createCommand(PoolName.make("dev"))).toBe("berth create-store dev");
  });

  it("names the store a lease gives up: dropped, another pool, or adopted", () => {
    const a = run(acquire(pooled, keyOf("/a"), ["web"], devStore));
    const current = Option.some(a.lease);
    const spec = (pool?: string) => ({
      ports: [web],
      store:
        pool === undefined
          ? undefined
          : { pool: PoolName.make(pool), config: "shopify.app.toml" },
    });
    expect(
      droppedStore(current, { spec: spec("dev"), adopt: noAdopt }),
    ).toEqual(Option.none());
    expect(droppedStore(current, { spec: spec(), adopt: noAdopt })).toEqual(
      a.lease.store,
    );
    expect(
      droppedStore(current, { spec: spec("e2e"), adopt: noAdopt }),
    ).toEqual(a.lease.store);
    expect(
      droppedStore(current, {
        spec: spec("dev"),
        adopt: {
          ...noAdopt,
          store: Option.some(domainOf("mw10013-dev-shop-01")),
        },
      }),
    ).toEqual(a.lease.store);
    expect(
      droppedStore(Option.none(), { spec: spec(), adopt: noAdopt }),
    ).toEqual(Option.none());
  });

  it("finds a gone lease's sibling checkouts of the same project", () => {
    const a = run(acquire(pooled, keyOf("/a"), ["web"], devStore));
    const b = run(acquire(a.state, keyOf("/b", "e2e"), ["web"]));
    const c = run(acquire(b.state, keyOf("/c"), ["web"]));
    const other: State = {
      ...c.state,
      leases: [
        ...c.state.leases,
        {
          ...c.lease,
          key: keyOf("/d"),
          project: ProjectName.make("other"),
          ports: {},
        },
      ],
    };
    expect(
      siblingCheckouts(other, a.lease, new Set([CheckoutPath.make("/c")])),
    ).toEqual(["/b"]);
  });
});
