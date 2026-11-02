/**
 * The CLI and the JSON contract consumers parse. Consumers live in other
 * repos and decode this shape with their own schema, so it is versioned by
 * `berth: 1` and only grows.
 *
 * `acquire`, `release` and `create-store` print exactly one JSON document on stdout, success
 * or failure; human lines go to stderr. A typed failure exits 1, a usage error
 * exits 2.
 *
 * @module
 */
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";

import {
  type Adopt,
  handleOf,
  type Lease,
  type Policy,
  PoolName,
  Port,
  Role,
  StoreDomain,
} from "./domain.ts";
import * as Berth from "./lease.ts";
import { Ledger } from "./ledger.ts";
import { findCheckout, ledgerDirectory, loadPolicy } from "./settings.ts";

/** What `berth acquire` prints, and each lease `release` and `list` print. */
interface LeaseJson {
  readonly berth: 1;
  readonly project: string;
  readonly checkout: string;
  readonly env: string;
  readonly machine: string;
  readonly ports: Readonly<Record<string, number>>;
  readonly store: { readonly domain: string; readonly config: string } | null;
  readonly acquiredAt: string;
}

const toLeaseJson = (lease: Lease): LeaseJson => ({
  berth: 1,
  project: lease.project,
  checkout: lease.key.checkout,
  env: lease.key.env,
  machine: lease.key.machine,
  ports: lease.ports,
  store: Option.match(lease.store, {
    onNone: () => null,
    onSome: ({ domain, config }) => ({ domain, config }),
  }),
  acquiredAt: DateTime.formatIso(lease.acquiredAt),
});

const printJson = (value: unknown) =>
  Console.log(JSON.stringify(value, null, 2));

/**
 * Runs a command body with the machine's policy and ledger. A typed failure
 * prints `{ berth: 1, error: { _tag, message, ...fields } }` on stdout, its
 * message on stderr, and exits 1. Defects keep Effect's rendering.
 */
const run = <
  A,
  E extends { readonly _tag: string; readonly message: string },
  R,
>(
  body: (policy: Policy) => Effect.Effect<A, E, R>,
  print: (value: A) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const policy = yield* loadPolicy();
    const directory = yield* ledgerDirectory;
    return yield* body(policy).pipe(
      Effect.provide(Ledger.layer(directory, policy)),
    );
  }).pipe(
    Effect.matchEffect({
      onSuccess: print,
      onFailure: (error) =>
        Effect.gen(function* () {
          yield* printJson({
            berth: 1,
            error: {
              ...Object.fromEntries(Object.entries(error)),
              _tag: error._tag,
              message: error.message,
            },
          });
          yield* Console.error(`berth: ${error.message}`);
          yield* Effect.sync(() => {
            process.exitCode = 1;
          });
        }),
    }),
  );

/**
 * `--adopt web=3901 --adopt store=mw10013-pool-01`: `store` takes a
 * store's handle, every other key is a role and takes a port.
 */
const parseAdopt = (
  pairs: Option.Option<Record<string, string>>,
): Option.Option<Adopt> => {
  const ports = new Map<Role, Port>();
  let store = Option.none<StoreDomain>();
  for (const [key, value] of Object.entries(
    Option.getOrElse(pairs, () => ({})),
  )) {
    if (key === "store") {
      store = Schema.decodeUnknownOption(StoreDomain)(
        value.endsWith(".myshopify.com") ? value : `${value}.myshopify.com`,
      );
      if (Option.isNone(store)) return Option.none();
      continue;
    }
    const role = Schema.decodeUnknownOption(Role)(key);
    const port = Schema.decodeUnknownOption(Port)(
      /^\d+$/u.test(value) ? Number(value) : Number.NaN,
    );
    if (Option.isNone(role) || Option.isNone(port)) return Option.none();
    ports.set(role.value, port.value);
  }
  return Option.some({ ports, store });
};

const acquire = Command.make(
  "acquire",
  {
    env: Argument.String("env").pipe(
      Argument.withDescription("An env declared in berth.json, e.g. dev"),
    ),
    bindable: Flag.Boolean("bindable").pipe(
      Flag.withDescription(
        "Fail with PortBusyError unless every leased port binds now",
      ),
      Flag.withDefault(false),
    ),
    adopt: Flag.KeyValuePair("adopt").pipe(
      Flag.optional,
      Flag.filterMap(
        parseAdopt,
        () =>
          "--adopt takes role=<port> or store=<handle>, e.g. --adopt web=3901",
      ),
      Flag.withDescription(
        "Take an exact value once, for migration: --adopt web=3901",
      ),
    ),
  },
  ({ env, bindable, adopt }) =>
    run(
      (policy) =>
        Effect.gen(function* () {
          const checkout = yield* findCheckout(".");
          return yield* Berth.acquire(policy, checkout, env, {
            bindable,
            adopt,
          });
        }),
      (lease) => printJson(toLeaseJson(lease)),
    ),
).pipe(
  Command.withShortDescription(
    "Ensure and print this checkout's lease for an env",
  ),
  Command.withExamples([
    {
      command: "berth acquire dev",
      description: "Print this checkout's dev lease, creating it on first use",
    },
    {
      command: "berth acquire dev --bindable",
      description: "Same, and fail if a leased port is in use",
    },
  ]),
);

