import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  type Adopt,
  CheckoutPath,
  checkState,
  EMPTY_STATE,
  EnvName,
  type LeaseKey,
  MachineName,
  type Policy,
  Port,
  ProjectName,
  reconcile,
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
const noAdopt: Adopt = { ports: new Map() };

const acquire = (
  state: State,
  key: LeaseKey,
  roles: ReadonlyArray<string>,
  options: { busy?: ReadonlyArray<number>; adopt?: Adopt } = {},
) =>
  reconcile(
    state,
    {
      key,
      project: ProjectName.make("demo"),
      spec: { ports: roles.map((role) => Role.make(role)) },
      adopt: options.adopt ?? noAdopt,
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
      leases: [...a.state.leases, { ...a.lease, key: keyOf("/b") }],
    };
    const reserved: State = {
      leases: [{ ...a.lease, ports: { [web]: Port.make(4001) } }],
    };
    expect(Option.isSome(checkState(twice, policy))).toBe(true);
    expect(Option.isSome(checkState(reserved, policy))).toBe(true);
    expect(checkState(a.state, policy)).toEqual(Option.none());
  });
});
