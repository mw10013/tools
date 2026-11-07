#!/usr/bin/env vpx
/**
 * `vp run stage <command> <stage>`: a {@link Deployed} stage's Workers Builds trigger, its health,
 * its stage config record, and the laptop runs of Alchemy on it. An app runs this file directly:
 * `"stage": "vpx vendor/devkit/cloudflare/deployed-stage.ts"`.
 *
 * Workers Builds deploys a stage with the app's `deploy:<stage>` script, plain
 * `alchemy deploy --stage <stage> --yes`. The stage's state store (`stageState`) refuses any other
 * Alchemy run on the stage unless {@link STAGE_RUN} names why, which only this CLI sets, on the
 * Alchemy runs it starts, and then only the command that reason is for:
 *
 * - `check` reads, and changes nothing: the plan, so a missing or invalid stage config record
 *   shows; whether the plan replaces the Website Worker, which takes its trigger with it; and the
 *   trigger against the canonical one.
 * - `config` writes the stage config record from `.env.<stage>`, deploying {@link STAGE_CONFIG_STACK}.
 * - `trigger` makes the stage's trigger the {@link canonicalTrigger}. It runs from a laptop: the
 *   Builds API takes only a user API token.
 * - `reset` (staging only) destroys the stage, deploys it again and recreates its trigger. It is
 *   the only destroy of a deployed stage.
 * - `bootstrap` is the owner's deploy of a stage whose Website has no trigger yet.
 *
 * @see `~/.claude/skills/coder/references/deployed-stages.md`
 * @module
 */
import { stripVTControlCharacters } from "node:util";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Argument from "effect/cli/Argument";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  branchOf,
  Deployed,
  ResettableDeployed,
  STAGE_RUN,
  type StageRun,
  workerNameOf,
} from "#devkit/cloudflare/stage.ts";
import { APP_NAME, ROOT } from "#devkit/core/app.ts";
import { runCommand } from "#devkit/core/command.ts";

class StageError extends Schema.TaggedError<StageError>()("StageError", {
  message: Schema.String,
}) {}

/**
 * The account's one build token, chosen by name because its uuid is not ours to fix. Builds
 * deploys with its permissions, so it must cover everything a deploy touches (Workers, D1,
 * routes and custom domains).
 */
export const SHARED_BUILD_TOKEN = "Workers Builds - 2026-05-31 17:29";

/** The app's stage config writer stack, relative to its root. */
export const STAGE_CONFIG_STACK = "stacks/stage-config.ts";

const websiteOf = (stage: Deployed) => workerNameOf(APP_NAME, stage, "website");

/** A trigger as `cf builds triggers list` gives it. */
export const Trigger = Schema.Struct({
  trigger_uuid: Schema.String,
  trigger_name: Schema.String,
  build_token_uuid: Schema.String,
  build_command: Schema.String,
  deploy_command: Schema.String,
  root_directory: Schema.String,
  branch_includes: Schema.Array(Schema.String),
  branch_excludes: Schema.Array(Schema.String),
  path_includes: Schema.Array(Schema.String),
  path_excludes: Schema.Array(Schema.String),
  build_caching_enabled: Schema.Boolean,
  repo_connection: Schema.Struct({
    repo_connection_uuid: Schema.String,
    repo_name: Schema.String,
  }),
});
export type Trigger = typeof Trigger.Type;

/**
 * Every trigger has this shape, so no setting is chosen by hand. The deploy command is the app's
 * `deploy:<stage>` script; there is no build command, since the deploy builds; and no trigger
 * variables, since a deployed stage's values come from its stage config record.
 */
export const canonicalTrigger = (stage: Deployed, buildTokenUuid: string) => ({
  trigger_name: websiteOf(stage),
  build_token_uuid: buildTokenUuid,
  build_command: "",
  deploy_command: `pnpm exec vp run deploy:${stage}`,
  root_directory: "/",
  branch_includes: [branchOf(stage)],
  branch_excludes: [],
  path_includes: ["*"],
  path_excludes: [],
  build_caching_enabled: false,
});
export type CanonicalTrigger = ReturnType<typeof canonicalTrigger>;

