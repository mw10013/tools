/**
 * What an app's Alchemy stacks share to keep a {@link Deployed} stage's configuration in one
 * place: the providers, the state store, the `secrets` policy, and the stage config record.
 *
 * A deployed stage's externally issued values (API keys, secrets, ids) live in one record, the
 * output of the app's stage config stack in Cloudflare state. Its writer reads them from
 * `.env.<stage>` and nothing else ({@link readStageFile}); the app stack reads them back through
 * {@link decodeStageConfig}, so a missing record or field fails the plan. Workers Builds deploys
 * from that record and never sees the file.
 *
 * {@link stageState} admits a run on a deployed stage only from Workers Builds on the stage's
 * branch or from the `stage` CLI, and only the Alchemy command that run is for
 * ({@link deployedRunRefusal}). Alchemy builds the state store on every command that addresses a
 * stage, `destroy` included, which never runs the stack's program; so a hand-run
 * `alchemy deploy`, `plan` or `destroy --stage production` dies before it reads state. The app
 * stack also opens with {@link guardShell}.
 *
 * Stack-time only: imports Alchemy, so no Worker bundle may carry it. {@link Deployed} and the
 * other names a bundle needs stay in `stage.ts`.
 *
 * @see `~/.claude/skills/coder/references/deployed-stages.md` for the lifecycle these enforce.
 * @module
 */
import path from "node:path";

import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  branchOf,
  Deployed,
  environmentOf,
  ResettableDeployed,
  STAGE_RUN,
  StageRun,
} from "#devkit/cloudflare/stage.ts";
import { ROOT } from "#devkit/core/app.ts";

const isDeployed = Schema.is(Deployed);

/**
 * The stack's state store, chosen by the stage's environment. State lives where the resources
 * live: `dev`, `test` and `e2e` run in workerd and its simulators, so their state is local under
 * `.alchemy/`; `staging` and `production` run in Cloudflare, so their state does too, behind
 * {@link guardDeployedRun}.
 *
 * `Test.make`'s own `state` option is built outside the stage, so integ files pass none and use
 * this layer from the stack.
 */
export const stageState = Layer.unwrap(
  Effect.gen(function* () {
    yield* guardDeployedRun;
    const environment = yield* environmentOf(yield* Alchemy.Stage);
    return Match.value(environment).pipe(
      Match.whenOr("dev", "test", "e2e", () => Alchemy.localState()),
      Match.whenOr("staging", "production", () => Cloudflare.state()),
      Match.exhaustive,
    );
  }),
);

export class UnsafeNukeRefusedError extends Schema.TaggedError<UnsafeNukeRefusedError>()(
  "UnsafeNukeRefusedError",
  {},
) {
  override get message() {
    return "alchemy unsafe nuke deletes every Alchemy resource the account holds, every app's staging and production included, so an app stack refuses it. Reset local data with vp run db:reset and staging with vp run stage reset staging";
  }
}

/** Dies when this process is `alchemy unsafe nuke`. */
export const refuseUnsafeNuke: Effect.Effect<void> = Effect.suspend(() =>
  alchemyCommandOf(process.argv) === "unsafe"
    ? Effect.die(new UnsafeNukeRefusedError())
    : Effect.void,
);

/**
 * The `providers` option of every app stack and its stage config writer: Cloudflare's, behind
 * {@link refuseUnsafeNuke}. Nuke builds a stack's providers and nothing else, no stage and no
 * state store (Alchemy's `src/Alchemist/Nuke.ts`), so {@link guardDeployedRun} never runs, and it
 * deletes across the whole account, not one stage.
 */
export const stageProviders = Layer.unwrap(
  Effect.as(refuseUnsafeNuke, Cloudflare.providers()),
);

/**
 * The `secrets` option of every app stack. A per-developer stage reads `.env`, then the shell. A
 * {@link Deployed} stage reads no file: its values come from the stage config record. Its list
 * is empty rather than `ProcessEnv({ disabled: true })` because Alchemy appends the shell to any
 * list that does not name it, and the providers are built under the same configuration, so the
 * shell is where Workers Builds hands the deploy its Cloudflare credentials.
 *
 * Declaring `secrets` also makes `--env-file` a hard error, so no flag can bring a file back.
 */
