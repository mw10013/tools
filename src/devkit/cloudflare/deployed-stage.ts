#!/usr/bin/env vpx
/**
 * `vp run stage <command> <stage>`: sets up a {@link Deployed} stage's Workers Builds deploys,
 * reports its health, and resets staging. An app runs this file directly:
 * `"stage": "vpx vendor/devkit/cloudflare/deployed-stage.ts"`.
 *
 * Workers Builds deploys a stage with the app's `deploy:<stage>` script, plain
 * `alchemy deploy --stage <stage> --yes`, from the stage's branch. The stage's values are the
 * trigger's variables, so Builds puts them in the deploy's environment and Alchemy binds what a
 * Worker reads with `Config`.
 *
 * - `up` makes the stage match `.env.<stage>`: the Website exists, its one trigger is the
 *   {@link canonicalTrigger}, the trigger's variables are the file's, and a build of the branch
 *   ran with them. It runs from a laptop: the Builds API takes only a user API token. A stage
 *   with no Website gets its first deploy from the laptop, since a trigger needs a Worker to
 *   key to; every later deploy runs in Builds.
 * - `check` reads, and changes nothing: the plan, the trigger, its variables' names and the latest
 *   build.
 * - `reset` (staging only) destroys the stage, then runs `up`. It is the only destroy of a
 *   deployed stage.
 *
 * The stage's state store (`stageState`) refuses any other Alchemy run on the stage unless
 * {@link STAGE_RUN} names why, which only this CLI sets, and then only the command that reason is
 * for.
 *
 * @see `~/.claude/skills/coder/references/deployed-stages.md`
 * @module
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv, stripVTControlCharacters } from "node:util";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Argument from "effect/cli/Argument";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  checkStageEnv,
  type StageFieldEnv,
  type StageFields,
} from "#devkit/cloudflare/deployed-stack.ts";
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

/** The app's stage fields ({@link StageFields}), its default export, relative to its root. */
export const STAGE_ENV_MODULE = "stacks/stage-env.ts";

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
 * `deploy:<stage>` script; there is no build command, since the deploy builds.
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
): readonly string[] =>
  (Object.keys(canonical) as (keyof CanonicalTrigger)[]).filter(
    (key) => JSON.stringify(trigger[key]) !== JSON.stringify(canonical[key]),
  );

/** One write that brings a Website's triggers to the canonical one. */
export type TriggerStep =
  | { readonly _tag: "Create" }
  | {
      readonly _tag: "Update";
      readonly trigger: Trigger;
      readonly settings: readonly string[];
    }
  | { readonly _tag: "Delete"; readonly trigger: Trigger }
  | { readonly _tag: "DisablePreviews" };

/**
 * The writes, in order, that leave the Website with exactly the canonical trigger and previews
 * off; empty when it has it. A trigger on the app's repository is kept and updated in place, its
 * own branch's first, so the Worker is never without one; with none, the canonical trigger is
 * created before any other is deleted.
 */
export const triggerPlan = (
  canonical: CanonicalTrigger,
  repoName: string,
  triggers: readonly Trigger[],
  previews: boolean,
): {
  readonly kept: Trigger | undefined;
  readonly steps: readonly TriggerStep[];
} => {
  const onRepo = triggers.filter(
    (trigger) => trigger.repo_connection.repo_name === repoName,
  );
  const kept =
    onRepo.find(
      (trigger) =>
        JSON.stringify(trigger.branch_includes) ===
        JSON.stringify(canonical.branch_includes),
    ) ?? onRepo[0];
  const settings = kept === undefined ? [] : triggerDrift(kept, canonical);
  const steps: TriggerStep[] = [];
  if (kept === undefined) steps.push({ _tag: "Create" });
  else if (settings.length > 0)
    steps.push({ _tag: "Update", trigger: kept, settings });
  for (const trigger of triggers)
    if (trigger !== kept) steps.push({ _tag: "Delete", trigger });
  if (previews) steps.push({ _tag: "DisablePreviews" });
  return { kept, steps };
};

