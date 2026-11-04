import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

class ProcessError extends Schema.TaggedError<ProcessError>()("ProcessError", {
  message: Schema.String,
}) {}

export const run = Effect.fn("Process.run")(function* (
  directory: string,
  executable: string,
  args: readonly string[],
  input?: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const process = yield* spawner.spawn(
    ChildProcess.make(executable, args, {
      cwd: directory,
      stdin:
        input === undefined
          ? "ignore"
          : Stream.make(new TextEncoder().encode(input)),
      stderr: "inherit",
      env: { GIT_TERMINAL_PROMPT: "0" },
      extendEnv: true,
    }),
  );
  const text = yield* Stream.mkString(Stream.decodeText(process.stdout));
  const exit = yield* process.exitCode;
  if (exit !== 0)
    return yield* new ProcessError({
      message: `${executable} ${args[0]} failed (exit ${String(exit)})`,
    });
  return text.trim();
}, Effect.scoped);