const release = Command.make(
  "release",
  {
    env: Argument.String("env").pipe(
      Argument.withDescription("The env to release; every env when omitted"),
      Argument.optional,
    ),
  },
  ({ env }) =>
    run(
      (policy) =>
        Effect.gen(function* () {
          const checkout = yield* findCheckout(".");
          return yield* Berth.release(policy, checkout, env);
        }),
      (released) =>
        printJson({ berth: 1, released: released.map(toLeaseJson) }),
    ),
).pipe(
  Command.withShortDescription("Release this checkout's leases"),
  Command.withExamples([
    {
      command: "berth release",
      description: "Before removing a worktree: release every env",
    },
  ]),
);

const toTable = (rows: ReadonlyArray<ReadonlyArray<string>>): string => {
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => row[column].length)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
};

const toListText = (listing: Berth.Listing): string => {
  const leases = toTable([
    ["PROJECT", "ENV", "CHECKOUT", "PORTS", "STORE"],
    ...listing.holdings.map(({ lease, stale }) => [
      lease.project,
      lease.key.env,
      `${lease.key.checkout}${stale ? " (stale)" : ""}`,
      Object.entries(lease.ports)
        .map(([role, port]) => `${role}=${String(port)}`)
        .join(" "),
      Option.match(lease.store, {
        onNone: () => "",
        onSome: (store) => handleOf(store.domain),
      }),
    ]),
  ]);
  const held = listing.stores.filter((store) => Option.isSome(store.holder));
  const synced = Option.match(listing.poolSyncedAt, {
    onNone: () => "never synced",
    onSome: (at) => `synced ${DateTime.formatIso(at)}`,
  });
  return `${leases}\n\nstores: ${String(listing.stores.length)} pooled, ${String(held.length)} held, ${String(listing.stores.length - held.length)} free (${synced})`;
};

const list = Command.make(
  "list",
  {
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("Print JSON instead of a table"),
      Flag.withDefault(false),
    ),
  },
  ({ json }) =>
    run(Berth.list, (listing) =>
      json
        ? printJson({
            berth: 1,
            leases: listing.holdings.map(({ lease, stale }) => ({
              ...toLeaseJson(lease),
              stale,
            })),
            stores: listing.stores.map(({ store, pools, holder }) => ({
              domain: store.domain,
              pools,
              holder: Option.match(holder, {
                onNone: () => null,
                onSome: (lease) => ({
                  project: lease.project,
                  checkout: lease.key.checkout,
                  env: lease.key.env,
                }),
              }),
            })),
            poolSyncedAt: Option.match(listing.poolSyncedAt, {
              onNone: () => null,
              onSome: DateTime.formatIso,
            }),
          })
        : Console.log(toListText(listing)),
    ),
).pipe(
  Command.withShortDescription(
    "Show who holds which ports and stores, across all projects",
  ),
);

const createStore = Command.make(
  "create-store",
  {
    pool: Argument.String("pool").pipe(
      Argument.withDescription("A pool in config.json, e.g. pool"),
      Argument.withSchema(PoolName),
    ),
  },
  ({ pool }) =>
    run(
      (policy) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const lock = path.join(
            path.dirname(yield* ledgerDirectory),
            "create.lock",
          );
          return yield* Berth.createStore(policy, lock, pool);
        }),
      ({ domain, created }) => printJson({ berth: 1, store: domain, created }),
    ),
).pipe(
  Command.withShortDescription(
    "Grow a store pool by one, one creation at a time, unless a store is free",
  ),
  Command.withExamples([
    {
      command: "berth create-store pool",
      description: "After StorePoolExhaustedError: make the next pool store",
    },
  ]),
);

export const command = Command.make("berth").pipe(
  Command.withDescription(
    "Lease local dev ports and Shopify dev stores per checkout and env, machine-wide.",
  ),
  Command.withSubcommands([acquire, release, list, createStore]),
);
