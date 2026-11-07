import { Deployed, STAGE_RUN } from "./stage.mjs";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
/**
 * The stack's state store, chosen by the stage's environment. State lives where the resources
 * live: `dev`, `test` and `e2e` run in workerd and its simulators, so their state is local under
 * `.alchemy/`; `staging` and `production` run in Cloudflare, so their state does too, behind
 * {@link guardDeployedRun}.
 *
 * `Test.make`'s own `state` option is built outside the stage, so integ files pass none and use
 * this layer from the stack.
 */
export declare const stageState: Layer.Layer<import("alchemy/State/State").State, never, Alchemy.AuthProviders | import("effect/process/ChildProcessSpawner").ChildProcessSpawner | import("effect/FileSystem").FileSystem | import("effect/http/HttpClient").HttpClient | import("alchemy/Interaction").Interaction | import("effect/Path").Path | Alchemy.Stage>;
declare const UnsafeNukeRefusedError_base: Schema.Class<UnsafeNukeRefusedError, Schema.TaggedStruct<"UnsafeNukeRefusedError", {}>, import("effect/Cause").YieldableError>;
export declare class UnsafeNukeRefusedError extends UnsafeNukeRefusedError_base {
  get message(): string;
}
/** Dies when this process is `alchemy unsafe nuke`. */
export declare const refuseUnsafeNuke: Effect.Effect<void>;
/**
 * The `providers` option of every app stack: Cloudflare's, behind
 * {@link refuseUnsafeNuke}. Nuke builds a stack's providers and nothing else, no stage and no
 * state store (Alchemy's `src/Alchemist/Nuke.ts`), so {@link guardDeployedRun} never runs, and it
 * deletes across the whole account, not one stage.
 */
export declare const stageProviders: ReturnType<typeof Cloudflare.providers>;
/**
 * The `secrets` option of every app stack. A per-developer stage reads `.env`, then the shell. A
 * {@link Deployed} stage reads no file: Workers Builds puts its trigger's variables in the shell. Its list
 * is empty rather than `ProcessEnv({ disabled: true })` because Alchemy appends the shell to any
 * list that does not name it, and the providers are built under the same configuration, so the
 * shell is where Workers Builds hands the deploy its Cloudflare credentials.
 *
 * Declaring `secrets` also makes `--env-file` a hard error, so no flag can bring a file back.
 */
export declare const deployedSecrets: Alchemy.StackSecrets;
/**
 * The variables a run on a {@link Deployed} stage is judged by, in an environment such as
 * `process.env`. The index signature takes any `@types/node`'s `ProcessEnv`: one that declares a
 * named variable (25.x declares `TZ`) shares no property with these, which TypeScript refuses.
 */
export interface DeployedRunEnv {
  readonly [name: string]: string | undefined;
  readonly WORKERS_CI?: string | undefined;
  readonly WORKERS_CI_BRANCH?: string | undefined;
  readonly [STAGE_RUN]?: string | undefined;
}
/** Alchemy's CLI commands, as its `src/Cli/main.ts` lists them. */
declare const AlchemyCommand: Schema.Literals<readonly ["provider", "deploy", "dev", "destroy", "plan", "logs", "profile", "state", "drift", "unsafe"]>;
type AlchemyCommand = typeof AlchemyCommand.Type;
/**
 * The command Alchemy's CLI runs for `argv`, `undefined` outside its CLI. Alchemy picks it the
 * same way, as the first argument naming a command, so the two cannot disagree.
 *
 * @see `requestedCommand` in Alchemy's `src/Cli/main.ts`
 */
export declare const alchemyCommandOf: (argv: readonly string[]) => AlchemyCommand | undefined;
/**
 * Why Alchemy must not run `command` on `stage` here, or `None`. Workers Builds deploys the stage
 * from its branch; the `stage` CLI names its reason in {@link STAGE_RUN}; each may run only what
 * {@link permits} gives it. Anywhere else a deploy would ship whatever the checkout holds, not
 * what the branch holds (`up` deploys only from a clean checkout at the branch), and a destroy
 * would delete the stage's data.
 */
export declare const deployedRunRefusal: (stage: Deployed, command: AlchemyCommand | undefined, env: DeployedRunEnv) => Option.Option<string>;
declare const DeployedRunRefusedError_base: Schema.Class<DeployedRunRefusedError, Schema.TaggedStruct<"DeployedRunRefusedError", {
  readonly reason: Schema.String;
}>, import("effect/Cause").YieldableError>;
export declare class DeployedRunRefusedError extends DeployedRunRefusedError_base {
  get message(): string;
}
/**
 * Dies on a {@link Deployed} stage unless {@link deployedRunRefusal} allows this process's Alchemy
 * command. {@link stageState} runs it as it builds; a stack with another store runs it the same way.
 */
export declare const guardDeployedRun: Effect.Effect<void, never, Alchemy.Stage>;
/**
 * An app's deployed-stage fields, the default export of `stacks/stage-env.ts`: one field per
 * variable, named after it, a secret as `Schema.Redacted(...)`, one only some stages set as
 * `Schema.optional(...)` or `Schema.optionalKey(...)`. Each decodes from the variable's string with
 * no services.
 */
export type StageFields = Schema.Struct<Schema.Struct.Fields> & Schema.Codec<unknown>;
/**
 * One field as `Config` reads it from an environment. `Absent` is an optional field with no
 * value, which `Config` takes an empty string to be; a required field with none is `Invalid`.
 * `Set` holds the raw string, a secret when the field decodes to a `Redacted`.
 */
export type StageFieldEnv = {
  readonly _tag: "Absent";
  readonly name: string;
} | {
  readonly _tag: "Invalid";
  readonly name: string;
} | {
  readonly _tag: "Set";
  readonly name: string;
  readonly value: Redacted.Redacted;
  readonly secret: boolean;
};
/**
 * Parses each of `fields` from `env` as `Config` reads it in a Worker. A parse failure's own
 * message can quote the value, a secret included, so an invalid field carries only its name.
 */
export declare const checkStageEnv: (fields: StageFields, env: Readonly<Record<string, string | undefined>>) => Effect.Effect<readonly StageFieldEnv[]>;
declare const StageEnvMissingError_base: Schema.Class<StageEnvMissingError, Schema.TaggedStruct<"StageEnvMissingError", {
  readonly stage: Schema.Literals<readonly ["staging", "production"]>;
  readonly names: Schema.$Array<Schema.String>;
}>, import("effect/Cause").YieldableError>;
export declare class StageEnvMissingError extends StageEnvMissingError_base {
  get message(): string;
}
/**
 * The app stack's first step. On a {@link Deployed} stage it dies unless the environment holds
 * every required one of `fields` and each optional one it holds is valid, so a Builds deploy
 * missing a trigger variable fails instead of binding nothing where a Worker reads `Config.option`.
 *
 * @example
 * export default Alchemy.Stack("app", { providers: stageProviders, state: stageState, secrets: deployedSecrets },
 *   Effect.gen(function* () {
 *     yield* requireStageEnv(StageEnv);
 *     // ...
 *   }),
 * );
 */
export declare const requireStageEnv: (fields: StageFields) => Effect.Effect<void, never, Alchemy.Stage>;
export { AlchemyCommand };