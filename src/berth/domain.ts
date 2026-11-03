/**
 * berth's concepts and every rule over them. Nothing here touches the file
 * system, the network or the clock: the shell gathers facts (which checkouts
 * exist, which ports bind, the time) and hands them in.
 *
 * The one stored value is {@link State}. Which ports are taken, who holds a
 * store and which leases are stale are derived from it, never stored.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** A TCP port berth may hand out or reserve. */
export const Port = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 65_535 }),
).pipe(Schema.brand("Port"));
export type Port = typeof Port.Type;

/** A project's name as its `berth.json` declares it. */
export const ProjectName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/u),
).pipe(Schema.brand("ProjectName"));
export type ProjectName = typeof ProjectName.Type;

/** An environment a project declares: `dev`, `e2e`. */
export const EnvName = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]*$/u),
).pipe(Schema.brand("EnvName"));
export type EnvName = typeof EnvName.Type;

/** The role a port plays inside one env: `web`, `graphiql`. */
export const Role = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]*$/u),
).pipe(Schema.brand("Role"));
export type Role = typeof Role.Type;

/** A checkout's root: the real, absolute directory holding its `berth.json`. */
export const CheckoutPath = Schema.String.check(
  Schema.isPattern(/^(\/|[A-Za-z]:\\)/u),
).pipe(Schema.brand("CheckoutPath"));
export type CheckoutPath = typeof CheckoutPath.Type;

/** The machine a lease lives on. Ports and paths mean something only there. */
export const MachineName = Schema.NonEmptyString.pipe(
  Schema.brand("MachineName"),
);
export type MachineName = typeof MachineName.Type;

/** A Shopify store's permanent domain, `<handle>.myshopify.com`. */
export const StoreDomain = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/u),
).pipe(Schema.brand("StoreDomain"));
export type StoreDomain = typeof StoreDomain.Type;

/** A store domain's handle, the part before `.myshopify.com`. */
export const handleOf = (domain: StoreDomain): string =>
  domain.slice(0, -".myshopify.com".length);

/**
 * What one env of a project needs: one port per role and, for a Shopify app,
 * a store. `config` is the app config file the env's `shopify app dev` runs
 * with, relative to the checkout. An env whose server picks its own port
 * leaves out `ports`. A `store.pool` that older manifests carry decodes and is
 * ignored.
 */
export const EnvSpec = Schema.Struct({
  ports: Schema.Array(Role).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  store: Schema.optional(Schema.Struct({ config: Schema.NonEmptyString })),
});
export type EnvSpec = typeof EnvSpec.Type;

/** `berth.json`, committed at a checkout's root. */
export const Manifest = Schema.Struct({
  project: ProjectName,
  envs: Schema.Record(EnvName, EnvSpec),
});
export type Manifest = typeof Manifest.Type;

/** `~/.config/berth/config.json`. Every field is optional over the defaults. */
export const Config = Schema.Struct({
  machine: Schema.optional(MachineName),
  ports: Schema.optional(
    Schema.Struct({
      first: Schema.optional(Port),
      last: Schema.optional(Port),
      reserved: Schema.optional(Schema.Array(Port)),
    }),
  ),
});
export type Config = typeof Config.Type;

/**
 * The reserved ports are the ones something binds fixed: xnotes main's dev server (6969),
 * the shared agent Chrome's CDP (9333) and Shopify CLI's default GraphiQL
 * (3457). A config that sets `reserved` replaces the list.
 */
export const DEFAULT_PORTS = {
  first: 4000,
  last: 4999,
  reserved: [3457, 6969, 9333],
} as const;

/** {@link Config} with defaults applied, the machine resolved, and the store pool. */
export interface Policy {
  readonly machine: MachineName;
  readonly ports: {
    readonly first: Port;
    readonly last: Port;
    readonly reserved: ReadonlySet<Port>;
  };
  /** The stores berth may lease, in `stores.json` order. */
  readonly stores: ReadonlyArray<StoreDomain>;
}

