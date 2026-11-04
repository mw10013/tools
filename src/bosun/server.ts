/**
 * The runner (`bosun run`) owns three processes, each in its own process
 * group: itself, the server's command, and the `s6-log` that writes its
 * output. A stop signals the command's group alone, so the runner and the
 * logger outlive it, drain its last lines and mark its exit.
 *
 * @module
 */
import { randomBytes } from "node:crypto";
import { constants } from "node:os";

import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  BOSUN_DIRECTORY,
  type Ending,
  EndpointJson,
  exitMarker,
  files,
  RunId,
  runOutput,
  type ServerName,
  type ServerRecord,
  ServerRecordJson,
  type ServerState,
  stateOf,
  startMarker,
} from "./domain.ts";

export const START_TIMEOUT = Duration.minutes(3);
const RECORD_TIMEOUT = Duration.seconds(30);
const STOP_TIMEOUT = Duration.seconds(30);
const POLL = Duration.millis(500);
/** The first request after a start may wait on a compile. */
const ANSWER_TIMEOUT = Duration.seconds(10);

/** `s6-log`'s rotation: 20 files of 5 MiB, 100 MiB in all, a timestamp on each line. */
const s6LogArgs = (directory: string) => [
  "-b",
  "-l",
  "65536",
  "n20",
  "s5242880",
  "S104857600",
  "T",
  directory,
  "1",
];

export class ServerExitedError extends Schema.TaggedError<ServerExitedError>()(
  "ServerExitedError",
  { name: Schema.String, run: Schema.String, output: Schema.String },
) {
  override get message() {
    return `the ${this.name} server exited before it answered (run ${this.run})\n${this.output}`;
  }
}

export class StartTimeoutError extends Schema.TaggedError<StartTimeoutError>()(
  "StartTimeoutError",
  {
    name: Schema.String,
    run: Schema.String,
    seconds: Schema.Number,
    output: Schema.String,
  },
) {
  override get message() {
    return `the ${this.name} server did not answer within ${String(this.seconds)}s (run ${this.run}); it is still running\n${this.output}`;
  }
}

export class StopTimeoutError extends Schema.TaggedError<StopTimeoutError>()(
  "StopTimeoutError",
  { name: Schema.String, group: Schema.Int },
) {
  override get message() {
    return `the ${this.name} server's process group ${String(this.group)} survived SIGKILL`;
  }
}

export class LoggerExitedError extends Schema.TaggedError<LoggerExitedError>()(
  "LoggerExitedError",
  { name: Schema.String, code: Schema.Int },
) {
  override get message() {
    return `s6-log exited ${String(this.code)} while the ${this.name} server ran; the server was stopped`;
  }
}

const at = Effect.fn("Bosun.at")(function* (root: string, relative: string) {
  const path = yield* Path.Path;
  return path.join(root, relative);
});

const newRunId = () => RunId.make(randomBytes(4).toString("hex"));

/** Sends `signal` to a pid, or to a process group when `pid` is negative. */
const signal = (pid: number, name: NodeJS.Signals | 0) =>
  Effect.try(() => process.kill(pid, name)).pipe(
    Effect.option,
    Effect.map(Option.isSome),
  );

const groupAlive = (group: number) => signal(-group, 0);

const commandLine = Effect.fn("Bosun.commandLine")(function* (pid: number) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const text = yield* spawner
    .string(
      ChildProcess.make("ps", ["-o", "command=", "-p", String(pid)], {
        stdin: "ignore",
      }),
    )
    .pipe(Effect.orElseSucceed(() => ""));
  return text.trim();
});

const runnerAlive = Effect.fn("Bosun.runnerAlive")(function* (
  record: ServerRecord,
) {
  if (!(yield* signal(record.pid, 0))) return false;
  return (yield* commandLine(record.pid)).includes(`--run ${record.run}`);
});

const readFile = Effect.fn("Bosun.readFile")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(Effect.option);
});

const readRecord = Effect.fn("Bosun.readRecord")(function* (
  root: string,
  name: ServerName,
) {
  const text = yield* readFile(yield* at(root, files(name).record));
  return Option.flatMap(text, Schema.decodeUnknownOption(ServerRecordJson));
});

