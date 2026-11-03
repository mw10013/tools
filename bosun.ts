import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Command from "effect/cli/Command";

import { command } from "#bosun/command.ts";

command.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.catchTag("ShowHelp", (help) =>
    Effect.sync(() => {
      if (help.errors.length > 0) process.exitCode = 2;
    }),
  ),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