/** The settings in which `trigger` differs from `canonical`. */
export const triggerDrift = (
  trigger: Trigger,
  canonical: CanonicalTrigger,
): ReadonlyArray<string> =>
  (Object.keys(canonical) as Array<keyof CanonicalTrigger>).filter(
    (key) => JSON.stringify(trigger[key]) !== JSON.stringify(canonical[key]),
  );

/**
 * Whether an `alchemy plan` replaces the Website Worker. A replaced Worker gets a new tag, and
 * Cloudflare deletes the trigger with the old one. Alchemy prints a resource's line as
 * `[<FQN>] <action>`, after its log prefix `[<time>] <LEVEL>: `.
 *
 * @see `formatPlan` in Alchemy's `src/Cli/LoggingCli.ts` and `prettyLine` in `src/Util/ConsoleSink.ts`
 */
export const replacesWebsite = (plan: string) =>
  /^(?:\[[\d:.]+\] [A-Z]+: )?\[Website\] replace\b/mu.test(
    stripVTControlCharacters(plan),
  );

const decodeJson =
  <S extends Schema.Top & { readonly DecodingServices: never }>(
    schema: S,
    what: string,
  ) =>
  (text: string) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
      Effect.mapError(
        () => new StageError({ message: `unexpected output from ${what}` }),
      ),
    );

const cf = (args: ReadonlyArray<string>) =>
  runCommand("cf", args).pipe(
    Effect.mapError((error) => new StageError({ message: error.message })),
  );

const findTag = Effect.fn("DeployedStage.findTag")(function* (name: string) {
  const scripts = yield* cf([
    "workers",
    "scripts",
    "search",
    "--name",
    name,
  ]).pipe(
    Effect.flatMap(
      decodeJson(
        Schema.Array(
          Schema.Struct({ id: Schema.String, script_name: Schema.String }),
        ),
        "cf workers scripts search",
      ),
    ),
  );
  return Option.map(
    Option.fromNullishOr(scripts.find((script) => script.script_name === name)),
    (script) => script.id,
  );
});

const requireTag = Effect.fn("DeployedStage.requireTag")(function* (
  stage: Deployed,
) {
  const website = websiteOf(stage);
  const tag = yield* findTag(website);
  if (Option.isNone(tag))
    return yield* new StageError({
      message: `${website} does not exist. Deploy ${stage} first`,
    });
  return tag.value;
});

const listTriggers = (tag: string) =>
  cf(["builds", "triggers", "list", "--external-script-id", tag]).pipe(
    Effect.flatMap(
      decodeJson(Schema.Array(Trigger), "cf builds triggers list"),
    ),
  );

const sharedBuildToken = Effect.fn("DeployedStage.sharedBuildToken")(
  function* () {
    const tokens = yield* cf(["builds", "tokens", "list"]).pipe(
      Effect.flatMap(
        decodeJson(
          Schema.Array(
            Schema.Struct({
              build_token_uuid: Schema.String,
              build_token_name: Schema.String,
            }),
          ),
          "cf builds tokens list",
        ),
      ),
    );
    const token = tokens.find(
      (candidate) => candidate.build_token_name === SHARED_BUILD_TOKEN,
    );
    if (token === undefined)
      return yield* new StageError({
        message: `no build token named "${SHARED_BUILD_TOKEN}"; the owner makes it in the dashboard`,
      });
    return token.build_token_uuid;
  },
);

const triggerVariables = (triggerUuid: string) =>
  cf([
    "builds",
    "triggers",
    "environment-variables",
    "list",
    "--trigger-uuid",
    triggerUuid,
  ]).pipe(
    Effect.flatMap(
      decodeJson(
        Schema.Record(Schema.String, Schema.Unknown),
        "cf builds triggers environment-variables list",
      ),
    ),
    Effect.map(Object.keys),
  );