const describeStep =
  (stage: Deployed) =>
  (step: TriggerStep): string => {
    switch (step._tag) {
      case "Create": {
        return `create the ${stage} trigger`;
      }
      case "Update": {
        return `update ${step.settings.join(", ")} on the ${stage} trigger`;
      }
      case "Delete": {
        return `delete trigger ${step.trigger.trigger_uuid} (${step.trigger.trigger_name})`;
      }
      case "DisablePreviews": {
        return `turn previews off on ${websiteOf(stage)}`;
      }
    }
  };

/** One trigger variable: a line of `.env.<stage>` setting a field, its value the file's raw string. */
export type StageVariable = Extract<StageFieldEnv, { readonly _tag: "Set" }>;

/**
 * The trigger variables `file` (a parsed `.env.<stage>`) makes: one per field it sets, a secret
 * when the field decodes to a `Redacted`; an optional field it leaves out makes none. It fails
 * naming every field the file lacks or holds an invalid value for and every key no field
 * declares, since the trigger's variables must equal the file. Names only, never values.
 */
export const stageVariables = Effect.fn("DeployedStage.stageVariables")(
  function* (
    fields: StageFields,
    file: Readonly<Record<string, string>>,
    source: string,
  ) {
    const env = yield* checkStageEnv(fields, file);
    const invalid = env
      .filter((field) => field._tag === "Invalid")
      .map(({ name }) => name);
    const undeclared = Object.keys(file).filter(
      (name) => !Object.hasOwn(fields.fields, name),
    );
    const problems = [
      ...(invalid.length > 0
        ? [`lacks or has invalid ${invalid.join(", ")}`]
        : []),
      ...(undeclared.length > 0
        ? [
            `holds ${undeclared.join(", ")}, which ${STAGE_ENV_MODULE} does not declare`,
          ]
        : []),
    ];
    if (problems.length > 0)
      return yield* new StageError({
        message: `${source} ${problems.join(" and ")}`,
      });
    return env.filter((field): field is StageVariable => field._tag === "Set");
  },
);

/** A trigger's variables as `cf builds triggers environment-variables list` gives them; a secret's value reads back `null`. */
const TriggerVariables = Schema.Record(
  Schema.String,
  Schema.Struct({ is_secret: Schema.Boolean }),
);
type TriggerVariables = typeof TriggerVariables.Type;

/**
 * The trigger's variables the file does not set, which `up` deletes: one no field declares, or an
 * optional field the file leaves out.
 */
export const staleVariables = (
  variables: readonly StageVariable[],
  existing: TriggerVariables,
): readonly string[] =>
  Object.keys(existing).filter(
    (name) => !variables.some((variable) => variable.name === name),
  );

/** How the trigger's variables differ from `variables` by name and secrecy; values cannot be read back. */
export const variableProblems = (
  variables: readonly StageVariable[],
  existing: TriggerVariables,
): readonly string[] => [
  ...variables.flatMap(({ name, secret }) => {
    const found = existing[name];
    if (found === undefined) return [`the trigger lacks ${name}`];
    if (found.is_secret !== secret)
      return [
        `the trigger holds ${name} as ${found.is_secret ? "a secret" : "plain"}`,
      ];
    return [];
  }),
  ...staleVariables(variables, existing).map(
    (name) => `the trigger holds ${name}, which the file does not set`,
  ),
];

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

const cf = (args: readonly string[]) =>
  runCommand("cf", args).pipe(
    Effect.mapError((error) => new StageError({ message: error.message })),
  );

