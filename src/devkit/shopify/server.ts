/**
 * This checkout's dev and e2e servers. bosun runs each (`~/projects/tools/docs/bosun.md`): one
 * Shopify CLI `app dev` per environment, detached, logged to `.bosun/<environment>/log/current`. The
 * CLI picks the port and opens the tunnel; the web command (`dev:alchemy`) publishes both to bosun,
 * so every script that needs the server asks bosun where it is ({@link runningServer}).
 *
 * @module
 */
import * as Array from "effect/Array";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { spawnSync } from "node:child_process";
import { Resolver } from "node:dns/promises";
import path from "node:path";

import { ROOT } from "#devkit/core/app.ts";
import * as Berth from "./berth.ts";
import type { WebEnvironment } from "./web.ts";
import { stage } from "./worktree.ts";

/**
 * Resolvers that hold no negative answer for a tunnel hostname that is not in DNS yet. A new quick
 * tunnel's name is in public DNS by the time the CLI prints it, but a lookup through the system
 * resolver made a moment earlier caches "not found" for the negative TTL (60 s on Cloudflare's
 * resolvers), and every load through the system resolver fails until it expires. So the system
 * resolver is not asked until these have the name.
 */
const PUBLIC_RESOLVERS = ["1.1.1.1", "8.8.8.8"];

/**
 * How long {@link tunnelReady} waits in all: longer than the 60 s negative TTL, so a system lookup
 * made too early by anything else (a browser, the CLI) has expired by the end.
 */
export const TUNNEL_READY_TIMEOUT = Duration.seconds(90);

/**
 * A quick tunnel whose `cloudflared` is gone answers every request with Cloudflare's 530; any other
 * status is the server behind it answering. No answer at all proves nothing either way.
 */
export const tunnelServes = (status: number) => status !== 530;

/** Which half of {@link tunnelReady} failed: the public DNS lookup, or `/` through the tunnel. */
export const TunnelPhase = Schema.Literals(["resolve", "answer"]);
export type TunnelPhase = typeof TunnelPhase.Type;

/**
 * What {@link TunnelError} says: which half failed, after how long, and what was seen last (a
 * lookup error code, or the HTTP status or fetch error through the tunnel).
 */
export const tunnelErrorMessage = (failure: {
  readonly phase: TunnelPhase;
  readonly url: string;
  readonly lastSeen: string;
  readonly waited: Duration.Duration;
}) => {
  const waited = `${String(Math.round(Duration.toSeconds(failure.waited)))}s`;
  return failure.phase === "resolve"
    ? `the tunnel ${failure.url} does not resolve on public DNS after ${waited} (last: ${failure.lastSeen})`
    : `the tunnel ${failure.url} resolves but / does not answer through it after ${waited} (last: ${failure.lastSeen})`;
};

export class TunnelError extends Schema.TaggedError<TunnelError>()(
  "TunnelError",
  {
    phase: TunnelPhase,
    message: Schema.String,
  },
) {}

const describeCause = (cause: unknown) =>
  cause instanceof Error
    ? "code" in cause && typeof cause.code === "string"
      ? cause.code
      : cause.message
    : String(cause);

/** One lookup of `hostname` on {@link PUBLIC_RESOLVERS}; fails with what was seen. */
const resolvePublic = (hostname: string) =>
  Effect.tryPromise({
    try: () => {
      const resolver = new Resolver({ timeout: 2000, tries: 1 });
      resolver.setServers(PUBLIC_RESOLVERS);
      return resolver.resolve4(hostname);
    },
    catch: describeCause,
  });

/** One `GET /` through the tunnel; succeeds with the status, fails with what was seen. */
const fetchThrough = (url: string) =>
  Effect.tryPromise({
    try: () =>
      fetch(new URL("/", url), {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      }),
    catch: describeCause,
  }).pipe(Effect.map((response) => response.status));

/** What a single look at a tunnel found; see {@link tunnelState}. */
export const TunnelState = Schema.Literals([
  "ready",
  "not resolving",
  "not answering",
]);
export type TunnelState = typeof TunnelState.Type;

/**
 * A single look at the tunnel, {@link tunnelReady}'s two halves once each without waiting, for a
 * status report: the system resolver is asked (by `fetch`) only once public DNS has the name.
 */