export const deployedSecrets: Alchemy.StackSecrets = ({ stage }) =>
  isDeployed(stage) ? [] : [Alchemy.Secrets.DotEnv()];

export class NotDeployedStageError extends Schema.TaggedError<NotDeployedStageError>()(
  "NotDeployedStageError",
  { stage: Schema.String },
) {
  override get message() {
    return `this stack is for ${Deployed.literals.join(", ")} only, not stage "${this.stage}"`;
  }
}

/** The stack's stage when it is {@link Deployed}; any other stage dies before anything is written. */
export const requireDeployed: Effect.Effect<Deployed, never, Alchemy.Stage> =
  Effect.flatMap(Alchemy.Stage, (stage) =>
    isDeployed(stage)
      ? Effect.succeed(stage)
      : Effect.die(new NotDeployedStageError({ stage })),
  );

/**
 * A stage config record's schema: a struct whose fields are named after the bindings they become,
 * and which decodes with no services, since neither a dotenv file nor Alchemy state can supply one.
 */
export type StageConfigSchema = Schema.Struct<Schema.Struct.Fields> &
  Schema.Codec<unknown, unknown, never, never>;

/**
 * The fields that do not parse on their own, by name. A failure's own message can quote the value
 * that failed, a secret included, so callers report these names instead.
 */
const invalidFields = <S extends StageConfigSchema>(
  schema: S,
  parses: (field: StageConfigSchema) => Effect.Effect<unknown, unknown>,
) =>
  Effect.filter(Object.keys(schema.fields), (name) =>
    // A struct of one of `schema`'s fields decodes with `schema`'s services: none.
    parses(
      Schema.Struct({ [name]: schema.fields[name] }) as StageConfigSchema,
    ).pipe(Effect.match({ onFailure: () => true, onSuccess: () => false })),
  );

const sourceError = (message: string) =>
  new Config.ConfigError(new ConfigProvider.SourceError({ message }));

/**
 * `schema`'s record parsed from the dotenv `file` and nothing else, so a variable in the shell
 * cannot replace a value and a field missing from the file fails rather than falling back. The
 * error names the fields, never values.
 */
export const parseStageFile = <S extends StageConfigSchema>(
  schema: S,
  file: string,
) =>
  Effect.gen(function* () {
    const provider = yield* ConfigProvider.fromDotEnv({ path: file }).pipe(
      Effect.mapError(() => sourceError(`cannot read ${file}`)),
    );
    return yield* Config.schema<S["Type"]>(schema)
      .parse(provider)
      .pipe(
        Effect.catchTag("ConfigError", () =>
          invalidFields(schema, (field) =>
            Config.schema(field).parse(provider),
          ).pipe(
            Effect.flatMap((names) =>
              Effect.fail(
                sourceError(
                  `${file} is missing or has invalid values for: ${names.join(", ")}`,
                ),
              ),
            ),
          ),
        ),
      );
  });

/**
 * The writer stack's body: the {@link Deployed} stage's record, {@link parseStageFile parsed}
 * from `.env.<stage>` at the app's root.
 *
 * @example
 * export default StageConfig.make(
 *   { providers: stageProviders, state: stageState, secrets: deployedSecrets },
 *   readStageFile(StageConfigFields),
 * );
 */
export const readStageFile = <S extends StageConfigSchema>(schema: S) =>
  Effect.flatMap(requireDeployed, (stage) =>
    parseStageFile(schema, path.join(ROOT, `.env.${stage}`)),
  ).pipe(Effect.withSpan("DeployedStack.readStageFile"));

export class StageConfigRecordError extends Schema.TaggedError<StageConfigRecordError>()(
  "StageConfigRecordError",
  { fields: Schema.Array(Schema.String) },
) {
  override get message() {
    return `the stage config record is missing or has invalid values for: ${this.fields.join(", ")}. Add them to .env.<stage>, run vp run stage config <stage>, then deploy again`;
  }
}

