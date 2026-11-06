import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
/**
 * The CLI and the JSON contract consumers parse. Consumers live in other
 * repos and decode this shape with their own schema, so it is versioned by
 * `berth: 1` and only grows.
 *
 * `acquire`, `show`, `release` and `pool ensure` print exactly one JSON document on stdout,
 * success or failure; human lines go to stderr. A typed failure exits 1, a usage error
 * exits 2.
 *
 * @module
 */
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { handleOf, type Lease, type Policy, StoreDomain } from "./domain.ts";
import * as Berth from "./lease.ts";
import { Ledger } from "./ledger.ts";
import * as PoolEnsure from "./pool-ensure.ts";
import {
  findCheckout,
  ledgerDirectory,
  loadPolicy,
  poolFile,
} from "./settings.ts";
import { ShopifyCli } from "./shopify.ts";

interface LeaseJson {
  readonly berth: 1;
  readonly project: string;
  readonly checkout: string;
  readonly env: string;
  readonly machine: string;
  readonly store: { readonly domain: string; readonly config: string };
  readonly acquiredAt: string;
}

const toLeaseJson = (lease: Lease): LeaseJson => ({
  berth: 1,
  project: lease.project,
  checkout: lease.key.checkout,
  env: lease.key.env,
  machine: lease.key.machine,
  store: lease.store,
  acquiredAt: DateTime.formatIso(lease.acquiredAt),
});

const printJson = (value: unknown) =>
  Console.log(JSON.stringify(value, null, 2));

const report = <
  A,
  E extends { readonly _tag: string; readonly message: string },
  R,
>(
  effect: Effect.Effect<A, E, R>,
  print: (value: A) => Effect.Effect<void>,
) =>
  effect.pipe(
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

const run = <
  A,
  E extends { readonly _tag: string; readonly message: string },
  R,
>(
  body: (policy: Policy) => Effect.Effect<A, E, R>,
  print: (value: A) => Effect.Effect<void>,
) =>
  report(
    Effect.gen(function* () {
      const policy = yield* loadPolicy();
      const directory = yield* ledgerDirectory;
      return yield* body(policy).pipe(Effect.provide(Ledger.layer(directory)));
    }),
    print,
  );

const parseAdopt = (
  pairs: Option.Option<Record<string, string>>,
): Option.Option<Option.Option<StoreDomain>> => {
  const { store, ...rest } = Option.getOrElse(
    pairs,
    (): Record<string, string> => ({}),
  );
  if (Object.keys(rest).length > 0) return Option.none();
  if (store === undefined) return Option.some(Option.none());
  return Option.map(
    Schema.decodeUnknownOption(StoreDomain)(
      store.endsWith(".myshopify.com") ? store : `${store}.myshopify.com`,
    ),
    Option.some,
  );
};

const acquire = Command.make(
  "acquire",
  {
    env: Argument.String("env").pipe(
      Argument.withDescription("An env declared in berth.json, e.g. dev"),
    ),
    adopt: Flag.KeyValuePair("adopt").pipe(
      Flag.optional,
      Flag.filterMap(
        parseAdopt,
        () =>
          "--adopt takes store=<handle>, e.g. --adopt store=mw10013-pool-01",
      ),
      Flag.withDescription(
        "Take an exact store once, for migration: --adopt store=mw10013-pool-01",
      ),
    ),
  },
  ({ env, adopt }) =>
    run(
      (policy) =>
        Effect.gen(function* () {
          const checkout = yield* findCheckout(".");
          return yield* Berth.acquire(policy, checkout, env, adopt);
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
  ]),
);

const show = Command.make(
  "show",
  {
    env: Argument.String("env").pipe(
      Argument.withDescription("An env declared in berth.json, e.g. dev"),
    ),
  },
  ({ env }) =>
    run(
      (policy) =>
        Effect.gen(function* () {
          const checkout = yield* findCheckout(".");
          return yield* Berth.show(policy, checkout, env);
        }),
      (lease) =>
        printJson({
          berth: 1,
          lease: Option.match(lease, {
            onNone: () => null,
            onSome: toLeaseJson,
          }),
        }),
    ),
).pipe(
  Command.withShortDescription(
    "Print this checkout's lease for an env, or null; never creates one",
  ),
  Command.withExamples([
    {
      command: "berth show dev",
      description:
        "Before stopping a dev server: is there a lease it could have started on",
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
    ["PROJECT", "ENV", "CHECKOUT", "STORE"],
    ...listing.holdings.map(({ lease, stale }) => [
      lease.project,
      lease.key.env,
      `${lease.key.checkout}${stale ? " (stale)" : ""}`,
      handleOf(lease.store.domain),
    ]),
  ]);
  const held = listing.stores.filter((store) => Option.isSome(store.holder));
  return `${leases}\n\nstores: ${String(listing.stores.length)} pooled, ${String(held.length)} held, ${String(listing.stores.length - held.length)} free`;
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
            stores: listing.stores.map(({ domain, holder }) => ({
              domain,
              holder: Option.match(holder, {
                onNone: () => null,
                onSome: (lease) => ({
                  project: lease.project,
                  checkout: lease.key.checkout,
                  env: lease.key.env,
                }),
              }),
            })),
          })
        : Console.log(toListText(listing)),
    ),
).pipe(
  Command.withShortDescription(
    "Show who holds which stores, across all projects",
  ),
);

const ensure = Command.make(
  "ensure",
  {
    count: Argument.Int("count").pipe(
      Argument.withDescription(
        "The pool size to grow to; with none, only check and adopt",
      ),
      Argument.optional,
    ),
  },
  ({ count }) =>
    report(
      Effect.gen(function* () {
        return yield* PoolEnsure.ensure(yield* poolFile, count);
      }).pipe(Effect.provide(ShopifyCli.layer)),
      ({ pool, adopted, created }) =>
        printJson({
          berth: 1,
          pool: {
            organization: pool.organization,
            stores: pool.stores.length,
            adopted: adopted.map(handleOf),
            created: created.map(handleOf),
          },
        }),
    ),
).pipe(
  Command.withShortDescription(
    "Check stores.json against Shopify, adopt strays, and create stores up to a count",
  ),
  Command.withExamples([
    {
      command: "berth pool ensure",
      description: "Check every listed store and adopt pool stores left out",
    },
    {
      command: "berth pool ensure 16",
      description: "Grow the pool to 16 stores",
    },
  ]),
);

const pool = Command.make("pool").pipe(
  Command.withShortDescription("Manage the store pool in stores.json"),
  Command.withSubcommands([ensure]),
);

export const command = Command.make("berth").pipe(
  Command.withDescription(
    "Lease Shopify dev stores per checkout and env, machine-wide.",
  ),
  Command.withSubcommands([acquire, show, release, list, pool]),
);
