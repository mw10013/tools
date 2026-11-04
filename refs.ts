import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Command from "effect/cli/Command";
import * as Effect from "effect/Effect";

import { command } from "#refs/command.ts";

command.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