/**
 * Whether the Worker builds branches other than its own, `None` when Builds has no configuration
 * for it (`cf` exits 1 on the 404). Previews can also be a second trigger, which
 * {@link ensureTrigger} deletes.
 */
const previewsEnabled = (tag: string) =>
  runCommand("cf", ["builds", "workers", "get", tag]).pipe(
    Effect.flatMap(
      decodeJson(
        Schema.Struct({ previews_enabled: Schema.Boolean }),
        "cf builds workers get",
      ),
    ),
    Effect.map((config) => Option.some(config.previews_enabled)),
    Effect.catchTag("CommandError", () => Effect.succeedNone),
  );

/** The app's GitHub repository, from `origin`. */
const githubRepo = Effect.fn("DeployedStage.githubRepo")(function* () {
  const url = (yield* runCommand("git", [
    "-C",
    ROOT,
    "remote",
    "get-url",
    "origin",
  ]).pipe(
    Effect.mapError((error) => new StageError({ message: error.message })),
  )).trim();
  const match = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/u.exec(url);
  if (match === null)
    return yield* new StageError({
      message: `origin is not a GitHub repository: ${url}`,
    });
  return { owner: match[1] ?? "", name: match[2] ?? "" };
});

/**
 * The repository connection Builds reaches the app's repository through. Every trigger of the
 * repository shares one, so it is reused from a trigger on either deployed stage; with none
 * (an app's first trigger), it is upserted from GitHub's ids. Either way the Cloudflare GitHub
 * App must already have access to the repository, which only the owner can grant.
 */
const repoConnection = Effect.fn("DeployedStage.repoConnection")(function* (
  dryRun: boolean,
) {
  const repo = yield* githubRepo();
  for (const stage of Deployed.literals) {
    const tag = yield* findTag(websiteOf(stage));
    if (Option.isNone(tag)) continue;
    const found = (yield* listTriggers(tag.value)).find(
      (trigger) => trigger.repo_connection.repo_name === repo.name,
    );
    if (found !== undefined) return found.repo_connection.repo_connection_uuid;
  }
  const ids = yield* runCommand("gh", [
    "api",
    `repos/${repo.owner}/${repo.name}`,
  ]).pipe(
    Effect.mapError((error) => new StageError({ message: error.message })),
    Effect.flatMap(
      decodeJson(
        Schema.Struct({
          id: Schema.Number,
          name: Schema.String,
          owner: Schema.Struct({ id: Schema.Number, login: Schema.String }),
        }),
        "gh api repos",
      ),
    ),
  );
  const upsert = [
    "builds",
    "repos",
    "connections",
    "upsert",
    "--body",
    JSON.stringify({
      provider_type: "github",
      provider_account_id: String(ids.owner.id),
      provider_account_name: ids.owner.login,
      repo_id: String(ids.id),
      repo_name: ids.name,
    }),
  ];
  if (dryRun) {
    yield* Console.log(yield* cf([...upsert, "--dry-run"]));
    return "<the upserted connection>";
  }
  const connection = yield* cf(upsert).pipe(
    Effect.flatMap(
      decodeJson(
        Schema.Struct({ repo_connection_uuid: Schema.String }),
        "cf builds repos connections upsert",
      ),
    ),
  );
  yield* Console.error(
    `stage: connected ${repo.owner}/${repo.name} to Workers Builds`,
  );
  return connection.repo_connection_uuid;
});

