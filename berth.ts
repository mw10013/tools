import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Command from "effect/cli/Command";
import * as Effect from "effect/Effect";

import { command } from "#berth/command.ts";

command.pipe(
  Command.run({ version: "0.1.0" }),
  // Effect renders usage errors with help; berth's contract exits 2 for them.
  Effect.catchTag("ShowHelp", (help) =>
    Effect.sync(() => {
      if (help.errors.length > 0) process.exitCode = 2;
    }),
  ),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