/** The app's stage fields, from {@link STAGE_ENV_MODULE}. */
const loadStageFields = Effect.fn("DeployedStage.loadStageFields")(
  function* () {
    const file = path.join(ROOT, STAGE_ENV_MODULE);
    const module: unknown = yield* Effect.tryPromise({
      try: () => import(pathToFileURL(file).href),
      catch: () => new StageError({ message: `cannot load ${file}` }),
    });
    const fields =
      typeof module === "object" && module !== null && "default" in module
        ? module.default
        : undefined;
    if (!Schema.isSchema(fields) || !("fields" in fields))
      return yield* new StageError({
        message: `${STAGE_ENV_MODULE} must export a Schema.Struct of the stage's fields as its default`,
      });
    return fields as StageFields;
  },
);

/** `.env.<stage>` at the app's root, checked against the app's fields. */
const readStageFile = Effect.fn("DeployedStage.readStageFile")(function* (
  stage: Deployed,
) {
  const fields = yield* loadStageFields();
  const name = `.env.${stage}`;
  const text = yield* (yield* FileSystem.FileSystem)
    .readFileString(path.join(ROOT, name))
    .pipe(
      Effect.mapError(
        () => new StageError({ message: `cannot read ${name} at ${ROOT}` }),
      ),
    );
  const file = Object.fromEntries(
    Object.entries(parseEnv(text)).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return yield* stageVariables(fields, file, name);
});

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
        TriggerVariables,
        "cf builds triggers environment-variables list",
      ),
    ),
  );

/**
 * Whether the Worker builds branches other than its own; `false` when Builds has no configuration
 * for it (`cf` exits 1 on the 404). Previews can also be a second trigger, which
 * {@link triggerPlan} deletes.
 */
const previewsEnabled = (tag: string) =>
  runCommand("cf", ["builds", "workers", "get", tag]).pipe(
    Effect.flatMap(
      decodeJson(
        Schema.Struct({ previews_enabled: Schema.Boolean }),
        "cf builds workers get",
      ),
    ),
    Effect.map((config) => config.previews_enabled),
    Effect.catchTag("CommandError", () => Effect.succeed(false)),
  );

const git = (args: readonly string[]) =>
  runCommand("git", ["-C", ROOT, ...args]).pipe(
    Effect.map((output) => output.trim()),
    Effect.mapError((error) => new StageError({ message: error.message })),
  );

/** The app's GitHub repository, from `origin`. */
const githubRepo = Effect.fn("DeployedStage.githubRepo")(function* () {
  const url = yield* git(["remote", "get-url", "origin"]);
  const match = /github\.com[:/](?<owner>[^/]+)\/(?<name>.+?)(?:\.git)?$/u.exec(
    url,
  );
  if (match === null)
    return yield* new StageError({
      message: `origin is not a GitHub repository: ${url}`,
    });
  return { owner: match.groups?.owner ?? "", name: match.groups?.name ?? "" };
});

/**
 * The repository connection Builds reaches the app's repository through. Every trigger of the
 * repository shares one, so it is reused from a trigger on either deployed stage; with none
 * (an app's first trigger), it is upserted from GitHub's ids. Either way the Cloudflare GitHub
 * App must already have access to the repository, which only the owner can grant.
 */
