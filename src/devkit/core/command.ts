import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export class CommandError extends Schema.TaggedError<CommandError>()(
  "CommandError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

/** Fails on a non-zero exit, which `spawner.string` does not check. */
export const runCommand = Effect.fn("Command.runCommand")(function* (
  command: string,
  args: readonly string[],
  input?: string,
  env?: Record<string, string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const spawnFailed = (cause: unknown) =>
    new CommandError({
      message: `Failed to run ${command} ${args.join(" ")}`,
      cause,
    });
  const handle = yield* spawner
    .spawn(
      ChildProcess.make(command, [...args], {
        ...(input === undefined
          ? {}
          : { stdin: Stream.make(new TextEncoder().encode(input)) }),
        ...(env === undefined ? {} : { env, extendEnv: true }),
      }),
    )
    .pipe(Effect.mapError(spawnFailed));
  const [stdout, stderr] = yield* Effect.all(
    [
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
    ],
    { concurrency: "unbounded" },
  ).pipe(Effect.mapError(spawnFailed));
  const exitCode = yield* handle.exitCode.pipe(Effect.mapError(spawnFailed));
  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* new CommandError({
      message: `${command} ${args.join(" ")} exited ${String(exitCode)}${stderr ? `: ${stderr}` : ""}`,
    });
  }
  return stdout;
}, Effect.scoped);