const readEndpoint = Effect.fn("Bosun.readEndpoint")(function* (
  root: string,
  name: ServerName,
) {
  const text = yield* readFile(yield* at(root, files(name).endpoint));
  return Option.flatMap(text, Schema.decodeUnknownOption(EndpointJson));
});

const answering = (port: number) =>
  Effect.tryPromise(() =>
    fetch(`http://localhost:${String(port)}/`, {
      redirect: "manual",
      signal: AbortSignal.timeout(Duration.toMillis(ANSWER_TIMEOUT)),
    }),
  ).pipe(
    Effect.flatMap((response) =>
      Effect.promise(() => response.body?.cancel() ?? Promise.resolve()),
    ),
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

const writeAtomic = Effect.fn("Bosun.writeAtomic")(function* (
  file: string,
  text: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const temporary = `${file}.${String(process.pid)}.tmp`;
  yield* fs.writeFileString(temporary, text);
  yield* fs.rename(temporary, file);
});

const removeFiles = Effect.fn("Bosun.removeFiles")(function* (
  root: string,
  name: ServerName,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const file of [files(name).record, files(name).endpoint])
    yield* fs
      .remove(yield* at(root, file), { force: true })
      .pipe(Effect.ignore);
});

const waitUntil = <E, R>(
  check: Effect.Effect<boolean, E, R>,
  timeout: Duration.Duration,
) =>
  Effect.gen(function* () {
    const deadline = DateTime.addDuration(yield* DateTime.now, timeout);
    while (!(yield* check)) {
      if (DateTime.isGreaterThan(yield* DateTime.now, deadline)) return false;
      yield* Effect.sleep(POLL);
    }
    return true;
  });

const logLine = Effect.fn("Bosun.logLine")(function* (
  root: string,
  name: ServerName,
  line: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* spawner
    .exitCode(
      ChildProcess.make("s6-log", s6LogArgs(files(name).logDirectory), {
        cwd: root,
        stdin: { stream: Stream.make(new TextEncoder().encode(`${line}\n`)) },
        stdout: "ignore",
        stderr: "inherit",
      }),
    )
    .pipe(Effect.ignore);
});

/** Node's message for a command a signal ended, which Effect's `exitCode` fails with. */
const SIGNALED = /receipt of signal: '(?<signal>SIG[A-Z0-9]+)'/u;

/**
 * How the command ended. A command that does not catch SIGTERM, Vite under `vp` for one, ends by
 * the signal with no exit code, which is a normal stop, not a runner failure.
 */
const endingOf = (child: ChildProcessSpawner.ChildProcessHandle) =>
  child.exitCode.pipe(
    Effect.map((code): Ending => ({ _tag: "Exited", code: Number(code) })),
    Effect.catch((error) => {
      const signal = SIGNALED.exec(String(error.cause))?.groups?.signal;
      return signal === undefined
        ? Effect.fail(error)
        : Effect.succeed<Ending>({ _tag: "Signaled", signal });
    }),
  );