/**
 * A lease's identity. `project` is not part of it: one path holds one
 * `berth.json`, so a project rename keeps the lease.
 */
export const LeaseKey = Schema.Struct({
  machine: MachineName,
  checkout: CheckoutPath,
  env: EnvName,
});
export type LeaseKey = typeof LeaseKey.Type;

/** A store a lease holds, with the app config it was granted for. */
export const StoreGrant = Schema.Struct({
  domain: StoreDomain,
  config: Schema.NonEmptyString,
});
export type StoreGrant = typeof StoreGrant.Type;

/**
 * One (checkout, env)'s resources. `ports` has exactly the env's roles;
 * `store` is none for an env without a store.
 */
export const Lease = Schema.Struct({
  key: LeaseKey,
  project: ProjectName,
  ports: Schema.Record(Role, Port),
  store: Schema.OptionFromNullOr(StoreGrant),
  acquiredAt: Schema.DateTimeUtcFromString,
});
export type Lease = typeof Lease.Type;

/**
 * The whole ledger. {@link checkState} holds for every stored value. The
 * `pool` and `poolSyncedAt` of older generations decode and are dropped.
 */
export const State = Schema.Struct({ leases: Schema.Array(Lease) });
export type State = typeof State.Type;

export const EMPTY_STATE: State = { leases: [] };

export const sameKey = (a: LeaseKey, b: LeaseKey): boolean =>
  a.machine === b.machine && a.checkout === b.checkout && a.env === b.env;

const describeKey = (key: LeaseKey) =>
  `${key.machine}:${key.checkout} ${key.env}`;

/**
 * The invariants of {@link State}: no key held twice, no port held twice on
 * one machine, no reserved port leased on this machine, and no store held
 * twice. Returns the first violation.
 */
export const checkState = (
  state: State,
  policy: Policy,
): Option.Option<string> => {
  const keys = new Set<string>();
  const ports = new Map<string, string>();
  const stores = new Map<StoreDomain, string>();
  for (const lease of state.leases) {
    const key = describeKey(lease.key);
    if (keys.has(key)) return Option.some(`lease ${key} appears twice`);
    keys.add(key);
    for (const [role, port] of Object.entries(lease.ports)) {
      const holder = `${key} ${role}`;
      const portKey = `${lease.key.machine}:${String(port)}`;
      const other = ports.get(portKey);
      if (other !== undefined)
        return Option.some(
          `port ${String(port)} is held by ${other} and ${holder}`,
        );
      ports.set(portKey, holder);
      if (
        lease.key.machine === policy.machine &&
        policy.ports.reserved.has(port)
      )
        return Option.some(
          `reserved port ${String(port)} is leased by ${holder}`,
        );
    }
    if (Option.isSome(lease.store)) {
      const { domain } = lease.store.value;
      const other = stores.get(domain);
      if (other !== undefined)
        return Option.some(`store ${domain} is held by ${other} and ${key}`);
      stores.set(domain, key);
    }
  }
  return Option.none();
};

/** Every port a lease on `machine` holds, except the lease `except`'s own. */
const takenPorts = (
  state: State,
  machine: MachineName,
  except: Option.Option<LeaseKey>,
): ReadonlySet<Port> =>
  new Set(
    state.leases
      .filter(
        (lease) =>
          lease.key.machine === machine &&
          !Option.exists(except, (key) => sameKey(key, lease.key)),
      )
      .flatMap((lease) => Object.values(lease.ports)),
  );

/** This machine's leases whose checkout is in `gone`: the only staleness. */
export const staleLeases = (
  state: State,
  machine: MachineName,
  gone: ReadonlySet<CheckoutPath>,
): ReadonlyArray<Lease> =>
  state.leases.filter(
    (lease) => lease.key.machine === machine && gone.has(lease.key.checkout),
  );

