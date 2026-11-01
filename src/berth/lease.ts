/**
 * berth's three operations: `acquire`, `release` and `list`. Each gathers
 * facts, runs domain transitions through the ledger's compare-and-swap, and
 * reports what it swept. Every write first sweeps this machine's leases whose
 * checkout is gone. The Shopify CLI runs only between ledger writes, so a
 * retried transition repeats no network call.
 *
 * @module
 */
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  type Adopt,
  AdoptRefusedError,
  type CheckoutPath,
  createCommand,
  EnvName,
  handleOf,
  holderOf,
  type Lease,
  mergePool,
  NoFreeStoreError,
  type Policy,
  type PoolName,
  type PoolStore,
  reconcile,
  release as releaseLeases,
  sameKey,
  type State,
  staleLeases,
  sweep,
} from "./domain.ts";
import { Ledger } from "./ledger.ts";
import { isBindable } from "./probe.ts";
import { type Checkout } from "./settings.ts";
import * as Shopify from "./shopify.ts";

/** The env is not in the checkout's `berth.json`. */
export class UnknownEnvError extends Schema.TaggedError<UnknownEnvError>()(
  "UnknownEnvError",
  { env: Schema.String, declared: Schema.Array(Schema.String) },
) {
  override get message() {
    return `berth.json declares no env ${this.env} (declared: ${this.declared.join(", ")})`;
  }
}

/**
 * `--bindable`: a port this lease holds is bound right now. berth never moves
 * a leased port; whatever holds it must stop.
 */
export class PortBusyError extends Schema.TaggedError<PortBusyError>()(
  "PortBusyError",
  { role: Schema.String, port: Schema.Int },
) {
  override get message() {
    return `leased port ${String(this.port)} (${this.role}) is in use; lsof -nP -iTCP:${String(this.port)} -sTCP:LISTEN names the holder`;
  }
}

/**
 * No store in the env's pool is free, even after a sync from Shopify. berth
 * never creates a store, because store domains are global and permanent.
 * `create` is the exact command; rerun `berth acquire` after it.
 */
export class StorePoolExhaustedError extends Schema.TaggedError<StorePoolExhaustedError>()(
  "StorePoolExhaustedError",
  { pool: Schema.String, create: Schema.String },
) {
  override get message() {
    return `no free store in pool ${this.pool}; create one with ${this.create}, then rerun berth acquire`;
  }
}

/** `release` of a store this checkout's `shopify app dev` is running on. */
export class LeaseInUseError extends Schema.TaggedError<LeaseInUseError>()(
  "LeaseInUseError",
  { env: Schema.String, store: Schema.String, pid: Schema.Int },
) {
  override get message() {
    return `shopify app dev (pid ${String(this.pid)}) is running on ${this.store} for ${this.env}; stop it, then release`;
  }
}

export interface AcquireOptions {
  /** Also require every leased port to bind now. */
  readonly bindable: boolean;
  readonly adopt: Adopt;
}

/** A lease and whether its checkout is gone, for `list`. */
export interface Holding {
  readonly lease: Lease;
  readonly stale: boolean;
}

/** A pooled store and the lease holding it, for `list`. */
export interface PooledStore {
  readonly store: PoolStore;
  readonly pools: ReadonlyArray<PoolName>;
  readonly holder: Option.Option<Lease>;
}

/** This machine's checkouts on the ledger whose directory is gone. */
const goneCheckouts = Effect.fn("Berth.goneCheckouts")(function* (
  policy: Policy,
  state: State,
) {
  const fs = yield* FileSystem.FileSystem;
  const gone = new Set<CheckoutPath>();
  for (const lease of state.leases)
    if (
      lease.key.machine === policy.machine &&
      !(yield* fs.exists(lease.key.checkout).pipe(Effect.orDie))
    )
      gone.add(lease.key.checkout);
  return gone;
});

/** Sweeps stale leases inside `transition`'s write and reports them. */
const modifySwept = Effect.fn("Berth.modifySwept")(function* <A, E>(
  policy: Policy,
  transition: (
    state: State,
  ) => Effect.Effect<{ readonly state: State; readonly value: A }, E>,
) {
  const committed = yield* (yield* Ledger).modify((state) =>
    Effect.gen(function* () {
      const gone = yield* goneCheckouts(policy, state);
      const next = yield* transition(sweep(state, policy.machine, gone));
      return {
        state: next.state,
        value: {
          value: next.value,
          swept: staleLeases(state, policy.machine, gone),
        },
      };
    }),
  );
  for (const lease of committed.value.swept) {
    yield* Console.error(
      `berth: swept ${lease.project} ${lease.key.env} at ${lease.key.checkout}: the checkout is gone`,
    );
    if (Option.isSome(lease.store))
      yield* Console.error(
        `berth: freed ${lease.store.value.domain} without a clean; the next shopify app dev on it replaces the preview`,
      );
  }
  return committed.value.value;
});

/**
 * Ensures the lease of (checkout, env) matches the manifest and returns it. A
 * matching lease returns without a ledger write.
 */
