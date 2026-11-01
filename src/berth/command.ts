/**
 * The CLI and the JSON contract consumers parse. Consumers live in other
 * repos and decode this shape with their own schema, so it is versioned by
 * `berth: 1` and only grows.
 *
 * `acquire` and `release` print exactly one JSON document on stdout, success
 * or failure; human lines go to stderr. A typed failure exits 1, a usage error
 * exits 2.
 *
 * @module
 */
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";

import { type Adopt, type Lease, type Policy, Port, Role } from "./domain.ts";
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
  readonly store: null;
  readonly acquiredAt: string;
}

const toLeaseJson = (lease: Lease): LeaseJson => ({
  berth: 1,
  project: lease.project,
  checkout: lease.key.checkout,
  env: lease.key.env,
  machine: lease.key.machine,
  ports: lease.ports,
  store: null,
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

/** `--adopt web=3901`: each key a role, each value a port. */
const parseAdopt = (
  pairs: Option.Option<Record<string, string>>,
): Option.Option<Adopt> => {
  const ports = new Map<Role, Port>();
  for (const [key, value] of Object.entries(
    Option.getOrElse(pairs, () => ({})),
  )) {
    const role = Schema.decodeUnknownOption(Role)(key);
    const port = Schema.decodeUnknownOption(Port)(
      /^\d+$/u.test(value) ? Number(value) : Number.NaN,
    );
    if (Option.isNone(role) || Option.isNone(port)) return Option.none();
    ports.set(role.value, port.value);
  }
  return Option.some({ ports });
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
        () => "--adopt takes role=<port>, e.g. --adopt web=3901",
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

const toTable = (holdings: ReadonlyArray<Berth.Holding>): string => {
  const rows = [
    ["PROJECT", "ENV", "CHECKOUT", "PORTS"],
    ...holdings.map(({ lease, stale }) => [
      lease.project,
      lease.key.env,
      `${lease.key.checkout}${stale ? " (stale)" : ""}`,
      Object.entries(lease.ports)
        .map(([role, port]) => `${role}=${String(port)}`)
        .join(" "),
    ]),
  ];
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

const list = Command.make(
  "list",
  {
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("Print JSON instead of a table"),
      Flag.withDefault(false),
    ),
  },
  ({ json }) =>
    run(Berth.list, (holdings) =>
      json
        ? printJson({
            berth: 1,
            leases: holdings.map(({ lease, stale }) => ({
              ...toLeaseJson(lease),
              stale,
            })),
          })
        : Console.log(toTable(holdings)),
    ),
).pipe(
  Command.withShortDescription(
    "Show who holds which ports, across all projects",
  ),
);

export const command = Command.make("berth").pipe(
  Command.withDescription(
    "Lease local dev ports and Shopify dev stores per checkout and env, machine-wide.",
  ),
  Command.withSubcommands([acquire, release, list]),
);
