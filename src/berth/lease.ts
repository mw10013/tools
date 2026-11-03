/**
 * berth's operations: `acquire`, `release`, `show` and `list`. Each gathers
 * facts, runs domain transitions through the ledger's compare-and-swap, and
 * reports what it swept. Every write first sweeps this machine's leases whose
 * checkout is gone.
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
  type CheckoutPath,
  EnvName,
  holderOf,
  type Lease,
  type Policy,
  reconcile,
  release as releaseLeases,
  sameKey,
  type State,
  staleLeases,
  type StoreDomain,
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

/** A store in `stores.json` and the lease holding it, for `list`. */
export interface PooledStore {
  readonly domain: StoreDomain;
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
  for (const lease of committed.value.swept)
    yield* Console.error(
      `berth: swept ${lease.project} ${lease.key.env} at ${lease.key.checkout}: the checkout is gone`,
    );
  return committed.value.value;
});

/** `envName` when `berth.json` declares it. */
const declaredEnv = (checkout: Checkout, envName: string) =>
  Option.match(
    Schema.decodeUnknownOption(EnvName)(envName).pipe(
      Option.filter((env) => Object.hasOwn(checkout.manifest.envs, env)),
    ),
    {
      onNone: () =>
        Effect.fail(
          new UnknownEnvError({
            env: envName,
            declared: Object.keys(checkout.manifest.envs),
          }),
        ),
      onSome: Effect.succeed,
    },
  );

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
  const env = yield* declaredEnv(checkout, envName);
  const spec = checkout.manifest.envs[env];
  const now = yield* DateTime.now;
  const request = {
    key: { machine: policy.machine, checkout: checkout.path, env: env },
    project: checkout.manifest.project,
    spec,
    adopt: options.adopt,
  };
  const lease = yield* modifySwept(policy, (state) =>
    Effect.map(
      reconcile(state, request, { policy, isBindable, now }),
      ({ state, lease }) => ({ state, value: lease }),
    ),
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
 * It refuses while this checkout's `shopify app dev` runs on a leased store,
 * so a store is never leased to a second checkout while the first still runs
 * on it. The store's dev preview stays: the next holder's `shopify app dev`
 * replaces it.
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
  yield* modifySwept(policy, (state) =>
    Effect.succeed({
      state: releaseLeases(
        state,
        held.map((lease) => lease.key),
      ),
      value: 0,
    }),
  );
  return held;
});

/**
 * The checkout's lease for `env` on this machine, if it holds one. Never
 * writes: a command that only stops what a lease started asks this, so a
 * checkout without one is not granted ports and a store on its way out.
 */
export const show = Effect.fn("Berth.show")(function* (
  policy: Policy,
  checkout: Checkout,
  envName: string,
) {
  const env = yield* declaredEnv(checkout, envName);
  const key = { machine: policy.machine, checkout: checkout.path, env };
  return Option.fromNullishOr(
    (yield* (yield* Ledger).read).leases.find((lease) =>
      sameKey(lease.key, key),
    ),
  );
});

/** What `list` shows. */
export interface Listing {
  readonly holdings: ReadonlyArray<Holding>;
  readonly stores: ReadonlyArray<PooledStore>;
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
    stores: policy.stores.map((domain): PooledStore => ({
      domain,
      holder: holderOf(state, domain),
    })),
  };
});
