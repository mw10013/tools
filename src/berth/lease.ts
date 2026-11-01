/**
 * berth's three operations: `acquire`, `release` and `list`. Each gathers
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
  type Lease,
  type Policy,
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
  const lease = yield* modifySwept(policy, (state) =>
    reconcile(state, request, { policy, isBindable, now }).pipe(
      Effect.map(({ state, lease }) => ({ state, value: lease })),
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
 */
export const release = Effect.fn("Berth.release")(function* (
  policy: Policy,
  checkout: Checkout,
  env: Option.Option<string>,
) {
  return yield* modifySwept(policy, (state) => {
    const ended = state.leases.filter(
      (lease) =>
        lease.key.machine === policy.machine &&
        lease.key.checkout === checkout.path &&
        Option.match(env, {
          onNone: () => true,
          onSome: (env) => lease.key.env === env,
        }),
    );
    return Effect.succeed({
      state: releaseLeases(
        state,
        ended.map((lease) => lease.key),
      ),
      value: ended,
    });
  });
});

/** Every lease on the ledger, all projects and machines. Never writes. */
export const list = Effect.fn("Berth.list")(function* (policy: Policy) {
  const state = yield* (yield* Ledger).read;
  const gone = yield* goneCheckouts(policy, state);
  const stale = staleLeases(state, policy.machine, gone);
  return state.leases.map((lease): Holding => ({
    lease,
    stale: stale.some((held) => sameKey(held.key, lease.key)),
  }));
});