export const tunnelState = Effect.fn("Server.tunnelState")(function* (
  url: string,
) {
  if (Option.isNone(yield* Effect.option(resolvePublic(new URL(url).hostname))))
    return "not resolving" satisfies TunnelState;
  const status = yield* Effect.option(fetchThrough(url));
  return Option.exists(status, tunnelServes)
    ? "ready"
    : ("not answering" satisfies TunnelState);
});

/**
 * Waits until the tunnel serves: first until {@link PUBLIC_RESOLVERS} resolve its hostname, then
 * until `/` through it answers with anything {@link tunnelServes} accepts, polling each every
 * second within {@link TUNNEL_READY_TIMEOUT} for both. Succeeds with the time it took.
 */
export const tunnelReady = Effect.fn("Server.tunnelReady")(function* (
  url: string,
  timeout: Duration.Duration = TUNNEL_READY_TIMEOUT,
) {
  const started = yield* DateTime.now;
  const elapsed = Effect.map(DateTime.now, (now) =>
    DateTime.distance(started, now),
  );
  const poll = <A>(attempt: Effect.Effect<A, string>, phase: TunnelPhase) =>
    Effect.gen(function* () {
      const remaining = Duration.max(
        Duration.zero,
        Duration.subtract(timeout, yield* elapsed),
      );
      return yield* attempt.pipe(
        Effect.retry(
          Schedule.max([
            Schedule.spaced("1 second"),
            Schedule.during(remaining),
          ]),
        ),
        Effect.catch((error) =>
          Effect.flatMap(elapsed, (waited) =>
            Effect.fail(
              new TunnelError({
                phase,
                message: tunnelErrorMessage({
                  phase,
                  url,
                  lastSeen: error,
                  waited,
                }),
              }),
            ),
          ),
        ),
      );
    });
  yield* poll(resolvePublic(new URL(url).hostname), "resolve");
  yield* poll(
    fetchThrough(url).pipe(
      Effect.filterOrFail(tunnelServes, (status) => `HTTP ${String(status)}`),
    ),
    "answer",
  );
  return yield* elapsed;
});

/** This checkout's root, where both servers run and where every path below is relative to. */

export class ServerError extends Schema.TaggedError<ServerError>()(
  "ServerError",
  {
    message: Schema.String,
  },
) {}

const fail = (message: string) => new ServerError({ message });

export const START: Record<WebEnvironment, string> = {
  dev: "vp run dev",
  e2e: "vp run e2e:start",
};

export class ServerNotRunningError extends Schema.TaggedError<ServerNotRunningError>()(
  "ServerNotRunningError",
  { environment: Schema.String, message: Schema.String },
) {}

const notRunning = (environment: WebEnvironment) =>
  new ServerNotRunningError({
    environment,
    message: `the ${environment} server is not running: ${START[environment]}`,
  });

/** An environment's server: its lease's store and app config, and its stage. */
export interface Server extends Berth.Lease {
  readonly environment: WebEnvironment;
  readonly stage: string;
}

export const loadServer = Effect.fn("Server.loadServer")(function* (
  environment: WebEnvironment,
) {
  const lease = yield* Berth.acquire(environment).pipe(
    Effect.mapError((error) => fail(error.message)),
  );
  return {
    environment,
    ...lease,
    stage: yield* stage(environment).pipe(
      Effect.mapError((error) => fail(error.message)),
    ),
  } satisfies Server;
});

const BosunState = Schema.Literals([
  "running",
  "starting",
  "stopped",
  "orphaned",
]);

/** The fields of bosun's status JSON that the app reads. */
const BosunStatus = Schema.Struct({
  state: BosunState,
  port: Schema.NullOr(Schema.Int),
  url: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.String),
  log: Schema.String,
});
export type BosunStatus = typeof BosunStatus.Type;

const BosunFailure = Schema.Struct({
  error: Schema.Struct({ _tag: Schema.String, message: Schema.String }),
});

const decodeBosunOutput = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Union([BosunStatus, BosunFailure])),
);

