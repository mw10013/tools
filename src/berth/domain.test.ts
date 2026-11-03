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
  ProjectName,
  reconcile,
  StoreDomain,
  release,
  Role,
  type State,
  sweep,
} from "./domain.ts";

const machine = MachineName.make("test-mbp");
const domainOf = (handle: string) =>
  StoreDomain.make(`${handle}.myshopify.com`);
const policy: Policy = {
  machine,
  ports: {
    first: Port.make(4000),
    last: Port.make(4005),
    reserved: new Set([Port.make(4001)]),
  },
  stores: ["pool-01", "pool-00"].map(domainOf),
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

const acquire = (
  state: State,
  key: LeaseKey,
  roles: ReadonlyArray<string>,
  options: {
    busy?: ReadonlyArray<number>;
    adopt?: Partial<Adopt>;
    store?: { config?: string };
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
            : { config: options.store.config ?? "shopify.app.toml" },
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

  it("reads an env without ports as one that leases none, and ignores a store pool", () => {
    const manifest = Schema.decodeUnknownSync(Manifest)({
      project: "demo",
      envs: { dev: { store: { pool: "pool", config: "shopify.app.toml" } } },
    });
    expect(manifest.envs[EnvName.make("dev")]).toEqual({
      ports: [],
      store: { config: "shopify.app.toml" },
    });
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

const withStore = { store: {} };
const storeOf = (lease: {
  readonly store: Option.Option<{ readonly domain: StoreDomain }>;
}) => Option.map(lease.store, (store) => store.domain);

describe("stores", () => {
  it("grants the first free store in stores.json order, once", () => {
    const a = run(acquire(EMPTY_STATE, keyOf("/a"), ["web"], withStore));
    const again = run(acquire(a.state, keyOf("/a"), ["web"], withStore));
    const b = run(acquire(a.state, keyOf("/a", "e2e"), ["web"], withStore));
    expect(storeOf(a.lease)).toEqual(Option.some(domainOf("pool-01")));
    expect(again.state).toEqual(a.state);
    expect(storeOf(b.lease)).toEqual(Option.some(domainOf("pool-00")));
    expect(checkState(b.state, policy)).toEqual(Option.none());
  });

  it("fails naming the pool's size when every store is leased", () => {
    const a = run(acquire(EMPTY_STATE, keyOf("/a"), ["web"], withStore));
    const b = run(acquire(a.state, keyOf("/b"), ["web"], withStore));
    const error = fails(acquire(b.state, keyOf("/c"), ["web"], withStore));
    expect([error._tag, error.message]).toEqual([
      "StorePoolExhaustedError",
      "all 2 stores in stores.json are leased",
    ]);
  });

  it("gives a released store to the next caller", () => {
    const a = run(acquire(EMPTY_STATE, keyOf("/a"), ["web"], withStore));
    const b = run(
      acquire(release(a.state, [keyOf("/a")]), keyOf("/b"), ["web"], withStore),
    );
    expect(storeOf(b.lease)).toEqual(storeOf(a.lease));
  });

  it("adopts a listed store and refuses a held or unlisted one", () => {
    const store = Option.some(domainOf("pool-00"));
    const a = run(
      acquire(EMPTY_STATE, keyOf("/a"), ["web"], {
        ...withStore,
        adopt: { store },
      }),
    );
    expect(storeOf(a.lease)).toEqual(store);
    const reasonOf = (handle: string, spec: { store?: object } = withStore) => {
      const error = fails(
        acquire(a.state, keyOf("/b"), ["web"], {
          ...spec,
          adopt: { store: Option.some(domainOf(handle)) },
        }),
      );
      return error._tag === "AdoptRefusedError" ? error.reason : error._tag;
    };
    expect(reasonOf("pool-00")).toBe("held");
    expect(reasonOf("mw10013-staging-shop-00")).toBe("not-in-pool");
    expect(reasonOf("pool-01", {})).toBe("no-store");
  });

  it("gives up the store when the spec drops it or stores.json no longer lists it", () => {
    const a = run(acquire(EMPTY_STATE, keyOf("/a"), ["web"], withStore));
    const dropped = run(acquire(a.state, keyOf("/a"), ["web"]));
    expect(dropped.lease.store).toEqual(Option.none());
    const delisted = run(
      reconcile(
        a.state,
        {
          key: keyOf("/a"),
          project: ProjectName.make("demo"),
          spec: { ports: [web], store: { config: "shopify.app.toml" } },
          adopt: noAdopt,
        },
        {
          policy: { ...policy, stores: [domainOf("pool-00")] },
          now,
          isBindable: () => Effect.succeed(true),
        },
      ),
    );
    expect(storeOf(delisted.lease)).toEqual(Option.some(domainOf("pool-00")));
  });

  it("rejects a store held twice", () => {
    const a = run(acquire(EMPTY_STATE, keyOf("/a"), ["web"], withStore));
    const twice: State = {
      leases: [...a.state.leases, { ...a.lease, key: keyOf("/b"), ports: {} }],
    };
    expect(Option.isSome(checkState(twice, policy))).toBe(true);
  });
});