/** What `check` and `trigger` find wrong with a stage's trigger; empty when it is canonical. */
const triggerProblems = Effect.fn("DeployedStage.triggerProblems")(function* (
  stage: Deployed,
  tag: string,
) {
  const canonical = canonicalTrigger(stage, yield* sharedBuildToken());
  const repo = yield* githubRepo();
  const triggers = yield* listTriggers(tag);
  const problems: Array<string> = [];
  if (triggers.length !== 1)
    problems.push(
      `${String(triggers.length)} triggers on ${websiteOf(stage)}; expected exactly one`,
    );
  for (const trigger of triggers) {
    const drift = triggerDrift(trigger, canonical);
    if (drift.length > 0)
      problems.push(
        `trigger ${trigger.trigger_uuid} differs in ${drift.join(", ")}`,
      );
    if (trigger.repo_connection.repo_name !== repo.name)
      problems.push(
        `trigger ${trigger.trigger_uuid} builds repository ${trigger.repo_connection.repo_name}, not ${repo.name}`,
      );
    const variables = yield* triggerVariables(trigger.trigger_uuid);
    if (variables.length > 0)
      problems.push(
        `trigger ${trigger.trigger_uuid} sets variables ${variables.join(", ")}`,
      );
  }
  if (Option.getOrElse(yield* previewsEnabled(tag), () => false))
    problems.push(`${websiteOf(stage)} has previews enabled`);
  return problems;
});

/**
 * Makes the stage's one trigger canonical. A trigger on the right repository is updated in place,
 * so the Worker is never without one; otherwise the canonical trigger is created before any old one
 * is deleted. Any other trigger (a preview trigger) is deleted, and previews are turned off.
 * `dryRun` passes `--dry-run` to every write, which prints each request instead of sending it; a
 * dry run with nothing to write still checks the trigger and says it is canonical.
 */
export const ensureTrigger = Effect.fn("DeployedStage.ensureTrigger")(
  function* (stage: Deployed, dryRun: boolean) {
    const tag = yield* requireTag(stage);
    const canonical = canonicalTrigger(stage, yield* sharedBuildToken());
    const repo = yield* githubRepo();
    const triggers = yield* listTriggers(tag);
    let wrote = false;
    const done = (what: string) =>
      Console.error(`stage: ${dryRun ? "would have " : ""}${what}`);
    const write = (args: ReadonlyArray<string>) =>
      Effect.sync(() => {
        wrote = true;
      }).pipe(
        Effect.andThen(cf([...args, ...(dryRun ? ["--dry-run"] : [])])),
        Effect.tap((out) => (dryRun ? Console.log(out) : Effect.void)),
      );
    const onRepo = triggers.filter(
      (trigger) => trigger.repo_connection.repo_name === repo.name,
    );
    const keep =
      onRepo.find(
        (trigger) =>
          JSON.stringify(trigger.branch_includes) ===
          JSON.stringify(canonical.branch_includes),
      ) ?? onRepo[0];
    if (keep === undefined) {
      const connection = yield* repoConnection(dryRun);
      yield* write([
        "builds",
        "triggers",
        "create",
        "--body",
        JSON.stringify({
          ...canonical,
          external_script_id: tag,
          repo_connection_uuid: connection,
        }),
      ]);
      yield* done(`created the ${stage} trigger`);
    } else if (triggerDrift(keep, canonical).length > 0) {
      yield* write([
        "builds",
        "triggers",
        "update",
        keep.trigger_uuid,
        "--body",
        JSON.stringify(canonical),
      ]);
      yield* done(
        `updated ${triggerDrift(keep, canonical).join(", ")} on the ${stage} trigger`,
      );
    }
    if (keep !== undefined)
      for (const name of yield* triggerVariables(keep.trigger_uuid)) {
        yield* write([
          "builds",
          "triggers",
          "environment-variables",
          "delete",
          name,
          "--trigger-uuid",
          keep.trigger_uuid,
          "--force",
        ]);
        yield* done(`deleted trigger variable ${name}`);
      }
    for (const trigger of triggers)
      if (trigger !== keep) {
        yield* write([
          "builds",
          "triggers",
          "delete",
          trigger.trigger_uuid,
          "--force",
        ]);
        yield* done(
          `deleted trigger ${trigger.trigger_uuid} (${trigger.trigger_name})`,
        );
      }
    if (Option.getOrElse(yield* previewsEnabled(tag), () => false)) {
      yield* write([
        "builds",
        "workers",
        "update",
        tag,
        "--previews-enabled",
        "false",
      ]);
      yield* done(`turned previews off on ${websiteOf(stage)}`);
    }
    if (wrote && dryRun) return;
    if (!wrote)
      yield* Console.error(`stage: the ${stage} trigger needed no change`);
    const problems = yield* triggerProblems(stage, tag);
    if (problems.length > 0)
      return yield* new StageError({
        message: `the ${stage} trigger is still not canonical: ${problems.join("; ")}`,
      });
    yield* Console.log(
      `${stage}: the trigger on ${websiteOf(stage)} is canonical`,
    );
  },
);