/**
 * The stage config record, decoded field by field against `schema`, so a field the record lacks
 * fails the plan instead of reading as `undefined`. A missing record already fails it: Alchemy
 * refuses a reference to a stack it has no output for.
 *
 * The record holds `schema`'s Type side: Alchemy writes the writer's output to state with each
 * `Redacted` wrapped as `{ "__redacted__": value }` and revives it as a `Redacted` on read, so a
 * `Schema.Redacted` field comes back `Redacted` and a transformed field comes back transformed.
 * Hence the decode runs against {@link Schema.toType}.
 *
 * @see `encodeState` and `reviveState` in Alchemy's `src/State/StateEncoding.ts`
 * @example
 * export const stageConfig = Effect.map(StageConfig, decodeStageConfig(StageConfigFields));
 */
export const decodeStageConfig = <S extends StageConfigSchema>(schema: S) => {
  const decode = decodeRecord(schema);
  return (record: Alchemy.Output<unknown>) =>
    record.pipe(
      Output.mapEffect((value: unknown) => Effect.orDie(decode(value))),
    ) as Output.ToOutput<S["Type"]>;
};

/** One stored record decoded as {@link decodeStageConfig} does, failing with the fields that do not decode. */
export const decodeRecord = <S extends StageConfigSchema>(schema: S) => {
  const decode = Schema.decodeUnknownEffect(Schema.toType(schema));
  return (value: unknown) =>
    decode(value).pipe(
      Effect.catchTag("SchemaError", () =>
        invalidFields(schema, (field) =>
          Schema.decodeUnknownEffect(Schema.toType(field))(value),
        ).pipe(
          Effect.flatMap((fields) =>
            Effect.fail(new StageConfigRecordError({ fields })),
          ),
        ),
      ),
    );
};