/** bosun's stdout, a status or a typed failure; anything else is a failure naming the command. */
export const bosunOutput = (args: readonly string[], stdout: string) => {
  const output = decodeBosunOutput(stdout);
  if (Result.isFailure(output))
    return Result.fail(
      fail(`bosun ${args.join(" ")} printed no status; its stderr says why`),
    );
  const value = output.success;
  return "error" in value
    ? Result.fail(fail(value.error.message))
    : Result.succeed(value);
};

const bosun = Effect.fn("Server.bosun")(function* (args: readonly string[]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const notFound = () =>
    fail("bosun did not run: install its shim, ~/.local/bin/bosun");
  const handle = yield* spawner
    .spawn(
      ChildProcess.make("bosun", [...args], {
        cwd: ROOT,
        stdin: "ignore",
        stderr: "inherit",
      }),
    )
    .pipe(Effect.mapError(notFound));
  const stdout = yield* Stream.mkString(Stream.decodeText(handle.stdout)).pipe(
    Effect.mapError(notFound),
  );
  yield* handle.exitCode.pipe(Effect.mapError(notFound));
  return yield* Effect.fromResult(bosunOutput(args, stdout));
}, Effect.scoped);

const serverStatus = (environment: WebEnvironment) =>
  bosun(["status", environment]);

/** A server that answers: its local port, its tunnel, and when it started. */
export interface RunningServer {
  readonly port: number;
  readonly url: Option.Option<string>;
  readonly startedAt: Option.Option<Date>;
  readonly log: string;
}

/** The {@link RunningServer} a status describes, or none when the server does not answer. */
export const runningOf = (status: BosunStatus): Option.Option<RunningServer> =>
  status.state === "running" && status.port !== null
    ? Option.some({
        port: status.port,
        url: Option.filter(Option.fromNullOr(status.url), (url) => url !== ""),
        startedAt: Option.fromNullOr(status.startedAt).pipe(
          Option.map((at) => new Date(at)),
          Option.filter((at) => !Number.isNaN(at.getTime())),
        ),
        log: status.log,
      })
    : Option.none();

/** The environment's server as bosun sees it; fails with the command that starts it otherwise. */
export const runningServer = Effect.fn("Server.runningServer")(function* (
  environment: WebEnvironment,
) {
  return yield* Effect.fromOption(
    runningOf(yield* serverStatus(environment)),
  ).pipe(Effect.mapError(() => notRunning(environment)));
});

/** {@link runningServer} for configs that cannot run an effect (Playwright's); throws its message. */
export const runningServerSync = (
  environment: WebEnvironment,
): RunningServer => {
  const args = ["status", environment];
  const run = spawnSync("bosun", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (run.error !== undefined)
    throw new Error("bosun did not run: install its shim");
  const status = Result.getOrThrowWith(
    bosunOutput(args, run.stdout),
    (e) => new Error(e.message),
  );
  return Option.getOrThrowWith(
    runningOf(status),
    () => new Error(notRunning(environment).message),
  );
};

/**
 * The app's one config. The e2e lease names another file, which a start writes as a fresh copy of
 * this one: Shopify CLI 5.0 runs one `shopify app dev` per directory and config file name, and the
 * copy keeps one definition of the app.
 */
const APP_CONFIG = "shopify.app.toml";

/**
 * Starts the server, or adopts the one running, and waits until it answers. Without `BACKEND_PORT`,
 * the CLI picks the web port itself. GraphiQL is off: its server prefers port 3457, so two servers
 * starting at once would both take it and the second would exit with `EADDRINUSE`.
 */
export const startServer = Effect.fn("Server.startServer")(function* (
  server: Server,
) {
  if (server.config !== APP_CONFIG) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs
      .copyFile(path.join(ROOT, APP_CONFIG), path.join(ROOT, server.config))
      .pipe(Effect.mapError((error) => fail(error.message)));
  }
  const status = yield* bosun([
    "start",
    server.environment,
    "--note",
    `stage=${server.stage} store=${server.store}`,
    "--",
    "env",
    `SANDBOX_ENVIRONMENT=${server.environment}`,
    "SHOPIFY_CLI_DISABLE_GRAPHIQL=1",
    "shopify",
    "app",
    "dev",
    "--config",
    server.config,
    "--store",
    server.store,
  ]);
  return yield* Effect.fromOption(runningOf(status)).pipe(
    Effect.mapError(() => notRunning(server.environment)),
  );
});

