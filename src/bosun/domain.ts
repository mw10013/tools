/**
 * A server is one long-lived command per checkout and name, run in the
 * foreground by `bosun run`, its runner. Each actor owns its own file under
 * `.bosun/<name>/`, so no two write the same one:
 *
 * - `record.json`: the runner's {@link ServerRecord}, from launch to exit.
 * - `endpoint.json`: the server's {@link Endpoint}, written by the
 *   command itself once it knows its port, through `BOSUN_ENDPOINT`.
 *
 * @module
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const ServerName = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]*$/u),
).pipe(Schema.brand("ServerName"));
export type ServerName = typeof ServerName.Type;

export const RunId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}$/u),
).pipe(Schema.brand("RunId"));
export type RunId = typeof RunId.Type;

const Pid = Schema.Int.check(Schema.isGreaterThan(0));

export const ServerRecord = Schema.Struct({
  bosun: Schema.Literal(1),
  name: ServerName,
  run: RunId,
  /** The runner, `bosun run`. */
  pid: Pid,
  /** The command's process group; the command leads it. */
  group: Pid,
  startedAt: Schema.String,
  command: Schema.Array(Schema.String),
});
export type ServerRecord = typeof ServerRecord.Type;

export const Endpoint = Schema.Struct({
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  url: Schema.optional(Schema.String),
});
export type Endpoint = typeof Endpoint.Type;

export const ServerRecordJson = Schema.fromJsonString(ServerRecord);
export const EndpointJson = Schema.fromJsonString(Endpoint);

/** bosun owns `.bosun/` in each checkout; its `.gitignore` keeps the folder out of git. */
export const BOSUN_DIRECTORY = ".bosun";

export const files = (name: ServerName) => ({
  directory: `${BOSUN_DIRECTORY}/${name}`,
  record: `${BOSUN_DIRECTORY}/${name}/record.json`,
  endpoint: `${BOSUN_DIRECTORY}/${name}/endpoint.json`,
  logDirectory: `${BOSUN_DIRECTORY}/${name}/log`,
  log: `${BOSUN_DIRECTORY}/${name}/log/current`,
});

const MARKER = "====";

export const startMarker = (
  name: ServerName,
  run: RunId,
  at: string,
  note: Option.Option<string>,
) =>
  [MARKER, name, "start", at, `run=${run}`, ...Option.toArray(note)].join(" ");

export type Ending =
  | { readonly _tag: "Exited"; readonly code: number }
  | { readonly _tag: "Signaled"; readonly signal: string }
  | { readonly _tag: "Interrupted" };

export const exitMarker = (name: ServerName, run: RunId, ending: Ending) =>
  [
    MARKER,
    name,
    "exit",
    `run=${run}`,
    ending._tag === "Exited"
      ? `code=${String(ending.code)}`
      : ending._tag === "Signaled"
        ? `signal=${ending.signal}`
        : "interrupted",
  ].join(" ");

const RUN_OUTPUT_LINES = 60;

/** `s6-log` puts a timestamp before each line, so a marker is found inside the line, not at its start. */
export const runOutput = (
  log: string,
  name: ServerName,
  run: RunId,
): Option.Option<string> => {
  const lines = log.split("\n");
  const start = lines.findIndex(
    (line) =>
      line.includes(`${MARKER} ${name} start `) && line.includes(`run=${run}`),
  );
  if (start === -1) return Option.none();
  const after = lines.slice(start + 1);
  const end = after.findIndex((line) =>
    line.includes(`${MARKER} ${name} exit run=${run} `),
  );
  const body = (end === -1 ? after : after.slice(0, end + 1)).filter(
    (line) => line.trim() !== "",
  );
  return body.length === 0
    ? Option.none()
    : Option.some(body.slice(-RUN_OUTPUT_LINES).join("\n"));
};

/**
 * Who listens on the server's published port. A command may start its listener detached, in a
 * process group of its own (Alchemy does), so the server is the command and its descendants,
 * not its group.
 */
export type PortListener =
  | { readonly _tag: "Free" }
  | { readonly _tag: "Server" }
  | { readonly _tag: "Taken"; readonly pids: readonly number[] };

/** Deeper than any real process tree; it ends the walk should `parents` hold a cycle. */
const MAX_ANCESTRY = 256;

const descends = (
  pid: number,
  ancestor: number,
  parents: ReadonlyMap<number, number>,
) => {
  let current: number | undefined = pid;
  for (let step = 0; current !== undefined && step < MAX_ANCESTRY; step++) {
    if (current === ancestor) return true;
    if (current <= 1) return false;
    current = parents.get(current);
  }
  return false;
};

/**
 * Reads the port's listening pids against the process table (`parents`, pid to parent pid). A
 * pid missing from the table exited after it was listed, so it holds nothing.
 */
export const listenerOf = (
  listening: readonly number[],
  parents: ReadonlyMap<number, number>,
  command: number,
): PortListener => {
  const live = listening.filter((pid) => parents.has(pid));
  if (live.length === 0) return { _tag: "Free" };
  const foreign = live.filter((pid) => !descends(pid, command, parents));
  return foreign.length === 0
    ? { _tag: "Server" }
    : { _tag: "Taken", pids: foreign };
};

export const ServerState = Schema.Literals([
  "running",
  "starting",
  "stopped",
  "orphaned",
]);
export type ServerState = typeof ServerState.Type;

export interface Sighting {
  readonly runner: boolean;
  readonly group: boolean;
  /** The server itself listens on its published port and answers HTTP there. */
  readonly answering: boolean;
}

export const stateOf = (
  record: Option.Option<ServerRecord>,
  seen: Sighting,
): ServerState => {
  if (Option.isNone(record)) return "stopped";
  if (!seen.runner) return seen.group ? "orphaned" : "stopped";
  return seen.answering ? "running" : "starting";
};
