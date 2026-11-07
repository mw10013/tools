/**
 * The CLI. Each command prints one JSON document on stdout, `{ devkit: 1, ... }`,
 * success or failure; human lines go to stderr. A typed failure exits 1.
 *
 * @module
 */
import * as path from "node:path";

import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Git from "#wt/git.ts";
import { stream } from "#wt/process.ts";

import * as DevkitBuild from "./build.ts";
import * as Release from "./release.ts";
import * as Spec from "./spec.ts";
import * as Status from "./status.ts";
import * as Upgrade from "./upgrade.ts";

const TOOLS = path.resolve(import.meta.dirname, "../..");

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
            error: {
              ...Object.fromEntries(Object.entries(error)),
              _tag: error._tag,
              message: error.message,
            },
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
        "devkit is a package now: run devkit upgrade to move an app to a devkit-v* release instead of syncing vendor/devkit/",
    }),
  ),
).pipe(
  Command.withShortDescription(
    "Retired: devkit is the @mw10013/devkit package; refuses to copy into vendor/devkit/",
  ),
);

const status = Command.make(
  "status",
  {
    projects: Flag.String("projects").pipe(
      Flag.optional,
      Flag.withDescription(
        "Report every consumer one level under this directory (each repository's root and workspace packages) instead of this app",
      ),
    ),
  },
  ({ projects }) =>
    run(
      Effect.gen(function* () {
        if (Option.isSome(projects))
          return yield* Status.scan(
            path.resolve(projects.value),
            Spec.REPOSITORY,
          );
        const app = yield* appRoot;
        return yield* Status.rowOf(
          app,
          yield* Status.latestOn(app, Spec.REPOSITORY),
        );
      }),
    ),
).pipe(
  Command.withShortDescription(
    "The devkit release an app declares, what its lockfile resolved and the latest release",
  ),
  Command.withExamples([
    { command: "devkit status", description: "This app" },
    {
      command: "devkit status --projects ~/projects",
      description: "Every consumer under ~/projects",
    },
  ]),
);

const checkPin = Command.make("check-pin", {}, () =>
  run(
    Effect.gen(function* () {
      return yield* Status.checkPin(yield* appRoot);
    }),
  ),
).pipe(
  Command.withShortDescription(
    "Fail unless devkit is pinned to a release: refuses file:, link:, a branch, a sha or a prerelease",
  ),
);

const upgrade = Command.make(
  "upgrade",
  {
    version: Argument.String("version").pipe(
      Argument.optional,
      Argument.withDescription(
        "The release to move to, major.minor.patch; default the latest",
      ),
    ),
  },
  ({ version }) =>
    run(
      Effect.gen(function* () {
        const app = yield* appRoot;
        return yield* Upgrade.upgrade(
          app,
          Spec.REPOSITORY,
          version,
          Upgrade.installIn(app),
        );
      }),
    ),
).pipe(
  Command.withShortDescription(
    "Set the app's devkit spec to a release, run vp install and print the release log",
  ),
  Command.withExamples([
    { command: "devkit upgrade", description: "To the latest release" },
    { command: "devkit upgrade 0.2.0", description: "To devkit-v0.2.0" },
  ]),
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

/** The checks a release must pass: the repository's own, and the tests that guard the package. */
const verify = Effect.gen(function* () {
  yield* stream(TOOLS, path.join(TOOLS, "node_modules/.bin/vp"), ["check"]);
  yield* stream(TOOLS, path.join(TOOLS, "node_modules/.bin/vp"), [
    "test",
    "run",
    "src/devkit",
    "src/devkit-cli",
  ]);
});

const release = Command.make(
  "release",
  {
    version: Argument.String("version").pipe(
      Argument.withDescription("The new release, major.minor.patch"),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Build and write the release commit, but create no tag and push nothing",
      ),
    ),
  },
  ({ version, dryRun }) =>
    run(
      Release.release(TOOLS, version, {
        dryRun,
        verify,
        build: (directory, stamped) => DevkitBuild.build(directory, stamped),
      }),
    ),
).pipe(
  Command.withShortDescription(
    "Publish devkit as the tag devkit-v<version> on an orphan commit of the built package",
  ),
  Command.withExamples([
    {
      command: "devkit release 0.2.0 --dry-run",
      description: "Everything except the tag and the push",
    },
  ]),
);

export const command = Command.make("devkit").pipe(
  Command.withDescription(
    "Release devkit, the dev tooling shared by the apps, and see and move the apps that use it.",
  ),
  Command.withSubcommands([release, status, upgrade, checkPin, build, sync]),
);
