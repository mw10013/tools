/**
 * An environment is a role (`dev`, `test`, `e2e`, `staging`, `production`); a stage is one copy of the stack in
 * an environment. Never shortened to `env`, which already means `.env`, `process.env` and a
 * Worker's bindings.
 *
 * Imports only `effect`, so any bundle may carry it.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

declare global {
  // Alchemy declares the same in `alchemy/Phase`; repeated so devkit type-checks without Alchemy.
  // oxlint-disable-next-line no-underscore-dangle -- Alchemy's build-time flag
  var __ALCHEMY_RUNTIME__: boolean | undefined;
}

/** The environments with one stage per developer and checkout; deployed stages are shared. */
export const PerDeveloper = Schema.Literals(["dev", "test", "e2e"]);
export type PerDeveloper = typeof PerDeveloper.Type;

export const Deployed = Schema.Literals(["staging", "production"]);
export type Deployed = typeof Deployed.Type;

/** The branch whose pushes deploy the stage. Production moves only by fast-forward from `main`. */
export const branchOf = (stage: Deployed): "main" | "production" =>
  stage === "staging" ? "main" : "production";

/**
 * The variable the `stage` CLI sets on the Alchemy runs it starts on a {@link Deployed} stage
 * outside Workers Builds, naming why, so the stage's state store lets them through.
 */
export const STAGE_RUN = "DEVKIT_STAGE_RUN";

export const StageRun = Schema.Literals(["check", "reset", "up"]);
export type StageRun = typeof StageRun.Type;

/** Only disposable deployed data may be destroyed by the reset command. */
export const ResettableDeployed = Schema.Literals(["staging"]);
export type ResettableDeployed = typeof ResettableDeployed.Type;

export const Environment = Schema.Literals([
  ...PerDeveloper.literals,
  ...Deployed.literals,
]);
export type Environment = typeof Environment.Type;

/** Lowercase letters and digits, so a user never contains the `-` between a stage's parts. */
const User = Schema.String.check(Schema.isPattern(/^[a-z0-9]+$/u));

/**
 * A per-developer stage's state and data live in its checkout's `.alchemy/`, so checkouts never
 * share one. Dashes, because Alchemy turns every other separator into `-` in physical names, so
 * the stage reads the same in the CLI, state, logs and Cloudflare.
 */
export const PerDeveloperStage = Schema.TemplateLiteralParser([
  PerDeveloper,
  "-",
  User,
]).pipe(
  Schema.decodeTo(
    Schema.Struct({ environment: PerDeveloper, user: Schema.String }),
    SchemaTransformation.transform({
      decode: (parts) => ({ environment: parts[0], user: parts[2] }),
      encode: ({ environment, user }) => [environment, "-", user] as const,
    }),
  ),
);
export type PerDeveloperStage = typeof PerDeveloperStage.Type;

const TestFileSuffix = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9]*$/u),
);

/** Each integ file deploys and destroys its own, so files run side by side without sharing state, ports or data. */
export const TestFileStage = Schema.TemplateLiteralParser([
  Schema.Literal("test"),
  "-",
  User,
  "-",
  TestFileSuffix,
]).pipe(
  Schema.decodeTo(
    Schema.Struct({ user: Schema.String, suffix: Schema.String }),
    SchemaTransformation.transform({
      decode: (parts) => ({ user: parts[2], suffix: parts[4] }),
      encode: ({ user, suffix }) => ["test", "-", user, "-", suffix] as const,
    }),
  ),
);
export type TestFileStage = typeof TestFileStage.Type;

export class UnknownStageError extends Schema.TaggedError<UnknownStageError>()(
  "UnknownStageError",
  {
    stage: Schema.String,
  },
) {
  override get message() {
    return `stage "${this.stage}" belongs to no known environment`;
  }
}

const decodePerDeveloper = Schema.decodeUnknownOption(PerDeveloperStage);
const decodeTestFileStage = Schema.decodeUnknownOption(TestFileStage);

const isDeployed = Schema.is(Deployed);

/**
 * An unknown stage dies rather than falling back: an environment not listed in {@link Environment}
 * is one nobody has thought through (its seed, its state store, its policy), a misconfiguration no
 * caller can act on.
 */
export const environmentOf = (stage: string): Effect.Effect<Environment> =>
  isDeployed(stage)
    ? Effect.succeed(stage)
    : Option.isSome(decodeTestFileStage(stage))
      ? Effect.succeed("test")
      : Option.match(decodePerDeveloper(stage), {
          onNone: () => Effect.die(new UnknownStageError({ stage })),
          onSome: ({ environment }) => Effect.succeed(environment),
        });

/**
 * App `app`'s Worker name on a {@link Deployed} stage, `<app>-<worker>-<stage>`: fixed, so its
 * `workers.dev` URL and its log service name survive a destroy and redeploy. A per-developer
 * stage gets `undefined`, which keeps Alchemy's generated name: the integ files deploy the same
 * stack on the same stage side by side, and a fixed name would collide.
 *
 * Changing a deployed Worker's name replaces it, Durable Object storage included.
 */
export function workerNameOf(
  app: string,
  stage: Deployed,
  worker: "website" | "backend",
): string;
export function workerNameOf(
  app: string,
  stage: string,
  worker: "website" | "backend",
): string | undefined;
export function workerNameOf(
  app: string,
  stage: string,
  worker: "website" | "backend",
): string | undefined {
  return isDeployed(stage) ? `${app}-${worker}-${stage}` : undefined;
}

/**
 * Whether this code runs in a deployed bundle rather than while the stack is planned: Alchemy's
 * bundler folds `globalThis.__ALCHEMY_RUNTIME__` to `true` in every runtime artifact, so a branch
 * on it is dead code in the other phase.
 */
export const isAlchemyRuntime = (): boolean =>
  // oxlint-disable-next-line no-underscore-dangle -- Alchemy's build-time flag
  globalThis.__ALCHEMY_RUNTIME__ === true;