/** Ends the leases with these keys. Ending a lease that is gone is a no-op. */
export const release = (
  state: State,
  keys: ReadonlyArray<LeaseKey>,
): State => ({
  ...state,
  leases: state.leases.filter(
    (lease) => !keys.some((key) => sameKey(key, lease.key)),
  ),
});

/** Ends this machine's leases whose checkout is in `gone`. */
export const sweep = (
  state: State,
  machine: MachineName,
  gone: ReadonlySet<CheckoutPath>,
): State =>
  release(
    state,
    staleLeases(state, machine, gone).map((lease) => lease.key),
  );

/** The store each lease holds, by domain. */
const holders = (state: State): ReadonlyMap<StoreDomain, Lease> =>
  new Map(
    state.leases.flatMap((lease) =>
      Option.match(lease.store, {
        onNone: () => [],
        onSome: (store) => [[store.domain, lease] as const],
      }),
    ),
  );

/** The lease holding `domain`, if any. */
export const holderOf = (
  state: State,
  domain: StoreDomain,
): Option.Option<Lease> => Option.fromNullishOr(holders(state).get(domain));

/** The first store in `stores` that no lease holds. */
export const pickStore = (
  state: State,
  stores: ReadonlyArray<StoreDomain>,
): Option.Option<StoreDomain> => {
  const held = holders(state);
  return Option.fromNullishOr(stores.find((domain) => !held.has(domain)));
};

/** Exact values `--adopt` asks for, once, for migration from `.env`. */
export interface Adopt {
  readonly ports: ReadonlyMap<Role, Port>;
  readonly store: Option.Option<StoreDomain>;
}

/** What {@link reconcile} is asked to make true. */
export interface Request {
  readonly key: LeaseKey;
  readonly project: ProjectName;
  readonly spec: EnvSpec;
  readonly adopt: Adopt;
}

/** The facts {@link reconcile} needs from outside, gathered by the shell. */
export interface Facts {
  readonly policy: Policy;
  /** Whether a candidate port binds now. A snapshot, probed by the shell. */
  readonly isBindable: (port: Port) => Effect.Effect<boolean>;
  readonly now: Lease["acquiredAt"];
}

/** Every port in the range is leased, reserved or bound by another program. */
export class PortsExhaustedError extends Schema.TaggedError<PortsExhaustedError>()(
  "PortsExhaustedError",
  { first: Schema.Int, last: Schema.Int },
) {
  override get message() {
    return `no free port in ${String(this.first)}-${String(this.last)}`;
  }
}

/** `--adopt` asked for a value berth cannot give this lease. */
export class AdoptRefusedError extends Schema.TaggedError<AdoptRefusedError>()(
  "AdoptRefusedError",
  {
    value: Schema.String,
    reason: Schema.Literals([
      "unknown-role",
      "reserved",
      "held",
      "no-store",
      "not-in-pool",
    ]),
  },
) {
  override get message() {
    return `cannot adopt ${this.value}: ${this.reason}`;
  }
}

/**
 * Every store in `stores.json` is leased. berth never creates a store; the
 * pool grows by adding a store to `stores.json`.
 */
export class StorePoolExhaustedError extends Schema.TaggedError<StorePoolExhaustedError>()(
  "StorePoolExhaustedError",
  { stores: Schema.Int },
) {
  override get message() {
    return `all ${String(this.stores)} stores in stores.json are leased`;
  }
}

/**
 * The lowest port in the range that `taken` lacks, is not reserved, and binds
 * now. An unleased busy port belongs to an unknown program and is skipped.
 */
export const pickPort = Effect.fn("Domain.pickPort")(function* (
  taken: ReadonlySet<Port>,
  facts: Facts,
): Effect.fn.Return<Port, PortsExhaustedError> {
  const { first, last, reserved } = facts.policy.ports;
  for (let candidate = first; candidate <= last; candidate++) {
    const port = Port.make(candidate);
    if (taken.has(port) || reserved.has(port)) continue;
    if (yield* facts.isBindable(port)) return port;
  }
  return yield* new PortsExhaustedError({ first, last });
});