export const acquire = Effect.fn("Berth.acquire")(function* (
  policy: Policy,
  checkout: Checkout,
  envName: string,
  options: AcquireOptions,
) {
  const env = Schema.decodeUnknownOption(EnvName)(envName).pipe(
    Option.filter((env) => Object.hasOwn(checkout.manifest.envs, env)),
  );
  if (Option.isNone(env))
    return yield* new UnknownEnvError({
      env: envName,
      declared: Object.keys(checkout.manifest.envs),
    });
  const spec = checkout.manifest.envs[env.value];
  const now = yield* DateTime.now;
  const request = {
    key: { machine: policy.machine, checkout: checkout.path, env: env.value },
    project: checkout.manifest.project,
    spec,
    adopt: options.adopt,
  };
  const attempt = modifySwept(policy, (state) =>
    reconcile(state, request, { policy, isBindable, now }).pipe(
      Effect.map(({ state, lease, released }) => ({
        state,
        value: { lease, released },
      })),
    ),
  );
  const { lease, released } = yield* attempt.pipe(
    Effect.catchIf(
      (error) =>
        error instanceof NoFreeStoreError ||
        (error instanceof AdoptRefusedError && error.reason === "not-in-pool"),
      () =>
        Effect.gen(function* () {
          yield* Console.error("berth: syncing the store pool from Shopify");
          const listed = yield* Shopify.listStores(
            policy.stores.organizationId,
          );
          const syncedAt = yield* DateTime.now;
          yield* (yield* Ledger).modify((state) =>
            Effect.succeed({
              state: mergePool(state, listed, policy, syncedAt),
              value: undefined,
            }),
          );
          return yield* attempt;
        }),
    ),
    Effect.catchTag("NoFreeStoreError", (error) =>
      Effect.gen(function* () {
        const state = yield* (yield* Ledger).read;
        const pattern = policy.stores.pools.get(error.pool);
        return yield* new StorePoolExhaustedError({
          pool: error.pool,
          create:
            pattern === undefined ? "" : createCommand(state, pattern, policy),
        });
      }),
    ),
  );
  if (Option.isSome(released))
    yield* Console.error(
      `berth: freed ${released.value.domain} without a clean, since berth.json no longer asks for it; shopify app dev clean --config ${released.value.config} --store ${released.value.domain} cleans it`,
    );
  if (options.bindable)
    for (const [role, port] of Object.entries(lease.ports))
      if (!(yield* isBindable(port)))
        return yield* new PortBusyError({ role, port });
  return lease;
});

/**
 * Ends the checkout's lease for `env`, or every env it holds when none. An env
 * missing from `berth.json` is still releasable. Releasing nothing succeeds.
 *
 * It refuses while this checkout's `shopify app dev` runs on a leased store.
 * Each store's dev preview is cleaned from the checkout before its lease ends;
 * a failed clean keeps that lease and fails, so a rerun is safe.
 */
export const release = Effect.fn("Berth.release")(function* (
  policy: Policy,
  checkout: Checkout,
  env: Option.Option<string>,
) {
  const held = (yield* (yield* Ledger).read).leases.filter(
    (lease) =>
      lease.key.machine === policy.machine &&
      lease.key.checkout === checkout.path &&
      Option.match(env, {
        onNone: () => true,
        onSome: (env) => lease.key.env === env,
      }),
  );
  for (const lease of held)
    if (Option.isSome(lease.store)) {
      const pid = yield* Shopify.liveSession(
        checkout.path,
        lease.store.value.domain,
      );
      if (Option.isSome(pid))
        return yield* new LeaseInUseError({
          env: lease.key.env,
          store: lease.store.value.domain,
          pid: pid.value,
        });
    }
  const ended: Array<Lease> = [];
  for (const lease of held) {
    if (Option.isSome(lease.store)) {
      yield* Shopify.clean(
        checkout.path,
        lease.store.value.config,
        lease.store.value.domain,
      );
      yield* Console.error(`berth: cleaned ${lease.store.value.domain}`);
    }
    yield* modifySwept(policy, (state) =>
      Effect.succeed({ state: releaseLeases(state, [lease.key]), value: 0 }),
    );
    ended.push(lease);
  }
  if (held.length === 0)
    yield* modifySwept(policy, (state) => Effect.succeed({ state, value: 0 }));
  return ended;
});

/** What `list` shows. */
export interface Listing {
  readonly holdings: ReadonlyArray<Holding>;
  readonly stores: ReadonlyArray<PooledStore>;
  readonly poolSyncedAt: State["poolSyncedAt"];
}

/** Every lease on the ledger, all projects and machines, and the pool. Never writes. */
export const list = Effect.fn("Berth.list")(function* (
  policy: Policy,
): Effect.fn.Return<Listing, never, Ledger | FileSystem.FileSystem> {
  const state = yield* (yield* Ledger).read;
  const gone = yield* goneCheckouts(policy, state);
  const stale = staleLeases(state, policy.machine, gone);
  return {
    holdings: state.leases.map((lease): Holding => ({
      lease,
      stale: stale.some((held) => sameKey(held.key, lease.key)),
    })),
    stores: state.pool.map((store): PooledStore => ({
      store,
      pools: [...policy.stores.pools]
        .filter(([, pattern]) => pattern.test(handleOf(store.domain)))
        .map(([pool]) => pool),
      holder: holderOf(state, store.domain),
    })),
    poolSyncedAt: state.poolSyncedAt,
  };
});