export const stopServer = Effect.fn("Server.stopServer")(function* (
  environment: WebEnvironment,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const code = yield* spawner
    .exitCode(
      ChildProcess.make("bosun", ["stop", environment], {
        cwd: ROOT,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "inherit",
      }),
    )
    .pipe(
      Effect.mapError(() =>
        fail("bosun did not run: install its shim, ~/.local/bin/bosun"),
      ),
    );
  if (code !== ChildProcessSpawner.ExitCode(0))
    return yield* fail(`bosun stop ${environment} exited ${String(code)}`);
});

/** One line per step with its duration; a failing step says so before its error. */
export const step = Effect.fn("Server.step")(function* <A, E, R>(
  label: string,
  effect: Effect.Effect<A, E, R>,
) {
  const started = yield* DateTime.now;
  const took = Effect.map(
    DateTime.now,
    (now) =>
      `${Duration.toSeconds(DateTime.distance(started, now)).toFixed(1)}s`,
  );
  const result = yield* effect.pipe(
    Effect.tapError(() =>
      Effect.flatMap(took, (time) => Console.log(`fail  ${label} (${time})`)),
    ),
  );
  yield* Console.log(`ok    ${label} (${yield* took})`);
  return result;
});

const ClientId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u));
const ClientIdLine = Schema.TemplateLiteralParser([
  'client_id = "',
  ClientId,
  '"',
]);
const decodeClientIdLine = Schema.decodeUnknownOption(ClientIdLine);

/** The app's client id, from the `client_id = "…"` line of `shopify.app.toml`. */
export const loadClientId = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const toml = yield* fs
    .readFileString(path.join(ROOT, "shopify.app.toml"))
    .pipe(Effect.mapError(() => fail("shopify.app.toml is missing")));
  return yield* Effect.fromOption(
    Array.findFirst(toml.split("\n"), (line) =>
      Option.map(decodeClientIdLine(line.trim()), ([, id]) => id),
    ),
  ).pipe(
    Effect.mapError(() =>
      fail('shopify.app.toml has no client_id = "<32 hex>" line'),
    ),
  );
});

/** The app inside the store's admin, the URL a person opens to see the embedded App Home. */
export const adminUrl = (store: string, clientId: string) =>
  `https://admin.shopify.com/store/${store}/apps/${clientId}`;

export const describeRunning = Effect.fn("Server.describeRunning")(function* (
  server: Server,
  running: RunningServer,
) {
  const clientId = yield* loadClientId.pipe(Effect.option);
  return [
    `local:   http://localhost:${String(running.port)}`,
    `tunnel:  ${Option.getOrElse(running.url, () => "(none)")}`,
    `app:     ${Option.match(clientId, { onNone: () => "(no client_id in shopify.app.toml)", onSome: (id) => adminUrl(server.store, id) })}`,
    `logs:    ${running.log}`,
  ].join("\n");
});

/**
 * What `dev:status` and `e2e:status` report: bosun's status, the stage and store, and one look at
 * the tunnel ({@link tunnelState}). Read-only.
 */
export const statusReport = Effect.fn("Server.statusReport")(function* (
  server: Server,
) {
  const status = yield* serverStatus(server.environment);
  const running = runningOf(status);
  const tunnel = Option.flatMap(running, (live) => live.url);
  const tunnelSeen = Option.isSome(tunnel)
    ? yield* tunnelState(tunnel.value)
    : null;
  const lines = [
    `state:   ${status.state}`,
    `stage:   ${server.stage}`,
    `store:   ${server.store}`,
    ...(Option.isSome(running)
      ? [
          `started: ${status.startedAt ?? "(unknown)"}`,
          yield* describeRunning(server, running.value),
          `tunnel state: ${tunnelSeen ?? "(no tunnel)"}`,
        ]
      : [`start it: ${START[server.environment]}`]),
  ];
  return {
    running,
    tunnelState: tunnelSeen,
    json: {
      ...status,
      stage: server.stage,
      store: server.store,
      tunnelState: tunnelSeen,
    },
    text: lines.join("\n"),
  };
});