/**
 * Makes the request's lease match its spec, keeping everything it has: a new
 * role gets a port, a removed role's port is freed, an adopted value replaces
 * the held one, and a store is granted, kept, or given up when the spec drops
 * it or `stores.json` no longer lists it. A lease that already matches comes
 * back unchanged, so the ledger skips the write. `acquiredAt` is set once, on
 * creation.
 */
export const reconcile = Effect.fn("Domain.reconcile")(function* (
  state: State,
  request: Request,
  facts: Facts,
): Effect.fn.Return<
  { readonly state: State; readonly lease: Lease },
  PortsExhaustedError | AdoptRefusedError | StorePoolExhaustedError
> {
  const { key, spec, adopt } = request;
  const current = Option.fromNullishOr(
    state.leases.find((lease) => sameKey(lease.key, key)),
  );
  const others = takenPorts(state, key.machine, Option.some(key));

  for (const [role, port] of adopt.ports) {
    const value = `${role}=${String(port)}`;
    if (!spec.ports.includes(role))
      return yield* new AdoptRefusedError({ value, reason: "unknown-role" });
    if (facts.policy.ports.reserved.has(port))
      return yield* new AdoptRefusedError({ value, reason: "reserved" });
    if (others.has(port))
      return yield* new AdoptRefusedError({ value, reason: "held" });
  }

  const adopted = new Set(adopt.ports.values());
  const kept = new Map(adopt.ports);
  for (const role of spec.ports) {
    const held = Option.getOrUndefined(
      Option.flatMapNullishOr(current, (lease) => lease.ports[role]),
    );
    if (
      held !== undefined &&
      !kept.has(role) &&
      !adopted.has(held) &&
      !facts.policy.ports.reserved.has(held)
    )
      kept.set(role, held);
  }

  const ports: Record<Role, Port> = {};
  for (const role of spec.ports) {
    const held = kept.get(role);
    if (held !== undefined) {
      ports[role] = held;
      continue;
    }
    ports[role] = yield* pickPort(
      new Set([...others, ...kept.values(), ...Object.values(ports)]),
      facts,
    );
  }

  const stores = facts.policy.stores;
  let store = Option.none<StoreGrant>();
  if (spec.store !== undefined) {
    const domain = yield* Option.match(adopt.store, {
      onSome: (domain) => {
        const value = `store=${handleOf(domain)}`;
        if (!stores.includes(domain))
          return Effect.fail(
            new AdoptRefusedError({ value, reason: "not-in-pool" }),
          );
        if (
          Option.exists(
            holderOf(state, domain),
            (holder) => !sameKey(holder.key, key),
          )
        )
          return Effect.fail(new AdoptRefusedError({ value, reason: "held" }));
        return Effect.succeed(domain);
      },
      onNone: () =>
        Option.match(
          Option.filter(
            Option.flatMap(current, (lease) => lease.store),
            (grant) => stores.includes(grant.domain),
          ),
          {
            onSome: (grant) => Effect.succeed(grant.domain),
            onNone: () =>
              Option.match(pickStore(state, stores), {
                onSome: Effect.succeed,
                onNone: () =>
                  Effect.fail(
                    new StorePoolExhaustedError({ stores: stores.length }),
                  ),
              }),
          },
        ),
    });
    store = Option.some({ domain, config: spec.store.config });
  } else if (Option.isSome(adopt.store))
    return yield* new AdoptRefusedError({
      value: `store=${handleOf(adopt.store.value)}`,
      reason: "no-store",
    });

  const lease: Lease = {
    key,
    project: request.project,
    ports,
    store,
    acquiredAt: Option.match(current, {
      onNone: () => facts.now,
      onSome: (lease) => lease.acquiredAt,
    }),
  };
  const leases = Option.isSome(current)
    ? state.leases.map((held) => (sameKey(held.key, key) ? lease : held))
    : [...state.leases, lease];
  return { state: { ...state, leases }, lease };
});