/** Runs Alchemy in the app's root as `run`, its output shown as it comes. */
const alchemy = Effect.fn("DeployedStage.alchemy")(function* (
  args: ReadonlyArray<string>,
  run: StageRun,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* spawner
    .exitCode(
      ChildProcess.make("alchemy", [...args], {
        cwd: ROOT,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
        env: { [STAGE_RUN]: run },
        extendEnv: true,
      }),
    )
    .pipe(
      Effect.mapError(() => new StageError({ message: "cannot run alchemy" })),
    );
  if (exitCode !== ChildProcessSpawner.ExitCode(0))
    return yield* new StageError({
      message: `alchemy ${args.join(" ")} exited ${String(exitCode)}`,
    });
});

/** `alchemy plan`'s output, captured. It holds no stage config values: without `--detailed` it names resources only. */
const plan = Effect.fn("DeployedStage.plan")(function* (stage: Deployed) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const failed = () => new StageError({ message: "cannot run alchemy plan" });
  const handle = yield* spawner
    .spawn(
      ChildProcess.make("alchemy", ["plan", "--stage", stage], {
        cwd: ROOT,
        stdin: "ignore",
        env: { NO_COLOR: "1", [STAGE_RUN]: "check" satisfies StageRun },
        extendEnv: true,
      }),
    )
    .pipe(Effect.mapError(failed));
  const [stdout, stderr] = yield* Effect.all(
    [
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
    ],
    { concurrency: "unbounded" },
  ).pipe(Effect.mapError(failed));
  const exitCode = yield* handle.exitCode.pipe(Effect.mapError(failed));
  return {
    ok: exitCode === ChildProcessSpawner.ExitCode(0),
    output: `${stdout}${stderr}`,
  };
}, Effect.scoped);

export const check = Effect.fn("DeployedStage.check")(function* (
  stage: Deployed,
) {
  const problems: Array<string> = [];
  const planned = yield* plan(stage);
  if (planned.ok) {
    yield* Console.log(
      `${stage}: plan succeeds, so the stage config record decodes`,
    );
    if (replacesWebsite(planned.output))
      yield* Console.error(
        `stage: warning: the plan replaces the Website Worker, which deletes its trigger; run vp run stage trigger ${stage} after the deploy`,
      );
  } else {
    yield* Console.error(
      planned.output.trimEnd().split("\n").slice(-20).join("\n"),
    );
    problems.push("the plan fails");
  }
  const tag = yield* findTag(websiteOf(stage));
  if (Option.isNone(tag)) problems.push(`${websiteOf(stage)} does not exist`);
  else problems.push(...(yield* triggerProblems(stage, tag.value)));
  if (problems.length > 0)
    return yield* new StageError({
      message: `${stage}: ${problems.join("; ")}`,
    });
  yield* Console.log(`${stage}: the trigger is canonical`);
});

const reset = Effect.fn("DeployedStage.reset")(function* (
  stage: ResettableDeployed,
) {
  yield* alchemy(["destroy", "--stage", stage, "--yes"], "reset");
  yield* alchemy(["deploy", "--stage", stage, "--yes"], "reset");
  yield* ensureTrigger(stage, false);
  yield* Console.log(`${stage}: reset`);
});

