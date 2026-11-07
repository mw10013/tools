/**
 * The CLI. Each command prints one JSON document on stdout, `{ devkit: 1, ... }`,
 * success or failure; human lines go to stderr. A typed failure exits 1.
 *
 * @module
 */
import * as path from "node:path";

import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Git from "#wt/git.ts";

import * as DevkitBuild from "./build.ts";
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

// devkit's source no longer fits a vendored copy (app() replaced ROOT, bins no longer self-run),
// so a sync would break the app; each app moves to the @mw10013/devkit package instead.
const sync = Command.make("sync", {}, () =>
  run(
    Effect.fail({
      _tag: "SyncRetiredError",
      message:
        "devkit is a package now: install @mw10013/devkit from a devkit-v* tag instead of syncing vendor/devkit/",
    }),
  ),
).pipe(
  Command.withShortDescription(
    "Retired: devkit is the @mw10013/devkit package; refuses to copy into vendor/devkit/",
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

const build = Command.make("build", {}, () =>
  run(
    Effect.gen(function* () {
      const built = yield* DevkitBuild.build();
      yield* Console.error(`devkit: built the package into ${built.directory}`);
      return built;
    }),
  ),
).pipe(
  Command.withShortDescription(
    "Build src/devkit into the package @mw10013/devkit under dist/devkit/",
  ),
);

export const command = Command.make("devkit").pipe(
  Command.withDescription(
    "Vendor devkit, the dev tooling shared by the apps, into this repository.",
  ),
  Command.withSubcommands([sync, status, build]),
);