/** The record's field names that `env` also holds. */
export const shellOverrides = (
  schema: StageConfigSchema,
  env: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<string> =>
  Object.keys(schema.fields).filter((name) => env[name] !== undefined);

/** The variables a run on a {@link Deployed} stage is judged by. */
export interface DeployedRunEnv {
  readonly WORKERS_CI?: string | undefined;
  readonly WORKERS_CI_BRANCH?: string | undefined;
  readonly [STAGE_RUN]?: string | undefined;
}

/** Alchemy's CLI commands, as its `src/Cli/main.ts` lists them. */
const AlchemyCommand = Schema.Literals([
  "provider",
  "deploy",
  "dev",
  "destroy",
  "plan",
  "logs",
  "profile",
  "state",
  "drift",
  "unsafe",
]);
export type AlchemyCommand = typeof AlchemyCommand.Type;

/**
 * The command Alchemy's CLI runs for `argv`, `undefined` outside its CLI. Alchemy picks it the
 * same way, as the first argument naming a command, so the two cannot disagree.
 *
 * @see `requestedCommand` in Alchemy's `src/Cli/main.ts`
 */
export const alchemyCommandOf = (
  argv: ReadonlyArray<string>,
): AlchemyCommand | undefined => argv.slice(2).find(Schema.is(AlchemyCommand));

/** Who runs Alchemy on a deployed stage: Workers Builds, or the `stage` CLI for one of its reasons. */
type DeployedRun = "builds" | StageRun;

/**
 * What each run may do. Builds only deploys; each `stage` subcommand runs the one command it is
 * for. Only `reset` destroys, and only a {@link ResettableDeployed} stage, so nothing destroys
 * production.
 */
const permits: Record<
  DeployedRun,
  {
    readonly commands: ReadonlyArray<AlchemyCommand>;
    readonly stages: ReadonlyArray<Deployed>;
  }
> = {
  builds: { commands: ["deploy"], stages: Deployed.literals },
  bootstrap: { commands: ["deploy"], stages: Deployed.literals },
  config: { commands: ["deploy"], stages: Deployed.literals },
  check: { commands: ["plan"], stages: Deployed.literals },
  reset: {
    commands: ["destroy", "deploy"],
    stages: ResettableDeployed.literals,
  },
};

const isStageRun = Schema.is(StageRun);

const ONLY_RESET_DESTROYS =
  "only vp run stage reset staging destroys a deployed stage, and nothing destroys production";

/**
 * Why Alchemy must not run `command` on `stage` here, or `None`. Workers Builds deploys the stage
 * from its branch; the `stage` CLI names its reason in {@link STAGE_RUN}; each may run only what
 * {@link permits} gives it. Anywhere else a deploy would ship whatever the checkout holds, not
 * what the branch holds, and a destroy would delete the stage's data.
 */
export const deployedRunRefusal = (
  stage: Deployed,
  command: AlchemyCommand | undefined,
  env: DeployedRunEnv,
): Option.Option<string> => {
  const branch = branchOf(stage);
  const reason = env[STAGE_RUN];
  if (reason !== undefined && !isStageRun(reason))
    return Option.some(
      `${STAGE_RUN} is "${reason}", not one of ${StageRun.literals.join(", ")}. Only vp run stage sets it; unset it`,
    );
  if (
    reason === undefined &&
    env.WORKERS_CI === "1" &&
    env.WORKERS_CI_BRANCH !== branch
  )
    return Option.some(
      `${stage} deploys from branch ${branch}, not ${env.WORKERS_CI_BRANCH ?? "(none)"}. Point the trigger at ${branch} with vp run stage trigger ${stage}`,
    );
  const run: DeployedRun | undefined =
    reason ?? (env.WORKERS_CI === "1" ? "builds" : undefined);
  if (run === undefined)
    return Option.some(
      command === "destroy"
        ? `${stage} is not destroyed by hand: ${ONLY_RESET_DESTROYS}`
        : `${stage} runs only in Workers Builds: push to ${branch} to deploy it. Plan it with vp run stage check ${stage}; the owner deploys a stage with no trigger yet with vp run stage bootstrap ${stage}`,
    );
  const permit = permits[run];
  if (
    command !== undefined &&
    permit.commands.includes(command) &&
    permit.stages.includes(stage)
  )
    return Option.none();
  const who = run === "builds" ? "Workers Builds" : `vp run stage ${run}`;
  return Option.some(
    `${who} runs alchemy ${permit.commands.join(" or ")} on ${permit.stages.join(" or ")}, not alchemy ${command ?? "(no command)"} on ${stage}${command === "destroy" ? `: ${ONLY_RESET_DESTROYS}` : ""}`,
  );
};

export class DeployedRunRefusedError extends Schema.TaggedError<DeployedRunRefusedError>()(
  "DeployedRunRefusedError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}

/**
 * Dies on a {@link Deployed} stage unless {@link deployedRunRefusal} allows this process's Alchemy
 * command. {@link stageState} runs it as it builds; a stack with another store runs it the same way.
 */
export const guardDeployedRun: Effect.Effect<void, never, Alchemy.Stage> =
  Effect.flatMap(Alchemy.Stage, (stage) => {
    if (!isDeployed(stage)) return Effect.void;
    const refusal = deployedRunRefusal(
      stage,
      alchemyCommandOf(process.argv),
      process.env,
    );
    return Option.isSome(refusal)
      ? Effect.die(new DeployedRunRefusedError({ reason: refusal.value }))
      : Effect.void;
  });

export class ShellHoldsStageConfigError extends Schema.TaggedError<ShellHoldsStageConfigError>()(
  "ShellHoldsStageConfigError",
  { names: Schema.Array(Schema.String) },
) {
  override get message() {
    return `the shell sets ${this.names.join(", ")}, which a deployed stage takes only from its stage config record. Unset them and run again`;
  }
}

/**
 * The app stack's first step; the stage config writer never calls it. On a {@link Deployed} stage
 * it dies when the shell sets any of the record's field names: a deployed stage's configuration is
 * the shell alone ({@link deployedSecrets}), and Alchemy binds what a Worker's init reads from it
 * as a secret, so such a variable would reach the Worker beside the record. Names only: values
 * are never read.
 *
 * @example
 * export default Alchemy.Stack("app", { providers, state: stageState, secrets: deployedSecrets },
 *   Effect.gen(function* () {
 *     yield* guardShell(StageConfigFields);
 *     // ...
 *   }),
 * );
 */
export const guardShell = (schema: StageConfigSchema) =>
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    if (!isDeployed(stage)) return;
    const names = shellOverrides(schema, process.env);
    if (names.length > 0)
      return yield* Effect.die(new ShellHoldsStageConfigError({ names }));
  });
