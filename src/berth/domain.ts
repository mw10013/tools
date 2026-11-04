/**
 * berth's concepts and every rule over them. Nothing here touches the file
 * system or the clock: the shell gathers facts (which checkouts exist, the
 * time) and hands them in.
 *
 * The one stored value is {@link State}. Who holds a store and which leases
 * are stale are derived from it, never stored.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

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

/** A checkout's root: the real, absolute directory holding its `berth.json`. */
export const CheckoutPath = Schema.String.check(
  Schema.isPattern(/^(\/|[A-Za-z]:\\)/u),
).pipe(Schema.brand("CheckoutPath"));
export type CheckoutPath = typeof CheckoutPath.Type;

/** The machine a lease lives on. Paths mean something only there. */
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
 * What one env of a project needs: a Shopify dev store. `config` is the app
 * config file the env's `shopify app dev` runs with, relative to the checkout.
 * A `store.pool` that older manifests carry decodes and is ignored.
 */
export const EnvSpec = Schema.Struct({
  store: Schema.Struct({ config: Schema.NonEmptyString }).pipe(
    Schema.annotateKey({
      messageMissingKey:
        'every env needs "store": { "config": "<app config file>" }, because berth leases only Shopify dev stores',
    }),
  ),
});
export type EnvSpec = typeof EnvSpec.Type;

/** `berth.json`, committed at a checkout's root. */
export const Manifest = Schema.Struct({
  project: ProjectName,
  envs: Schema.Record(EnvName, EnvSpec),
});
export type Manifest = typeof Manifest.Type;

/** `~/.config/berth/config.json`. Every field is optional. */
export const Config = Schema.Struct({
  machine: Schema.optional(MachineName),
});
export type Config = typeof Config.Type;

/** {@link Config} with the machine resolved, and the store pool. */
export interface Policy {
  readonly machine: MachineName;
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

/** One (checkout, env)'s store. */
export const Lease = Schema.Struct({
  key: LeaseKey,
  project: ProjectName,
  store: StoreGrant,
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
 * The invariants of {@link State}: no key held twice and no store held twice.
 * Returns the first violation.
 */
export const checkState = (state: State): Option.Option<string> => {
  const keys = new Set<string>();
  const stores = new Map<StoreDomain, string>();
  for (const lease of state.leases) {
    const key = describeKey(lease.key);
    if (keys.has(key)) return Option.some(`lease ${key} appears twice`);
    keys.add(key);
    const other = stores.get(lease.store.domain);
    if (other !== undefined)
      return Option.some(
        `store ${lease.store.domain} is held by ${other} and ${key}`,
      );
    stores.set(lease.store.domain, key);
  }
  return Option.none();
};

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
  new Map(state.leases.map((lease) => [lease.store.domain, lease]));

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

/** What {@link reconcile} is asked to make true. */
export interface Request {
  readonly key: LeaseKey;
  readonly project: ProjectName;
  readonly spec: EnvSpec;
  /** The exact store `--adopt` asks for, once, for migration. */
  readonly adopt: Option.Option<StoreDomain>;
}

/** The facts {@link reconcile} needs from outside, gathered by the shell. */
export interface Facts {
  readonly policy: Policy;
  readonly now: Lease["acquiredAt"];
}

/** `--adopt` asked for a store berth cannot give this lease. */
export class AdoptRefusedError extends Schema.TaggedError<AdoptRefusedError>()(
  "AdoptRefusedError",
  {
    value: Schema.String,
    reason: Schema.Literals(["held", "not-in-pool"]),
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
 * Makes the request's lease match its spec: an adopted store replaces the
 * held one, a held store stays while `stores.json` lists it, and otherwise the
 * first free store is granted. A lease that already matches comes back
 * unchanged, so the ledger skips the write. `acquiredAt` is set once, on
 * creation.
 */
export const reconcile = Effect.fn("Domain.reconcile")(function* (
  state: State,
  request: Request,
  facts: Facts,
): Effect.fn.Return<
  { readonly state: State; readonly lease: Lease },
  AdoptRefusedError | StorePoolExhaustedError
> {
  const { key, adopt } = request;
  const stores = facts.policy.stores;
  const current = Option.fromNullishOr(
    state.leases.find((lease) => sameKey(lease.key, key)),
  );
  const domain = yield* Option.match(adopt, {
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
          Option.map(current, (lease) => lease.store.domain),
          (domain) => stores.includes(domain),
        ),
        {
          onSome: Effect.succeed,
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

  const lease: Lease = {
    key,
    project: request.project,
    store: { domain, config: request.spec.store.config },
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