/** Deploys from this checkout a stage whose Website has no trigger, so no push can deploy it yet. */
const bootstrap = Effect.fn("DeployedStage.bootstrap")(function* (
  stage: Deployed,
) {
  const tag = yield* findTag(websiteOf(stage));
  if (Option.isSome(tag) && (yield* listTriggers(tag.value)).length > 0)
    return yield* new StageError({
      message: `${websiteOf(stage)} has a trigger, so ${stage} deploys from ${branchOf(stage)}: push there. Check the trigger with vp run stage check ${stage}`,
    });
  yield* Console.error(
    `stage: bootstrapping ${stage} from this checkout; run vp run stage trigger ${stage} next`,
  );
  yield* alchemy(["deploy", "--stage", stage, "--yes"], "bootstrap");
});

/** Saves `.env.<stage>` as the stage's config record; a deploy reads the record, never the file. */
export const writeStageConfig = Effect.fn("DeployedStage.writeStageConfig")(
  function* (stage: Deployed) {
    yield* alchemy(
      ["deploy", "--config", STAGE_CONFIG_STACK, "--stage", stage, "--yes"],
      "config",
    );
    yield* Console.log(
      `${stage}: wrote the stage config record from .env.${stage}; deploy to use it`,
    );
  },
);

const toUserError = (error: StageError) =>
  new CliError.UserError({ cause: error, userMessage: error.message });

const stageArgument = Argument.Literals("stage", Deployed.literals).pipe(
  Argument.withDescription("staging or production"),
);

const checkCommand = Command.make(
  "check",
  { stage: stageArgument },
  ({ stage }) => check(stage).pipe(Effect.mapError(toUserError)),
).pipe(
  Command.withDescription(
    "Read only: whether the plan succeeds (so the stage config record decodes) and replaces the Website, and whether the trigger is canonical.",
  ),
);

const triggerCommand = Command.make(
  "trigger",
  {
    stage: stageArgument,
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Print each write request instead of sending it"),
    ),
  },
  ({ stage, dryRun }) =>
    ensureTrigger(stage, dryRun).pipe(Effect.mapError(toUserError)),
).pipe(
  Command.withDescription(
    "Make the stage's Workers Builds trigger canonical, creating it if the Website has none.",
  ),
);

const resetCommand = Command.make(
  "reset",
  {
    stage: Argument.Literals("stage", ResettableDeployed.literals).pipe(
      Argument.withDescription("staging; production is never reset"),
    ),
    confirm: Flag.String("confirm").pipe(
      Flag.withDescription(
        "The stage again, to confirm its data is to be deleted",
      ),
    ),
  },
  ({ stage, confirm }) =>
    (confirm === stage
      ? reset(stage)
      : Effect.fail(
          new StageError({
            message: `--confirm must repeat the stage, ${stage}`,
          }),
        )
    ).pipe(Effect.mapError(toUserError)),
).pipe(
  Command.withDescription(
    "Destroy staging, deleting its D1 and Durable Object data, deploy it again and recreate its trigger.",
  ),
);

const configCommand = Command.make(
  "config",
  { stage: stageArgument },
  ({ stage }) => writeStageConfig(stage).pipe(Effect.mapError(toUserError)),
).pipe(
  Command.withDescription(
    "Write the stage config record from .env.<stage>, the record's only source.",
  ),
);

const bootstrapCommand = Command.make(
  "bootstrap",
  { stage: stageArgument },
  ({ stage }) => bootstrap(stage).pipe(Effect.mapError(toUserError)),
).pipe(
  Command.withDescription(
    "Owner only: deploy from this checkout a stage whose Website has no trigger yet.",
  ),
);

// Only when run, so a test can import this module.
if (import.meta.main) {
  Command.make("stage").pipe(
    Command.withDescription(
      "Check, configure, trigger, reset and bootstrap staging and production.",
    ),
    Command.withSubcommands([
      checkCommand,
      configCommand,
      triggerCommand,
      resetCommand,
      bootstrapCommand,
    ]),
    Command.run({ version: "1.0.0" }),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
