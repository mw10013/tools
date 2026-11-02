/**
 * berth's operations: `acquire`, `release`, `list` and `createStore`. Each
 * gathers facts, runs domain transitions through the ledger's
 * compare-and-swap, and reports what it swept. Every write first sweeps this
 * machine's leases whose checkout is gone, cleaning each swept store from a
 * sibling checkout first. The Shopify CLI runs only between ledger writes, so
 * a retried transition repeats no network call, and a store is cleaned while
 * its lease still holds it, so no one else can be on it.
 *
 * @module
 */
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import {
  type Adopt,
  AdoptRefusedError,
  type CheckoutPath,
  createArgs,
  createCommand,
  droppedStore,
  EnvName,
  handleOf,
  holderOf,
  type Lease,
  mergePool,
  nextStoreName,
  NoFreeStoreError,
  type Policy,
  type PoolName,
  type PoolStore,
  reconcile,
  release as releaseLeases,
  sameKey,
  siblingCheckouts,
  type State,
  type StoreGrant,
  staleLeases,
  type StoreDomain,
  sweep,
  UnknownPoolError,
} from "./domain.ts";
import { Ledger } from "./ledger.ts";
import { isAlive, isBindable } from "./probe.ts";
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
 * No store in the env's pool is free, even after a sync from Shopify.
 * `acquire` never creates a store, because store domains are global and
 * permanent. `create` is the exact command, `berth create-store <pool>`;
 * rerun `berth acquire` after it.
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

/**
 * Cleans each store a stale lease holds, from a sibling checkout of its
 * project that has the store's app config, while the stale lease still holds
 * it. A store with no such sibling, or whose clean fails, is freed by the
 * sweep regardless, with the command that cleans it. Returns the cleaned.
 */
const cleanSwept = Effect.fn("Berth.cleanSwept")(function* (policy: Policy) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const state = yield* (yield* Ledger).read;
  const gone = yield* goneCheckouts(policy, state);
  const cleaned = new Set<StoreDomain>();
  for (const lease of staleLeases(state, policy.machine, gone)) {
    if (Option.isNone(lease.store)) continue;
    const { config, domain } = lease.store.value;
    for (const sibling of siblingCheckouts(state, lease, gone)) {
      if (!(yield* fs.exists(path.join(sibling, config)))) continue;
      const result = yield* Shopify.clean(sibling, config, domain).pipe(
        Effect.result,
      );
      if (Result.isSuccess(result)) {
        cleaned.add(domain);
        yield* Console.error(
          `berth: cleaned ${domain} from ${sibling}, for the gone ${lease.key.checkout}`,
        );
      } else yield* Console.error(`berth: ${result.failure.message}`);
      break;
    }
  }
  return cleaned;
});

/**
 * Sweeps stale leases inside `transition`'s write and reports them, after
 * {@link cleanSwept} cleans what it can.
 */
const modifySwept = Effect.fn("Berth.modifySwept")(function* <A, E>(
  policy: Policy,
  transition: (
    state: State,
  ) => Effect.Effect<{ readonly state: State; readonly value: A }, E>,
) {
  const cleaned = yield* cleanSwept(policy);
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
    if (Option.isSome(lease.store) && !cleaned.has(lease.store.value.domain)) {
      const { config, domain } = lease.store.value;
      yield* Console.error(
        `berth: freed ${domain} without a clean; from a ${lease.project} checkout, shopify app dev clean --config ${config} --store ${domain} cleans it`,
      );
    }
  }
  return committed.value.value;
});

/**
 * Cleans the store a lease is about to give up, since `berth.json` no longer
 * asks for it, before {@link reconcile} frees it. Refuses while this
 * checkout's `shopify app dev` runs on it; a failed clean fails `acquire` and
 * keeps the lease, so a rerun retries. An absent config means no preview.
 */
const cleanDropped = Effect.fn("Berth.cleanDropped")(function* (
  checkout: Checkout,
  env: string,
  grant: StoreGrant,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pid = yield* Shopify.liveSession(checkout.path, grant.domain);
  if (Option.isSome(pid))
    return yield* new LeaseInUseError({
      env,
      store: grant.domain,
      pid: pid.value,
    });
  if (!(yield* fs.exists(path.join(checkout.path, grant.config)))) return;
  yield* Shopify.clean(checkout.path, grant.config, grant.domain);
  yield* Console.error(
    `berth: cleaned ${grant.domain}, since berth.json no longer asks for it`,
  );
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
  const dropped = droppedStore(
    Option.fromNullishOr(
      (yield* (yield* Ledger).read).leases.find((lease) =>
        sameKey(lease.key, request.key),
      ),
    ),
    request,
  );
  if (Option.isSome(dropped))
    yield* cleanDropped(checkout, env.value, dropped.value);
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
          yield* syncPool(policy);
          return yield* attempt;
        }),
    ),
    Effect.catchTag("NoFreeStoreError", (error) =>
      Effect.fail(
        new StorePoolExhaustedError({
          pool: error.pool,
          create: createCommand(error.pool),
        }),
      ),
    ),
  );
  if (
    Option.isSome(released) &&
    !Option.exists(dropped, (grant) => grant.domain === released.value.domain)
  )
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
 * a failed clean keeps that lease and fails, so a rerun is safe. A store whose
 * app config is absent from the checkout is freed without a clean: the config
 * exists before any `shopify app dev` with it, so there is no preview.
 */