export const run = Effect.fn("Bosun.run")(function* (
  root: string,
  name: ServerName,
  runId: RunId,
  note: Option.Option<string>,
  command: readonly [string, ...string[]],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  // s6-log makes its own directory, not that directory's parent.
  yield* fs.makeDirectory(yield* at(root, files(name).directory), {
    recursive: true,
  });
  yield* fs.writeFileString(
    yield* at(root, `${BOSUN_DIRECTORY}/.gitignore`),
    "*\n",
  );
  yield* removeFiles(root, name);
  const startedAt = DateTime.formatIso(yield* DateTime.now);
  yield* logLine(root, name, startMarker(name, runId, startedAt, note));

  const [program, ...args] = command;
  const child = yield* spawner.spawn(
    ChildProcess.make(program, args, {
      cwd: root,
      env: {
        BOSUN_ENDPOINT: yield* at(root, files(name).endpoint),
        BOSUN_RUN: runId,
        FORCE_COLOR: undefined,
        NO_COLOR: "1",
      },
      extendEnv: true,
      detached: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const group = Number(child.pid);
  const logger = yield* spawner.spawn(
    ChildProcess.make("s6-log", s6LogArgs(files(name).logDirectory), {
      cwd: root,
      detached: true,
      stdin: { stream: Stream.merge(child.stdout, child.stderr) },
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  yield* writeAtomic(
    yield* at(root, files(name).record),
    Schema.encodeSync(ServerRecordJson)({
      bosun: 1,
      name,
      run: runId,
      pid: process.pid,
      group,
      startedAt,
      command,
    }),
  );

  const stopGroup = Effect.gen(function* () {
    yield* signal(-group, "SIGTERM");
    if (
      !(yield* waitUntil(
        groupAlive(group).pipe(Effect.map((alive) => !alive)),
        STOP_TIMEOUT,
      ))
    )
      yield* signal(-group, "SIGKILL");
  });
  const finish = (ending: Ending) =>
    logger.exitCode.pipe(
      Effect.ignore,
      Effect.andThen(logLine(root, name, exitMarker(name, runId, ending))),
      Effect.andThen(removeFiles(root, name)),
    );

  const ending = yield* Effect.raceFirst(
    endingOf(child),
    logger.exitCode.pipe(
      Effect.flatMap((loggerCode) =>
        stopGroup.pipe(
          Effect.andThen(
            new LoggerExitedError({ name, code: Number(loggerCode) }),
          ),
        ),
      ),
    ),
  ).pipe(
    Effect.onInterrupt(() =>
      stopGroup.pipe(
        Effect.andThen(finish({ _tag: "Interrupted" })),
        Effect.ignore,
      ),
    ),
    Effect.tapError(() => removeFiles(root, name)),
  );
  // The command's children can outlive it and hold the logger's pipe open.
  if (yield* groupAlive(group)) yield* stopGroup;
  yield* finish(ending);
  return ending._tag === "Exited"
    ? ending.code
    : ending._tag === "Signaled"
      ? 128 + (constants.signals[ending.signal as NodeJS.Signals] ?? 0)
      : 130;
}, Effect.scoped);

export interface StatusJson {
  readonly bosun: 1;
  readonly name: string;
  readonly state: ServerState;
  readonly run: string | null;
  readonly pid: number | null;
  readonly group: number | null;
  readonly startedAt: string | null;
  readonly port: number | null;
  readonly url: string | null;
  readonly log: string;
}

export const status = Effect.fn("Bosun.status")(function* (
  root: string,
  name: ServerName,
) {
  const record = yield* readRecord(root, name);
  const endpoint = yield* readEndpoint(root, name);
  const seen = Option.isNone(record)
    ? { runner: false, group: false, answering: false }
    : {
        runner: yield* runnerAlive(record.value),
        group: yield* groupAlive(record.value.group),
        answering: Option.isSome(endpoint)
          ? yield* answering(endpoint.value.port)
          : false,
      };
  const state = stateOf(record, seen);
  const live = state !== "stopped";
  const recorded = live ? Option.getOrUndefined(record) : undefined;
  const published = live ? Option.getOrUndefined(endpoint) : undefined;
  return {
    bosun: 1,
    name,
    state,
    run: recorded?.run ?? null,
    pid: recorded?.pid ?? null,
    group: recorded?.group ?? null,
    startedAt: recorded?.startedAt ?? null,
    port: published?.port ?? null,
    url: published?.url ?? null,
    log: files(name).log,
  } satisfies StatusJson;
});

const runOutputOf = Effect.fn("Bosun.runOutputOf")(function* (
  root: string,
  name: ServerName,
  runId: RunId,
) {
  const log = yield* readFile(yield* at(root, files(name).log));
  return Option.match(
    Option.flatMap(log, (text) => runOutput(text, name, runId)),
    {
      onNone: () => `(run ${runId} wrote nothing to ${files(name).log})`,
      onSome: (output) =>
        `--- ${files(name).log}, run ${runId} ---\n${output}\n---`,
    },
  );
});

const waitAnswering = Effect.fn("Bosun.waitAnswering")(function* (
  root: string,
  name: ServerName,
  runId: RunId,
  timeout: Duration.Duration,
) {
  const deadline = DateTime.addDuration(yield* DateTime.now, timeout);
  while (true) {
    const now = yield* status(root, name);
    if (now.state === "running") return now;
    if (now.state !== "starting" || now.run !== runId) {
      return yield* new ServerExitedError({
        name,
        run: runId,
        output: yield* runOutputOf(root, name, runId),
      });
    }
    if (DateTime.isGreaterThan(yield* DateTime.now, deadline))
      return yield* new StartTimeoutError({
        name,
        run: runId,
        seconds: Duration.toSeconds(timeout),
        output: yield* runOutputOf(root, name, runId),
      });
    yield* Effect.sleep(Duration.seconds(1));
  }
});

const stopRecorded = Effect.fn("Bosun.stopRecorded")(function* (
  root: string,
  name: ServerName,
  record: ServerRecord,
) {
  yield* signal(-record.group, "SIGTERM");
  const gone = Effect.all([groupAlive(record.group), runnerAlive(record)]).pipe(
    Effect.map(([group, runner]) => !group && !runner),
  );
  if (!(yield* waitUntil(gone, STOP_TIMEOUT))) {
    yield* Console.error(
      `warn  process group ${String(record.group)} ignored SIGTERM for ${String(Duration.toSeconds(STOP_TIMEOUT))}s; sending SIGKILL`,
    );
    yield* signal(-record.group, "SIGKILL");
    if (!(yield* waitUntil(gone, Duration.seconds(5))))
      return yield* new StopTimeoutError({ name, group: record.group });
  }
  yield* removeFiles(root, name);
});

export const start = Effect.fn("Bosun.start")(function* (
  root: string,
  name: ServerName,
  command: readonly [string, ...string[]],
  options: {
    readonly note: Option.Option<string>;
    readonly timeout: Duration.Duration;
  },
) {
  const { note, timeout } = options;
  const record = yield* readRecord(root, name);
  if (Option.isSome(record)) {
    const now = yield* status(root, name);
    if (now.state === "running" || now.state === "starting") {
      yield* Console.error(
        `ok    adopted the running ${name} server (pid ${String(record.value.pid)}, run ${record.value.run})`,
      );
      return yield* waitAnswering(root, name, record.value.run, timeout);
    }
    if (now.state === "orphaned") {
      yield* Console.error(
        `ok    stopping the orphaned ${name} server (group ${String(record.value.group)})`,
      );
      yield* stopRecorded(root, name, record.value);
    }
    yield* removeFiles(root, name);
  }

  const runId = newRunId();
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runner = yield* spawner.spawn(
    ChildProcess.make(
      "vpx",
      [
        process.argv[1] ?? "bosun.ts",
        "run",
        name,
        "--run",
        runId,
        ...Option.match(note, {
          onNone: () => [],
          onSome: (text) => ["--note", text],
        }),
        "--",
        ...command,
      ],
      {
        cwd: root,
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    ),
  );
  // The spawner kills a referenced child when the scope closes.
  yield* runner.unref;
  const recorded = readRecord(root, name).pipe(
    Effect.map((found) => Option.exists(found, (value) => value.run === runId)),
  );
  if (!(yield* waitUntil(recorded, RECORD_TIMEOUT)))
    return yield* new ServerExitedError({
      name,
      run: runId,
      output: yield* runOutputOf(root, name, runId),
    });
  yield* Console.error(`ok    started the ${name} server (run ${runId})`);
  return yield* waitAnswering(root, name, runId, timeout);
}, Effect.scoped);

export const stop = Effect.fn("Bosun.stop")(function* (
  root: string,
  name: ServerName,
) {
  const record = yield* readRecord(root, name);
  if (Option.isNone(record)) {
    yield* Console.error(`ok    no ${name} server running`);
    return false;
  }
  yield* stopRecorded(root, name, record.value);
  yield* Console.error(`ok    stopped the ${name} server`);
  return true;
});

export const logs = Effect.fn("Bosun.logs")(function* (
  root: string,
  name: ServerName,
  lines: number,
  follow: boolean,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const log = yield* at(root, files(name).log);
  // s6-log rotates by renaming `current`; -F reopens it by name.
  yield* spawner.exitCode(
    ChildProcess.make(
      "tail",
      [...(follow ? ["-F"] : []), "-n", String(lines), log],
      { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
    ),
  );
});
