/**
 * The CLI. `start` and `status` print one JSON document on stdout
 * ({@link StatusJson}), versioned by `bosun: 1`; human lines go to stderr. A
 * typed failure prints `{ bosun: 1, error: { _tag, message } }` and exits 1.
 * `status` exits 3 when the server is not running.
 *
 * @module
 */
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { RunId, ServerName } from "./domain.ts";
import * as Bosun from "./server.ts";

export class NotInCheckoutError extends Schema.TaggedError<NotInCheckoutError>()(
  "NotInCheckoutError",
  { directory: Schema.String },
) {
  override get message() {
    return `${this.directory} is not inside a git checkout`;
  }
}

const checkoutRoot = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const text = yield* spawner.string(
    ChildProcess.make("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      stdin: "ignore",
    }),
  );
  return text.trim();
}).pipe(
  Effect.filterOrFail(
    (root) => root !== "",
    () => new NotInCheckoutError({ directory: process.cwd() }),
  ),
  Effect.mapError(() => new NotInCheckoutError({ directory: process.cwd() })),
);

const printJson = (value: unknown) =>
  Console.log(JSON.stringify(value, null, 2));

const reported = <
  A,
  E extends { readonly _tag: string; readonly message: string },
  R,
>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        yield* printJson({
          bosun: 1,
          error: { _tag: error._tag, message: error.message },
        });
        yield* Console.error(`error ${error.message}`);
        process.exitCode = 1;
      }),
    ),
  );

const name = Argument.String("name").pipe(
  Argument.withSchema(ServerName),
  Argument.withDescription("The server's name in this checkout, e.g. dev"),
);

const commandArguments = Argument.String("command").pipe(
  Argument.atLeast(1),
  Argument.withDescription("The server's command and its arguments, after --"),
);

const note = Flag.String("note").pipe(
  Flag.optional,
  Flag.withDescription("Extra text for the log's start line, e.g. store=x"),
);

const start = Command.make(
  "start",
  {
    name,
    note,
    timeout: Flag.Int("timeout").pipe(
      Flag.withDefault(Duration.toSeconds(Bosun.START_TIMEOUT)),
      Flag.withDescription("Seconds to wait for the server to answer"),
    ),
    command: commandArguments,
  },
  ({ name, note, timeout, command }) =>
    reported(
      Effect.gen(function* () {
        const root = yield* checkoutRoot;
        const [program, ...args] = command;
        yield* printJson(
          yield* Bosun.start(root, name, [program as string, ...args], {
            note,
            timeout: Duration.seconds(timeout),
          }),
        );
      }),
    ),
).pipe(
  Command.withShortDescription(
    "Adopt this checkout's running server, or launch it detached; wait until it answers",
  ),
  Command.withExamples([
    {
      command: "bosun start dev -- vp run dev:serve",
      description: "Start or adopt the dev server",
    },
  ]),
);

const runCommand = Command.make(
  "run",
  {
    name,
    run: Flag.String("run").pipe(
      Flag.withSchema(RunId),
      Flag.withDescription("The run id start passes"),
    ),
    note,
    command: commandArguments,
  },
  ({ name, run, note, command }) =>
    Effect.gen(function* () {
      const root = yield* checkoutRoot;
      const [program, ...args] = command;
      const code = yield* Bosun.run(root, name, run, note, [
        program as string,
        ...args,
      ]);
      process.exitCode = code;
    }),
).pipe(
  Command.withShortDescription(
    "Internal: run a server in the foreground with its log; start launches it",
  ),
);

const stop = Command.make("stop", { name }, ({ name }) =>
  reported(
    Effect.gen(function* () {
      yield* Bosun.stop(yield* checkoutRoot, name);
    }),
  ),
).pipe(
  Command.withShortDescription(
    "Stop this checkout's server and wait for its exit to be logged",
  ),
);

const status = Command.make("status", { name }, ({ name }) =>
  reported(
    Effect.gen(function* () {
      const now = yield* Bosun.status(yield* checkoutRoot, name);
      yield* printJson(now);
      if (now.state !== "running") process.exitCode = 3;
    }),
  ),
).pipe(
  Command.withShortDescription(
    "Print this checkout's server: state, pid, port and url; exits 3 unless running",
  ),
);

const logs = Command.make(
  "logs",
  {
    name,
    lines: Flag.Int("lines").pipe(
      Flag.withAlias("n"),
      Flag.withDefault(100),
      Flag.withDescription("How many of the last lines to print"),
    ),
    follow: Flag.Boolean("follow").pipe(
      Flag.withAlias("f"),
      Flag.withDefault(false),
      Flag.withDescription("Keep printing new lines, across rotation"),
    ),
  },
  ({ name, lines, follow }) =>
    reported(
      Effect.gen(function* () {
        yield* Bosun.logs(yield* checkoutRoot, name, lines, follow);
      }),
    ),
).pipe(Command.withShortDescription("Print or follow the server's log"));

export const command = Command.make("bosun").pipe(
  Command.withDescription(
    'Run one checkout\'s dev servers detached: start, stop, status and logs. A server publishes its port by writing {"port": n, "url"?: s} to $BOSUN_ENDPOINT.',
  ),
  Command.withSubcommands([start, stop, status, logs, runCommand]),
);