const repoConnection = Effect.fn("DeployedStage.repoConnection")(function* () {
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
  const connection = yield* cf([
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
  ]).pipe(
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

/** The Website's triggers, read, and the {@link triggerPlan} for them; a missing Website has none. */
const readTriggers = Effect.fn("DeployedStage.readTriggers")(function* (
  stage: Deployed,
  tag: Option.Option<string>,
) {
  const canonical = canonicalTrigger(stage, yield* sharedBuildToken());
  const repo = yield* githubRepo();
  const triggers = Option.isSome(tag) ? yield* listTriggers(tag.value) : [];
  const previews = Option.isSome(tag)
    ? yield* previewsEnabled(tag.value)
    : false;
  return {
    canonical,
    ...triggerPlan(canonical, repo.name, triggers, previews),
  };
});

/**
 * Makes the stage's one trigger canonical ({@link triggerPlan}), then reads it back and requires
 * nothing left to do. Returns the trigger's uuid.
 */
const ensureTrigger = Effect.fn("DeployedStage.ensureTrigger")(function* (
  stage: Deployed,
  tag: string,
) {
  const { canonical, kept, steps } = yield* readTriggers(
    stage,
    Option.some(tag),
  );
  const apply = (step: TriggerStep) => {
    switch (step._tag) {
      case "Create": {
        return Effect.gen(function* () {
          const created = yield* cf([
            "builds",
            "triggers",
            "create",
            "--body",
            JSON.stringify({
              ...canonical,
              external_script_id: tag,
              repo_connection_uuid: yield* repoConnection(),
            }),
          ]).pipe(
            Effect.flatMap(
              decodeJson(
                Schema.Struct({ trigger_uuid: Schema.String }),
                "cf builds triggers create",
              ),
            ),
          );
          return Option.some(created.trigger_uuid);
        });
      }
      case "Update": {
        return cf([
          "builds",
          "triggers",
          "update",
          step.trigger.trigger_uuid,
          "--body",
          JSON.stringify(canonical),
        ]).pipe(Effect.as(Option.none<string>()));
      }
      case "Delete": {
        return cf([
          "builds",
          "triggers",
          "delete",
          step.trigger.trigger_uuid,
          "--force",
        ]).pipe(Effect.as(Option.none<string>()));
      }
      case "DisablePreviews": {
        return cf([
          "builds",
          "workers",
          "update",
          tag,
          "--previews-enabled",
          "false",
        ]).pipe(Effect.as(Option.none<string>()));
      }
    }
  };
  const created = yield* Effect.forEach(steps, (step) =>
    apply(step).pipe(
      Effect.tap(() =>
        Console.error(`stage: did ${describeStep(stage)(step)}`),
      ),
    ),
  );
  const uuid = Option.getOrUndefined(
    Option.orElse(Option.firstSomeOf(created), () =>
      Option.fromNullishOr(kept?.trigger_uuid),
    ),
  );
  const after = yield* readTriggers(stage, Option.some(tag));
  if (after.steps.length > 0 || uuid === undefined)
    return yield* new StageError({
      message: `the ${stage} trigger is still not canonical: it needs ${after.steps.map(describeStep(stage)).join("; ")}`,
    });
  return uuid;
});

/**
 * Sets every variable in one request and deletes the trigger's {@link staleVariables}, upsert
 * first so the trigger never lacks a value. The body, secrets included, goes to `cf` as a file in a
 * temporary directory only this user can read, removed after, never on argv.
 */
const syncVariables = Effect.fn("DeployedStage.syncVariables")(function* (
  triggerUuid: string,
  variables: readonly StageVariable[],
) {
  const fs = yield* FileSystem.FileSystem;
  const failed = () =>
    new StageError({ message: "cannot write the variables' request body" });
  const directory = yield* fs
    .makeTempDirectoryScoped({ prefix: "devkit-stage-" })
    .pipe(Effect.mapError(failed));
  const body = path.join(directory, "variables.json");
  yield* fs
    .writeFileString(
      body,
      JSON.stringify(
        Object.fromEntries(
          variables.map(({ name, value, secret }) => [
            name,
            { value: Redacted.value(value), is_secret: secret },
          ]),
        ),
      ),
      { mode: 0o600 },
    )
    .pipe(Effect.mapError(failed));
  yield* cf([
    "builds",
    "triggers",
    "environment-variables",
    "upsert",
    triggerUuid,
    "--body",
    `@${body}`,
  ]);
  yield* Console.error(
    `stage: set ${variables.map(({ name }) => name).join(", ")}`,
  );
  for (const name of staleVariables(
    variables,
    yield* triggerVariables(triggerUuid),
  )) {
    yield* cf([
      "builds",
      "triggers",
      "environment-variables",
      "delete",
      name,
      "--trigger-uuid",
      triggerUuid,
      "--force",
    ]);
    yield* Console.error(`stage: deleted ${name}`);
  }
}, Effect.scoped);

/**
 * Refuses unless the checkout is clean and its `HEAD` is the stage's branch on `origin`, fetched
 * now, so a deploy from it ships exactly the commit a Builds deploy would.
 */
const requireBranchCheckout = Effect.fn("DeployedStage.requireBranchCheckout")(
  function* (stage: Deployed) {
    const branch = branchOf(stage);
    if ((yield* git(["status", "--porcelain"])) !== "")
      return yield* new StageError({
        message: `the first deploy of ${stage} ships this checkout, which has uncommitted changes; commit or stash them, then rerun`,
      });
    yield* git(["fetch", "origin", branch]);
    const head = yield* git(["rev-parse", "HEAD"]);
    const remote = yield* git(["rev-parse", `origin/${branch}`]);
    if (head !== remote)
      return yield* new StageError({
        message: `the first deploy of ${stage} ships this checkout, whose HEAD ${head} is not origin/${branch} ${remote}; check out ${branch} at origin/${branch} (git switch ${branch}, then git pull --ff-only if behind or git push if ahead), then rerun`,
      });
  },
);

/**
 * The Website's tag. A stage with none gets its first deploy here, since a trigger needs the
 * Worker it is keyed to: Alchemy from this checkout, once {@link requireBranchCheckout} passes,
 * with the file's values in its environment as Builds passes them.
 */
export const ensureWebsite = Effect.fn("DeployedStage.ensureWebsite")(
  function* (stage: Deployed, variables: readonly StageVariable[]) {
    const tag = yield* findTag(websiteOf(stage));
    if (Option.isSome(tag)) return tag.value;
    yield* requireBranchCheckout(stage);
    yield* alchemy(["deploy", "--stage", stage, "--yes"], "up", variables);
    const deployed = yield* findTag(websiteOf(stage));
    if (Option.isNone(deployed))
      return yield* new StageError({
        message: `the first deploy of ${stage} made no ${websiteOf(stage)}`,
      });
    return deployed.value;
  },
);

const Build = Schema.Struct({
  build_uuid: Schema.String,
  status: Schema.String,
  build_outcome: Schema.NullOr(Schema.String),
});

const BUILD_POLL = Duration.seconds(15);
const BUILD_TIMEOUT = Duration.minutes(30);

/** Starts a build of the stage's branch and waits for its outcome. */
const build = Effect.fn("DeployedStage.build")(function* (
  stage: Deployed,
  triggerUuid: string,
) {
  const started = yield* cf([
    "builds",
    "create",
    triggerUuid,
    "--branch",
    branchOf(stage),
  ]).pipe(Effect.flatMap(decodeJson(Build, "cf builds create")));
  const logs = `cf builds logs get ${started.build_uuid}`;
  yield* Console.error(
    `stage: started build ${started.build_uuid} of ${branchOf(stage)}; its log: ${logs}`,
  );
  const done = yield* cf(["builds", "get", started.build_uuid]).pipe(
    Effect.flatMap(decodeJson(Build, "cf builds get")),
    Effect.repeat({
      schedule: Schedule.spaced(BUILD_POLL),
      until: (current) => current.status === "stopped",
    }),
    Effect.timeoutOrElse({
      duration: BUILD_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new StageError({
            message: `build ${started.build_uuid} is still running; watch it with ${logs}`,
          }),
        ),
    }),
  );
  if (done.build_outcome !== "success")
    return yield* new StageError({
      message: `build ${done.build_uuid} ended ${done.build_outcome ?? "without an outcome"}; read ${logs}`,
    });
  yield* Console.log(`${stage}: build ${done.build_uuid} succeeded`);
});

/**
 * Makes the stage match `.env.<stage>`, whatever it holds now: the Website exists
 * ({@link ensureWebsite}), its one trigger is canonical, the trigger's variables are the file's, and a
 * build of the stage's branch ran with them. Every run writes every variable and starts a build,
 * so a rerun converges to the same end. Production writes only with `confirmed`. A dry run reads
 * and prints what it would write, names only.
 */
export const up = Effect.fn("DeployedStage.up")(function* (
  stage: Deployed,
  options: { readonly dryRun: boolean; readonly confirmed: boolean },
) {
  const variables = yield* readStageFile(stage);
  const names = variables.map(({ name }) => name).join(", ");
  yield* Console.log(`${stage}: .env.${stage} holds ${names}`);
  if (!options.dryRun && stage === "production" && !options.confirmed)
    return yield* new StageError({
      message:
        "up production writes production's configuration only with --confirm production",
    });
  if (options.dryRun) {
    const tag = yield* findTag(websiteOf(stage));
    const { kept, steps } = yield* readTriggers(stage, tag);
    const existing =
      kept === undefined ? {} : yield* triggerVariables(kept.trigger_uuid);
    const stale = staleVariables(variables, existing);
    const writes = [
      ...(Option.isNone(tag)
        ? [`first deploy of ${branchOf(stage)} from this checkout`]
        : []),
      ...steps.map(describeStep(stage)),
      `set ${names}`,
      ...(stale.length > 0 ? [`delete ${stale.join(", ")}`] : []),
      `start a build of ${branchOf(stage)} and wait for it`,
    ];
    yield* Console.log(
      `${stage}: up would\n${writes.map((write) => `  - ${write}`).join("\n")}`,
    );
    return;
  }
  const trigger = yield* ensureTrigger(
    stage,
    yield* ensureWebsite(stage, variables),
  );
  yield* syncVariables(trigger, variables);
  yield* build(stage, trigger);
  yield* Console.log(`${stage}: up`);
});

/** Alchemy's environment for `run`: the file's values as Builds passes them, and the run's reason. */
const alchemyEnv = (variables: readonly StageVariable[], run: StageRun) => ({
  ...Object.fromEntries(
    variables.map(({ name, value }) => [name, Redacted.value(value)]),
  ),
  [STAGE_RUN]: run,
});

/**
 * Runs Alchemy in the app's root as `run`, its output shown as it comes. Values go only in its
 * environment, never on argv.
 */
const alchemy = Effect.fn("DeployedStage.alchemy")(function* (
  args: readonly string[],
  run: StageRun,
  variables: readonly StageVariable[] = [],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* spawner
    .exitCode(
      ChildProcess.make("alchemy", [...args], {
        cwd: ROOT,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
        env: alchemyEnv(variables, run),
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

/**
 * `alchemy plan`'s output, captured, run with the file's values in its environment as Builds would
 * run the deploy. Without `--detailed` it names resources only, never values.
 */
const plan = Effect.fn("DeployedStage.plan")(function* (
  stage: Deployed,
  variables: readonly StageVariable[],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const failed = () => new StageError({ message: "cannot run alchemy plan" });
  const handle = yield* spawner
    .spawn(
      ChildProcess.make("alchemy", ["plan", "--stage", stage], {
        cwd: ROOT,
        stdin: "ignore",
        env: { ...alchemyEnv(variables, "check"), NO_COLOR: "1" },
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

const LatestBuilds = Schema.Array(
  Schema.Struct({
    build_uuid: Schema.String,
    build_outcome: Schema.NullOr(Schema.String),
  }),
);

export const check = Effect.fn("DeployedStage.check")(function* (
  stage: Deployed,
) {
  const variables = yield* readStageFile(stage);
  const problems: string[] = [];
  const planned = yield* plan(stage, variables);
  if (planned.ok) {
    yield* Console.log(`${stage}: plan succeeds`);
    if (replacesWebsite(planned.output))
      yield* Console.error(
        `stage: warning: the plan replaces the Website Worker, which deletes its trigger; run vp run stage up ${stage} after the deploy`,
      );
  } else {
    yield* Console.error(
      planned.output.trimEnd().split("\n").slice(-20).join("\n"),
    );
    problems.push("the plan fails");
  }
  const tag = yield* findTag(websiteOf(stage));
  if (Option.isNone(tag)) problems.push(`${websiteOf(stage)} does not exist`);
  else {
    const { kept, steps } = yield* readTriggers(stage, tag);
    problems.push(
      ...steps.map((step) => `it needs to ${describeStep(stage)(step)}`),
    );
    if (kept !== undefined) {
      problems.push(
        ...variableProblems(
          variables,
          yield* triggerVariables(kept.trigger_uuid),
        ),
      );
      const [latest] = yield* cf([
        "builds",
        "list",
        "--external-script-id",
        tag.value,
        "--per-page",
        "1",
      ]).pipe(Effect.flatMap(decodeJson(LatestBuilds, "cf builds list")));
      if (latest === undefined) problems.push("no build has run");
      else if (latest.build_outcome === "success")
        yield* Console.log(`${stage}: build ${latest.build_uuid} succeeded`);
      else
        problems.push(
          `the latest build ${latest.build_uuid} ended ${latest.build_outcome ?? "without an outcome yet"}`,
        );
    }
  }
  if (problems.length > 0)
    return yield* new StageError({
      message: `${stage}: ${problems.join("; ")}. Run vp run stage up ${stage}`,
    });
  yield* Console.log(
    `${stage}: the trigger is canonical and holds every field of .env.${stage}`,
  );
});

const reset = Effect.fn("DeployedStage.reset")(function* (
  stage: ResettableDeployed,
) {
  yield* readStageFile(stage);
  // The destroy leaves no Website, so `up` will need a first deploy from this checkout: check it
  // before destroying anything.
  yield* requireBranchCheckout(stage);
  yield* alchemy(["destroy", "--stage", stage, "--yes"], "reset");
  yield* up(stage, { dryRun: false, confirmed: false });
});

const toUserError = (error: StageError) =>
  new CliError.UserError({ cause: error, userMessage: error.message });

const stageArgument = Argument.Literals("stage", Deployed.literals).pipe(
  Argument.withDescription("staging or production"),
);

const upCommand = Command.make(
  "up",
  {
    stage: stageArgument,
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Read and print what up would write, names only"),
      Flag.withDefault(false),
    ),
    confirm: Flag.String("confirm").pipe(
      Flag.withDescription("production, to let up write production"),
      Flag.optional,
    ),
  },
  ({ stage, dryRun, confirm }) =>
    up(stage, {
      dryRun,
      confirmed: Option.contains(confirm, "production"),
    }).pipe(Effect.mapError(toUserError)),
).pipe(
  Command.withDescription(
    "Make the stage match .env.<stage>: the Website (a first deploy from this checkout, clean and at the stage's branch on origin, when it has none), its canonical trigger, the trigger's variables, and a build of the stage's branch.",
  ),
);

const checkCommand = Command.make(
  "check",
  { stage: stageArgument },
  ({ stage }) => check(stage).pipe(Effect.mapError(toUserError)),
).pipe(
  Command.withDescription(
    "Read only: whether the plan succeeds and replaces the Website, the trigger is canonical, its variables match .env.<stage> by name, and the latest build succeeded.",
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
    "Destroy staging, deleting its D1 and Durable Object data, then run up staging.",
  ),
);

// Only when run, so a test can import this module.
if (import.meta.main) {
  Command.make("stage").pipe(
    Command.withDescription(
      "Set up, check and reset staging and production's Workers Builds deploys.",
    ),
    Command.withSubcommands([upCommand, checkCommand, resetCommand]),
    Command.run({ version: "1.0.0" }),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