export const release = Effect.fn("Berth.release")(function* (
  policy: Policy,
  checkout: Checkout,
  env: Option.Option<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
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
      const { config, domain } = lease.store.value;
      if (yield* fs.exists(path.join(checkout.path, config))) {
        yield* Shopify.clean(checkout.path, config, domain);
        yield* Console.error(`berth: cleaned ${domain}`);
      } else
        yield* Console.error(
          `berth: freed ${domain} without a clean: ${config} is absent, so this checkout never ran shopify app dev with it`,
        );
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

/** Another `berth create-store` held the lock for longer than berth waits. */
export class CreateLockBusyError extends Schema.TaggedError<CreateLockBusyError>()(
  "CreateLockBusyError",
  { lock: Schema.String, pid: Schema.Int },
) {
  override get message() {
    return `berth create-store (pid ${String(this.pid)}) still holds ${this.lock}; wait for it, then rerun`;
  }
}

/** The pool has no numbered store and its pattern names no first one. */
export class StoreNameUnknownError extends Schema.TaggedError<StoreNameUnknownError>()(
  "StoreNameUnknownError",
  { pool: Schema.String, pattern: Schema.String },
) {
  override get message() {
    return `pool ${this.pool}'s pattern ${this.pattern} names no next store; create one by hand`;
  }
}

/** Shopify gave the new store another handle, so it is outside the pool. */
export class StoreRenamedError extends Schema.TaggedError<StoreRenamedError>()(
  "StoreRenamedError",
  { name: Schema.String, domain: Schema.String },
) {
  override get message() {
    return `asked Shopify for ${this.name} and got ${this.domain}, which is outside the pool; the name is taken`;
  }
}

/** What {@link createStore} did. */
export interface CreatedStore {
  readonly domain: StoreDomain;
  /** False when a store in the pool was already free, so none was made. */
  readonly created: boolean;
}

/**
 * Holds `lock`, a file holding the holder's pid, for `use`. A lock whose pid
 * is dead is taken over; a live one is waited on, once a second, for up to
 * ten minutes.
 */
const withLock = <A, E, R>(lock: string, use: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const take = Effect.gen(function* () {
      const taken = yield* fs
        .writeFileString(lock, String(process.pid), { flag: "wx" })
        .pipe(
          Effect.as(true),
          Effect.catchTag("PlatformError", () => Effect.succeed(false)),
        );
      if (taken) return;
      const holder = Number(
        yield* fs.readFileString(lock).pipe(Effect.orElseSucceed(() => "")),
      );
      if (!Number.isInteger(holder) || holder <= 0 || !isAlive(holder)) {
        yield* fs.remove(lock).pipe(Effect.ignore);
        return yield* new CreateLockBusyError({ lock, pid: 0 });
      }
      return yield* new CreateLockBusyError({ lock, pid: holder });
    });
    yield* Effect.acquireRelease(
      take.pipe(
        Effect.retry({
          schedule: Schedule.spaced("1 second"),
          times: 600,
        }),
      ),
      () => fs.remove(lock).pipe(Effect.ignore),
    );
    return yield* use;
  }).pipe(Effect.scoped);

/** Merges a fresh `shopify store list` into the pool and returns the state. */
const syncPool = Effect.fn("Berth.syncPool")(function* (policy: Policy) {
  const listed = yield* Shopify.listStores(policy.stores.organizationId);
  const syncedAt = yield* DateTime.now;
  const committed = yield* (yield* Ledger).modify((state) =>
    Effect.succeed({
      state: mergePool(state, listed, policy, syncedAt),
      value: undefined,
    }),
  );
  return committed.state;
});

/**
 * Grows `pool` by one store, one `berth create-store` at a time on this
 * machine, so two never ask Shopify for the same name. Under the lock it
 * syncs the pool first: a store that is already free is returned and none is
 * made, so parallel callers that each saw an exhausted pool make one store
 * between them, not one each.
 */
export const createStore = Effect.fn("Berth.createStore")(function* (
  policy: Policy,
  lock: string,
  pool: PoolName,
) {
  const pattern = policy.stores.pools.get(pool);
  if (pattern === undefined)
    return yield* new UnknownPoolError({
      pool,
      configured: [...policy.stores.pools.keys()],
    });
  return yield* withLock(
    lock,
    Effect.gen(function* () {
      const state = yield* syncPool(policy);
      const free = state.pool.find(
        (store) =>
          pattern.test(handleOf(store.domain)) &&
          Option.isNone(holderOf(state, store.domain)),
      );
      if (free !== undefined) {
        yield* Console.error(
          `berth: ${free.domain} in pool ${pool} is free; created none`,
        );
        return { domain: free.domain, created: false } satisfies CreatedStore;
      }
      const name = nextStoreName(state, pattern);
      if (Option.isNone(name))
        return yield* new StoreNameUnknownError({
          pool,
          pattern: pattern.source,
        });
      yield* Console.error(`berth: creating ${name.value}`);
      const domain = yield* Shopify.createStore(
        name.value,
        createArgs(name.value, policy),
      );
      if (handleOf(domain) !== name.value)
        return yield* new StoreRenamedError({ name: name.value, domain });
      yield* syncPool(policy);
      return { domain, created: true } satisfies CreatedStore;
    }),
  );
});
