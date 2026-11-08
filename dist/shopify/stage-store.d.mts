import { WebEnvironment } from "./web.mjs";
import { Server, ServerError } from "./server.mjs";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
export declare const stageStoreFile: (environment: WebEnvironment) => string;
export declare const stageStateDirectory: (stage: string) => string;
export declare const staleStageReason: (stage: {
  readonly exists: boolean;
  readonly store: Option.Option<string>;
}, store: string) => Option.Option<string>;
export declare const recordedStore: (server: Server) => Effect.Effect<Option.Option<string>, never, FileSystem.FileSystem>;
export declare const recordStore: (server: Server) => Effect.Effect<void, import("effect/PlatformError").PlatformError, FileSystem.FileSystem>;
/** `alchemy destroy` of the server's stage: local state and data only, nothing in the cloud. */
export declare const destroyStage: (server: Server) => Effect.Effect<undefined, import("effect/PlatformError").PlatformError | ServerError, ChildProcessSpawner.ChildProcessSpawner>;
export declare const resetStaleStage: (server: Server) => Effect.Effect<void, import("effect/PlatformError").PlatformError | ServerError, ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem>;