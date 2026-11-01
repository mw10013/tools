/**
 * The programs wt runs: git, gh, vp and berth.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/** A program wt ran exited nonzero or could not start. */
export class CommandFailedError extends Schema.TaggedError<CommandFailedError>()(
  "CommandFailedError",
  { command: Schema.String, directory: Schema.String, detail: Schema.String },
) {
  override get message() {
    return `${this.command} failed in ${this.directory}: ${this.detail}`;
  }
}

export interface Output {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const lastLine = (text: string) =>
  text.trim().split("\n").at(-1) ?? "no output";

/** Runs `program args` in `directory` and collects its output. */
export const capture = Effect.fn("Process.capture")(function* (
  directory: string,
  program: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = [program, ...args].join(" ");
  const fail = (detail: string) =>
    new CommandFailedError({ command, directory, detail });
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(program, args, {
          cwd: directory,
          stdin: "ignore",
          extendEnv: true,
        }),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { exitCode: Number(exitCode), stdout, stderr } satisfies Output;
    }),
  ).pipe(Effect.mapError((error) => fail(error.message)));
});

/** {@link capture}, failing unless the program exits 0; its stdout. */
export const run = Effect.fn("Process.run")(function* (
  directory: string,
  program: string,
  args: ReadonlyArray<string>,
) {
  const output = yield* capture(directory, program, args);
  if (output.exitCode !== 0)
    return yield* new CommandFailedError({
      command: [program, ...args].join(" "),
      directory,
      detail: lastLine(output.stderr || output.stdout),
    });
  return output.stdout;
});

/**
 * Runs `program args` in `directory` with its output shown on wt's stderr as
 * it comes, keeping wt's stdout for its JSON; fails unless it exits 0.
 */
export const stream = Effect.fn("Process.stream")(function* (
  directory: string,
  program: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = [program, ...args].join(" ");
  const toStderr = (bytes: Uint8Array) =>
    Effect.sync(() => {
      process.stderr.write(bytes);
    });
  const exitCode = yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(program, args, {
          cwd: directory,
          stdin: "ignore",
          extendEnv: true,
        }),
      );
      const [, , code] = yield* Effect.all(
        [
          Stream.runForEach(child.stdout, toStderr),
          Stream.runForEach(child.stderr, toStderr),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return Number(code);
    }),
  ).pipe(
    Effect.mapError(
      (error) =>
        new CommandFailedError({ command, directory, detail: error.message }),
    ),
  );
  if (exitCode !== 0)
    return yield* new CommandFailedError({
      command,
      directory,
      detail: `exit code ${String(exitCode)}`,
    });
});
