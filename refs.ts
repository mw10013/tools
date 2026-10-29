import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Argument from "effect/cli/Argument";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";

import * as Project from "#refs/project.ts";

const refs = Command.make("refs").pipe(
  Command.withDescription("Manage project-local reference snapshots"),
  Command.withSharedFlags({
    project: Flag.String("project").pipe(
      Flag.withDescription(
        "Project directory (defaults to the current directory)",
      ),
      Flag.withDefault("."),
    ),
  }),
);

const report = (operation: typeof Project.sync, directory: string) =>
  operation(directory).pipe(
    Effect.flatMap(Console.log),
    Effect.mapError(
      (cause) => new CliError.UserError({ cause, userMessage: cause.message }),
    ),
  );

const init = Command.make(
  "init",
  {},
  Effect.fn("Refs.init")(function* () {
    const { project } = yield* refs;
    yield* report(Project.init, project);
  }),
).pipe(
  Command.withDescription(
    "Configure Effect refs, ignore /refs, and prepare the directory or worktree link",
  ),
);

const source = {
  name: Argument.Literals("name", ["effect"]).pipe(
    Argument.withDefault("effect"),
  ),
};
const status = Command.make(
  "status",
  source,
  Effect.fn("Refs.status")(function* () {
    const { project } = yield* refs;
    yield* report(Project.status, project);
  }),
).pipe(
  Command.withDescription(
    "Inspect the local Effect snapshot without network access",
  ),
);

const sync = Command.make(
  "sync",
  source,
  Effect.fn("Refs.sync")(function* () {
    const { project } = yield* refs;
    yield* report(Project.sync, project);
  }),
).pipe(
  Command.withDescription(
    "Download Effect source matching the project's exact dependency pin",
  ),
);

refs.pipe(
  Command.withSubcommands([init, status, sync]),
  Command.run({ version: "0.1.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
