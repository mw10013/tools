import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
declare const CommandError_base: Schema.Class<CommandError, Schema.TaggedStruct<"CommandError", {
  readonly message: Schema.String;
  readonly cause: Schema.optionalKey<Schema.Defect>;
}>, import("effect/Cause").YieldableError>;
export declare class CommandError extends CommandError_base {}
/** Fails on a non-zero exit, which `spawner.string` does not check. */
export declare const runCommand: (command: string, args: readonly string[], input?: string | undefined, env?: Record<string, string> | undefined) => Effect.Effect<string, CommandError, ChildProcessSpawner.ChildProcessSpawner>;
export {};