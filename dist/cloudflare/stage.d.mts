import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
declare global {
  var __ALCHEMY_RUNTIME__: boolean | undefined;
}
/** The environments with one stage per developer and checkout; deployed stages are shared. */
export declare const PerDeveloper: Schema.Literals<readonly ["dev", "test", "e2e"]>;
export type PerDeveloper = typeof PerDeveloper.Type;
export declare const Deployed: Schema.Literals<readonly ["staging", "production"]>;
export type Deployed = typeof Deployed.Type;
/** The branch whose pushes deploy the stage. Production moves only by fast-forward from `main`. */
export declare const branchOf: (stage: Deployed) => "main" | "production";
/**
 * The variable the `stage` CLI sets on the Alchemy runs it starts on a {@link Deployed} stage
 * outside Workers Builds, naming why, so the stage's state store lets them through.
 */
export declare const STAGE_RUN = "DEVKIT_STAGE_RUN";
export declare const StageRun: Schema.Literals<readonly ["check", "reset", "up"]>;
export type StageRun = typeof StageRun.Type;
/** Only disposable deployed data may be destroyed by the reset command. */
export declare const ResettableDeployed: Schema.Literals<readonly ["staging"]>;
export type ResettableDeployed = typeof ResettableDeployed.Type;
export declare const Environment: Schema.Literals<readonly ["dev", "test", "e2e", "staging", "production"]>;
export type Environment = typeof Environment.Type;
/**
 * A per-developer stage's state and data live in its checkout's `.alchemy/`, so checkouts never
 * share one. Dashes, because Alchemy turns every other separator into `-` in physical names, so
 * the stage reads the same in the CLI, state, logs and Cloudflare.
 */
export declare const PerDeveloperStage: Schema.decodeTo<Schema.Struct<{
  readonly environment: Schema.Literals<readonly ["dev", "test", "e2e"]>;
  readonly user: Schema.String;
}>, Schema.TemplateLiteralParser<readonly [Schema.Literals<readonly ["dev", "test", "e2e"]>, "-", Schema.String]>, never, never>;
export type PerDeveloperStage = typeof PerDeveloperStage.Type;
/** Each integ file deploys and destroys its own, so files run side by side without sharing state, ports or data. */
export declare const TestFileStage: Schema.decodeTo<Schema.Struct<{
  readonly user: Schema.String;
  readonly suffix: Schema.String;
}>, Schema.TemplateLiteralParser<readonly [Schema.Literal<"test">, "-", Schema.String, "-", Schema.String]>, never, never>;
export type TestFileStage = typeof TestFileStage.Type;
declare const UnknownStageError_base: Schema.Class<UnknownStageError, Schema.TaggedStruct<"UnknownStageError", {
  readonly stage: Schema.String;
}>, import("effect/Cause").YieldableError>;
export declare class UnknownStageError extends UnknownStageError_base {
  get message(): string;
}
/**
 * An unknown stage dies rather than falling back: an environment not listed in {@link Environment}
 * is one nobody has thought through (its seed, its state store, its policy), a misconfiguration no
 * caller can act on.
 */
export declare const environmentOf: (stage: string) => Effect.Effect<Environment>;
/**
 * App `app`'s Worker name on a {@link Deployed} stage, `<app>-<worker>-<stage>`: fixed, so its
 * `workers.dev` URL and its log service name survive a destroy and redeploy. A per-developer
 * stage gets `undefined`, which keeps Alchemy's generated name: the integ files deploy the same
 * stack on the same stage side by side, and a fixed name would collide.
 *
 * Changing a deployed Worker's name replaces it, Durable Object storage included.
 */
export declare function workerNameOf(app: string, stage: Deployed, worker: "website" | "backend"): string;
export declare function workerNameOf(app: string, stage: string, worker: "website" | "backend"): string | undefined;
/**
 * Whether this code runs in a deployed bundle rather than while the stack is planned: Alchemy's
 * bundler folds `globalThis.__ALCHEMY_RUNTIME__` to `true` in every runtime artifact, so a branch
 * on it is dead code in the other phase.
 */
export declare const isAlchemyRuntime: () => boolean;
export {};