/**
 * The CLI. Each command prints one JSON document on stdout, `{ devkit: 1, ... }`,
 * success or failure; human lines go to stderr. A typed failure exits 1.
 *
 * @module
 */
import * as path from "node:path";

import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Git from "#wt/git.ts";

import * as Devkit from "./sync.ts";

const TOOLS = path.resolve(import.meta.dirname, "../..");

const warnAlchemy = (mismatch: Option.Option<Devkit.AlchemyMismatch>) =>
  Option.match(mismatch, {
    onNone: () => Effect.void,
    onSome: ({ devkit, app }) =>
      Console.error(
        `devkit: built against alchemy ${devkit}, but this repo has ${app} installed; align the app's alchemy with tools' (or tools' with the app's) and sync`,
      ),
  });

const printJson = (value: object) =>
  Console.log(JSON.stringify({ devkit: 1, ...value }, null, 2));

const appRoot = Git.appRoot(process.cwd());

const run = <
  A extends object,
  E extends { readonly _tag: string; readonly message: string },
  R,
>(
  body: Effect.Effect<A, E, R>,
) =>
  body.pipe(
    Effect.matchEffect({
      onSuccess: printJson,
      onFailure: (error) =>
        Effect.gen(function* () {
          yield* printJson({
            error: { _tag: error._tag, message: error.message },
          });
          yield* Console.error(`devkit: ${error.message}`);
          yield* Effect.sync(() => {
            process.exitCode = 1;
          });
        }),
    }),
  );

const sync = Command.make(
  "sync",
  {
    layer: Argument.Literals("layer", Devkit.LAYERS).pipe(
      Argument.optional,
      Argument.withDescription(
        "core, cloudflare (includes core) or shopify (includes both); default the last sync's",
      ),
    ),
  },
  ({ layer }) =>
    run(
      Effect.gen(function* () {
        const synced = yield* Devkit.sync(TOOLS, yield* appRoot, layer);
        const count =
          synced.added.length + synced.changed.length + synced.removed.length;
        yield* Console.error(
          count === 0
            ? `devkit: ${Devkit.VENDOR} already matches tools ${synced.tools.slice(0, 7)}`
            : `devkit: synced ${synced.layer} at tools ${synced.tools.slice(0, 7)}: ${String(count)} file(s) changed`,
        );
        yield* warnAlchemy(synced.alchemyMismatch);
        return {
          ...synced,
          alchemyMismatch: Option.getOrNull(synced.alchemyMismatch),
        };
      }),
    ),
).pipe(
  Command.withShortDescription(
    "Copy devkit from tools' HEAD into this repo's vendor/devkit/, refusing if a vendored file was edited",
  ),
);

const status = Command.make("status", {}, () =>
  run(
    Effect.gen(function* () {
      const s = yield* Devkit.status(TOOLS, yield* appRoot);
      yield* warnAlchemy(s.alchemyMismatch);
      return {
        tools: Option.getOrNull(s.tools),
        head: s.head,
        layer: Option.getOrNull(s.layer),
        behind: s.behind,
        edited: s.edited,
        alchemyMismatch: Option.getOrNull(s.alchemyMismatch),
      };
    }),
  ),
).pipe(
  Command.withShortDescription(
    "Whether vendor/devkit/ was edited, whether a sync would change it, and whether its Alchemy matches the repo's",
  ),
);

export const command = Command.make("devkit").pipe(
  Command.withDescription(
    "Vendor devkit, the dev tooling shared by the apps, into this repository.",
  ),
  Command.withSubcommands([sync, status]),
);
