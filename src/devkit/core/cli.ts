/**
 * How every devkit bin runs its command. It is internal: not in `exports`. A bin is a thin file
 * under `bin/` that hands its module's `command` to {@link runCli}, so a module never runs on
 * import and a test can import it.
 *
 * @module
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Effect from "effect/Effect";

/**
 * Runs `command` with the process's arguments and `NodeServices`, and exits 2 on a usage error:
 * Effect renders usage errors with help and returns, so the exit code is set here.
 */
export const runCli = <Name extends string, Input, ContextInput, E>(
  command: Command.Command<
    Name,
    Input,
    ContextInput,
    E,
    NodeServices.NodeServices
  >,
): void => {
  command.pipe(
    Command.run({ version: "1.0.0" }),
    Effect.catchIf(
      (error) => error instanceof CliError.ShowHelp,
      (help) =>
        Effect.sync(() => {
          if (help.errors.length > 0) process.exitCode = 2;
        }),
    ),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
};
