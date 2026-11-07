import { App } from "../core/app.mjs";
import { WebEnvironment } from "./web.mjs";
import { Lease } from "./berth.mjs";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Option from "effect/Option";
import * as Duration from "effect/Duration";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
/**
 * How long {@link tunnelReady} waits in all: longer than the 60 s negative TTL, so a system lookup
 * made too early by anything else (a browser, the CLI) has expired by the end.
 */
export declare const TUNNEL_READY_TIMEOUT: Duration.Duration;
/**
 * A quick tunnel whose `cloudflared` is gone answers every request with Cloudflare's 530; any other
 * status is the server behind it answering. No answer at all proves nothing either way.
 */
export declare const tunnelServes: (status: number) => boolean;
export declare const TunnelPhase: Schema.Literals<readonly ["resolve", "answer"]>;
export type TunnelPhase = typeof TunnelPhase.Type;
export declare const tunnelErrorMessage: (failure: {
  readonly phase: TunnelPhase;
  readonly url: string;
  readonly lastSeen: string;
  readonly waited: Duration.Duration;
}) => string;
declare const TunnelError_base: Schema.Class<TunnelError, Schema.TaggedStruct<"TunnelError", {
  readonly phase: Schema.Literals<readonly ["resolve", "answer"]>;
  readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
export declare class TunnelError extends TunnelError_base {}
export declare const TunnelState: Schema.Literals<readonly ["ready", "not resolving", "not answering"]>;
export type TunnelState = typeof TunnelState.Type;
/** The system resolver is asked (by `fetch`) only once public DNS has the name; see {@link PUBLIC_RESOLVERS}. */
export declare const tunnelState: (url: string) => Effect.Effect<"not answering" | "not resolving" | "ready", never, never>;
export declare const tunnelReady: (url: string, timeout?: Duration.Duration | undefined) => Effect.Effect<Duration.Duration, TunnelError, never>;
declare const ServerError_base: Schema.Class<ServerError, Schema.TaggedStruct<"ServerError", {
  readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
export declare class ServerError extends ServerError_base {}
export declare const START: Record<WebEnvironment, string>;
declare const ServerNotRunningError_base: Schema.Class<ServerNotRunningError, Schema.TaggedStruct<"ServerNotRunningError", {
  readonly environment: Schema.String;
  readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
export declare class ServerNotRunningError extends ServerNotRunningError_base {}
export interface Server extends Lease {
  readonly environment: WebEnvironment;
  readonly stage: string;
}
export declare const loadServer: (environment: "dev" | "e2e") => Effect.Effect<{
  store: string;
  config: string;
  environment: "dev" | "e2e";
  stage: `dev-${string}` | `e2e-${string}` | `test-${string}`;
}, ServerError, ChildProcessSpawner.ChildProcessSpawner>;
declare const BosunStatus: Schema.Struct<{
  readonly state: Schema.Literals<readonly ["running", "starting", "stopped", "orphaned"]>;
  readonly port: Schema.NullOr<Schema.Int>;
  readonly url: Schema.NullOr<Schema.String>;
  readonly startedAt: Schema.NullOr<Schema.String>;
  readonly log: Schema.String;
}>;
type BosunStatus = typeof BosunStatus.Type;
declare const PortTakenError_base: Schema.Class<PortTakenError, Schema.TaggedStruct<"PortTakenError", {
  readonly report: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * bosun refused the start: another process holds the port the server published. Shopify CLI
 * probes a free port, releases it and hands it to the web command, which binds it later, so
 * another process can take it in between. A new start gets a new port.
 */
export declare class PortTakenError extends PortTakenError_base {
  get message(): string;
}
export declare const bosunOutput: (args: readonly string[], stdout: string) => Result.Failure<never, PortTakenError | ServerError> | Result.Failure<{
  readonly state: "orphaned" | "running" | "starting" | "stopped";
  readonly port: number | null;
  readonly url: string | null;
  readonly startedAt: string | null;
  readonly log: string;
}, never> | Result.Success<never, PortTakenError | ServerError> | Result.Success<{
  readonly state: "orphaned" | "running" | "starting" | "stopped";
  readonly port: number | null;
  readonly url: string | null;
  readonly startedAt: string | null;
  readonly log: string;
}, never>;
/** Starts again while bosun refuses a start because another process took its port. */
export declare const retryPortTaken: <A, E, R>(start: Effect.Effect<A, E | PortTakenError, R>) => Effect.Effect<A, E | PortTakenError, R>;
export interface RunningServer {
  readonly port: number;
  readonly url: Option.Option<string>;
  readonly startedAt: Option.Option<Date>;
  readonly log: string;
}
export declare const runningOf: (status: BosunStatus) => Option.Option<RunningServer>;
export declare const runningServer: (environment: "dev" | "e2e") => Effect.Effect<RunningServer, PortTakenError | ServerError | ServerNotRunningError, ChildProcessSpawner.ChildProcessSpawner>;
/**
 * For configs that cannot run an effect (Playwright's). A config passes
 * `app(import.meta.dirname)`, so the status is the config's app's even when another directory
 * loads the config.
 */
export declare const runningServerSync: (environment: WebEnvironment, { root }?: App) => RunningServer;
/**
 * Without `BACKEND_PORT`, the CLI picks the web port itself, and a start whose port another
 * process took in the meantime starts again ({@link PortTakenError}). GraphiQL is off: its server prefers port 3457, so two servers
 * starting at once would both take it and the second would exit with `EADDRINUSE`.
 */
export declare const startServer: (server: Server) => Effect.Effect<RunningServer, PortTakenError | ServerError | ServerNotRunningError, ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem>;
export declare const stopServer: (environment: "dev" | "e2e") => Effect.Effect<undefined, ServerError, ChildProcessSpawner.ChildProcessSpawner>;
export declare const step: <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
export declare const loadClientId: Effect.Effect<string, ServerError, FileSystem.FileSystem>;
export declare const adminUrl: (store: string, clientId: string) => string;
export declare const describeRunning: (server: Server, running: RunningServer) => Effect.Effect<string, never, FileSystem.FileSystem>;
export declare const statusReport: (server: Server) => Effect.Effect<{
  running: Option.Option<RunningServer>;
  tunnelState: string | null;
  json: {
    state: "orphaned" | "running" | "starting" | "stopped";
    port: number | null;
    url: string | null;
    startedAt: string | null;
    log: string;
    stage: string;
    store: string;
    tunnelState: string | null;
  };
  text: string;
}, PortTakenError | ServerError, ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem>;
export { BosunStatus };