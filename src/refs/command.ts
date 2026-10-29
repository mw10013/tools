import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Argument from "effect/cli/Argument";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";

import * as Project from "./project.ts";

const root = Command.make("refs").pipe(
  Command.withDescription("Manage project-local reference snapshots"),
  Command.withSharedFlags({
    project: Flag.Directory("project", { mustExist: true }).pipe(
      Flag.withAlias("p"),
      Flag.withDescription(
        "Project directory; defaults to the current directory",
      ),
      Flag.withDefault("."),
    ),
  }),
);

/** Translate operation failures at the CLI boundary; Effect renders usage errors itself. */
const userError = Effect.mapError(
  (cause: { readonly message: string }) =>
    new CliError.UserError({ cause, userMessage: cause.message }),
);

const init = Command.make(
  "init",
  {},
  Effect.fn("Refs.init")(function* () {
    const { project } = yield* root;
    yield* Project.init(project).pipe(Effect.flatMap(Console.log), userError);
  }),
).pipe(
  Command.withShortDescription("Prepare the refs directory or worktree link"),
  Command.withDescription(
    "Prepare /refs in .gitignore and create the refs directory or worktree symlink. Does not download source or edit AGENTS.md.",
  ),
  Command.withExamples([
    {
      command: "vpx ./refs.ts init",
      description: "Initialize this checkout; safe to repeat",
    },
  ]),
);

const source = {
  reference: Argument.Literals("reference", ["effect"]).pipe(
    Argument.withDescription(
      "Reference to inspect or download (default: effect)",
    ),
    Argument.withDefault("effect"),
  ),
};
const status = Command.make(
  "status",
  source,
  Effect.fn("Refs.status")(function* () {
    const { project } = yield* root;
    yield* Project.status(project).pipe(Effect.flatMap(Console.log), userError);
  }),
).pipe(
  Command.withShortDescription("Compare local source with the project pin"),
  Command.withDescription(
    "Compare the local snapshot with the exact Effect pin in package.json. Reports missing or stale source without network access.",
  ),
  Command.withExamples([
    {
      command: "vpx ./refs.ts status effect",
      description: "Inspect the shared Effect snapshot",
    },
  ]),
);

const sync = Command.make(
  "sync",
  source,
  Effect.fn("Refs.sync")(function* () {
    const { project } = yield* root;
    yield* Project.sync(project).pipe(Effect.flatMap(Console.log), userError);
  }),
).pipe(
  Command.withShortDescription("Download source for the project pin"),
  Command.withDescription(
    "Download source for the exact Effect pin in package.json. Reuse matching snapshots and refuse conflicting worktree pins.",
  ),
  Command.withExamples([
    {
      command: "vpx ./refs.ts sync effect",
      description: "Download the pinned release, or reuse a matching snapshot",
    },
  ]),
);

export const command = root.pipe(
  Command.withSubcommands([init, status, sync]),
  Command.withExamples([
    {
      command: "vpx ./refs.ts init",
      description: "Prepare this project's reference folder",
    },
    {
      command: "vpx ./refs.ts sync effect",
      description: "Fetch source matching the project's Effect pin",
    },
    {
      command: "vpx ./refs.ts status",
      description: "Check the local snapshot without fetching",
    },
    {
      command: "vpx /path/to/tools/refs.ts -p /path/to/project init",
      description: "Prepare another project",
    },
  ]),
);
