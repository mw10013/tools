import { assert, describe, expect, it } from "@effect/vitest";
import * as Alchemy from "alchemy";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { STAGE_RUN, StageRun } from "#devkit/cloudflare/stage.ts";

import {
  alchemyCommandOf,
  checkStageEnv,
  deployedRunRefusal,
  DeployedRunRefusedError,
  guardDeployedRun,
  refuseUnsafeNuke,
  requireStageEnv,
  StageEnvMissingError,
  type StageFieldEnv,
  UnsafeNukeRefusedError,
} from "./deployed-stack.ts";

const Fields = Schema.Struct({
  API_KEY: Schema.NonEmptyString,
  API_SECRET: Schema.Redacted(Schema.NonEmptyString),
  CONTROL_TOKEN: Schema.optional(
    Schema.Redacted(Schema.String.check(Schema.isPattern(/^ct_/u))),
  ),
  REGION: Schema.optionalKey(Schema.Literals(["eu", "us"])),
});

const shown = (fields: readonly StageFieldEnv[]) =>
  fields.map((field) =>
    field._tag === "Set"
      ? { ...field, value: Redacted.value(field.value) }
      : field,
  );

describe("checkStageEnv", () => {
  it.effect(
    "finds a required field the environment lacks or holds invalid, and reads a secret's raw string",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(
          shown(yield* checkStageEnv(Fields, { API_KEY: "", API_SECRET: "s" })),
          [
            { _tag: "Invalid", name: "API_KEY" },
            { _tag: "Set", name: "API_SECRET", value: "s", secret: true },
            { _tag: "Absent", name: "CONTROL_TOKEN" },
            { _tag: "Absent", name: "REGION" },
          ],
        );
        assert.deepStrictEqual(shown(yield* checkStageEnv(Fields, {})), [
          { _tag: "Invalid", name: "API_KEY" },
          { _tag: "Invalid", name: "API_SECRET" },
          { _tag: "Absent", name: "CONTROL_TOKEN" },
          { _tag: "Absent", name: "REGION" },
        ]);
      }),
  );

  it.effect(
    "sets an optional field the environment holds, and finds one invalid",
    () =>
      Effect.gen(function* () {
        const required = { API_KEY: "key", API_SECRET: "s" };
        assert.deepStrictEqual(
          shown(
            yield* checkStageEnv(Fields, {
              ...required,
              CONTROL_TOKEN: "ct_1",
              REGION: "eu",
            }),
          ).slice(2),
          [
            { _tag: "Set", name: "CONTROL_TOKEN", value: "ct_1", secret: true },
            { _tag: "Set", name: "REGION", value: "eu", secret: false },
          ],
        );
        assert.deepStrictEqual(
          shown(
            yield* checkStageEnv(Fields, {
              ...required,
              CONTROL_TOKEN: "bad",
              REGION: "mars",
            }),
          ).slice(2),
          [
            { _tag: "Invalid", name: "CONTROL_TOKEN" },
            { _tag: "Invalid", name: "REGION" },
          ],
        );
      }),
  );

  it.effect(
    "takes an empty optional value as absent, as Config reads it in a Worker",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(
          shown(
            yield* checkStageEnv(Fields, {
              API_KEY: "key",
              API_SECRET: "s",
              CONTROL_TOKEN: "",
              REGION: "",
            }),
          ).slice(2),
          [
            { _tag: "Absent", name: "CONTROL_TOKEN" },
            { _tag: "Absent", name: "REGION" },
          ],
        );
      }),
  );
});

describe("alchemyCommandOf", () => {
  it("finds the first word naming an Alchemy command, as Alchemy's CLI does", () => {
    expect(
      alchemyCommandOf(["node", "cli.js", "destroy", "--stage", "production"]),
    ).toBe("destroy");
    expect(
      alchemyCommandOf(["node", "cli.js", "deploy", "--config", "plan.ts"]),
    ).toBe("deploy");
    expect(alchemyCommandOf(["node", "vitest"])).toBeUndefined();
  });
});

describe("deployedRunRefusal", () => {
  const builds = (branch: string) => ({
    WORKERS_CI: "1",
    WORKERS_CI_BRANCH: branch,
  });

  it("allows Workers Builds' deploy on the stage's branch", () => {
    expect(
      deployedRunRefusal("staging", "deploy", builds("main")),
    ).toStrictEqual(Option.none());
    expect(
      deployedRunRefusal("production", "deploy", builds("production")),
    ).toStrictEqual(Option.none());
  });

  it("takes a ProcessEnv that declares a named variable, as @types/node 25 does", () => {
    const env: { TZ?: string; [name: string]: string | undefined } =
      builds("main");
    expect(deployedRunRefusal("staging", "deploy", env)).toStrictEqual(
      Option.none(),
    );
  });

  it("refuses a build of another branch", () => {
    expect(
      Option.getOrThrow(
        deployedRunRefusal("production", "deploy", builds("main")),
      ),
    ).toContain("deploys from branch production, not main");
  });

  it("refuses a hand-run deploy or plan on a laptop, naming the commands to use", () => {
    for (const command of ["deploy", "plan"] as const) {
      const refusal = Option.getOrThrow(
        deployedRunRefusal("production", command, {}),
      );
      expect(refusal).toContain("push to production");
      expect(refusal).toContain("vp run stage check production");
    }
  });

  it("refuses a hand-run destroy, naming the one command that destroys", () => {
    for (const stage of ["staging", "production"] as const)
      expect(
        Option.getOrThrow(deployedRunRefusal(stage, "destroy", {})),
      ).toContain("only vp run stage reset staging destroys a deployed stage");
  });

  it("lets each run reason run only its own commands", () => {
    const allowed = [
      ["check", "plan", "production"],
      ["reset", "destroy", "staging"],
      ["up", "deploy", "staging"],
      ["up", "deploy", "production"],
    ] as const;
    for (const [run, command, stage] of allowed)
      expect(
        deployedRunRefusal(stage, command, { [STAGE_RUN]: run }),
      ).toStrictEqual(Option.none());
    const refused = [
      ["reset", "deploy", "staging"],
      ["check", "deploy", "staging"],
      ["check", "destroy", "staging"],
      ["reset", "plan", "staging"],
      ["up", "plan", "production"],
      ["up", "destroy", "staging"],
    ] as const;
    for (const [run, command, stage] of refused)
      expect(
        Option.isSome(deployedRunRefusal(stage, command, { [STAGE_RUN]: run })),
      ).toBe(true);
  });

  it("never lets anything destroy production", () => {
    for (const env of [
      builds("production"),
      ...StageRun.literals.map((run) => ({ [STAGE_RUN]: run })),
    ])
      expect(
        Option.isSome(deployedRunRefusal("production", "destroy", env)),
      ).toBe(true);
  });

  it("refuses a run that names no Alchemy command, and a reason the CLI never sets", () => {
    expect(
      Option.isSome(
        deployedRunRefusal("staging", undefined, { [STAGE_RUN]: "reset" }),
      ),
    ).toBe(true);
    expect(
      Option.getOrThrow(
        deployedRunRefusal("staging", "plan", { [STAGE_RUN]: "1" }),
      ),
    ).toContain("Only vp run stage sets it");
  });
});

/** Runs `effect` with only `env` of the run variables set, and `argv` as the process's. */
const withRun = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  env: Record<string, string>,
  argv: readonly string[],
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const saved = { env: { ...process.env }, argv: process.argv };
      for (const name of [
        "WORKERS_CI",
        "WORKERS_CI_BRANCH",
        STAGE_RUN,
        ...Object.keys(Fields.fields),
      ])
        Reflect.deleteProperty(process.env, name);
      Object.assign(process.env, env);
      process.argv = ["node", "cli.js", ...argv];
      return saved;
    }),
    () => Effect.exit(effect),
    (saved) =>
      Effect.sync(() => {
        process.env = saved.env;
        process.argv = saved.argv;
      }),
  );

const defect = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

describe("guardDeployedRun", () => {
  const guard = (stage: string, env: Record<string, string>) =>
    withRun(
      guardDeployedRun.pipe(Effect.provideService(Alchemy.Stage, stage)),
      env,
      ["destroy", "--stage", stage, "--yes"],
    );

  it.effect(
    "refuses a hand-run destroy of production, whatever reason the shell names",
    () =>
      Effect.gen(function* () {
        const envs: readonly Record<string, string>[] = [
          {},
          { [STAGE_RUN]: "check" },
          { [STAGE_RUN]: "reset" },
        ];
        for (const env of envs)
          assert.instanceOf(
            defect(yield* guard("production", env)),
            DeployedRunRefusedError,
          );
      }),
  );

  it.effect(
    "lets reset destroy staging, and any command run on a per-developer stage",
    () =>
      Effect.gen(function* () {
        assert.isTrue(
          Exit.isSuccess(yield* guard("staging", { [STAGE_RUN]: "reset" })),
        );
        assert.isTrue(Exit.isSuccess(yield* guard("dev-mw", {})));
      }),
  );
});

describe("refuseUnsafeNuke", () => {
  it.effect(
    "refuses alchemy unsafe nuke and lets every other command build",
    () =>
      Effect.gen(function* () {
        assert.instanceOf(
          defect(
            yield* withRun(refuseUnsafeNuke, {}, [
              "unsafe",
              "nuke",
              "alchemy.run.ts",
              "--dry-run",
            ]),
          ),
          UnsafeNukeRefusedError,
        );
        for (const argv of [
          ["deploy", "--stage", "dev-mw"],
          ["destroy", "--stage", "staging"],
          [],
        ])
          assert.isTrue(
            Exit.isSuccess(yield* withRun(refuseUnsafeNuke, {}, argv)),
          );
      }),
  );
});

describe("requireStageEnv", () => {
  const guard = (stage: string, env: Record<string, string>) =>
    withRun(
      requireStageEnv(Fields).pipe(Effect.provideService(Alchemy.Stage, stage)),
      env,
      ["deploy", "--stage", stage],
    );

  it.effect(
    "fails a deployed stage's deploy whose environment lacks a field, naming it, and ignores a per-developer stage",
    () =>
      Effect.gen(function* () {
        const missing = defect(yield* guard("staging", { API_KEY: "key" }));
        assert.instanceOf(missing, StageEnvMissingError);
        assert.deepStrictEqual(missing.names, ["API_SECRET"]);
        assert.include(missing.message, "vp run stage up staging");
        assert.isTrue(
          Exit.isSuccess(
            yield* guard("production", { API_KEY: "key", API_SECRET: "s" }),
          ),
        );
        assert.isTrue(Exit.isSuccess(yield* guard("dev-mw", {})));
      }),
  );

  it.effect(
    "passes a deployed stage without an optional field, and fails one holding it invalid",
    () =>
      Effect.gen(function* () {
        const required = { API_KEY: "key", API_SECRET: "s" };
        assert.isTrue(
          Exit.isSuccess(
            yield* guard("staging", { ...required, CONTROL_TOKEN: "ct_1" }),
          ),
        );
        const invalid = defect(
          yield* guard("production", { ...required, CONTROL_TOKEN: "bad" }),
        );
        assert.instanceOf(invalid, StageEnvMissingError);
        assert.deepStrictEqual(invalid.names, ["CONTROL_TOKEN"]);
      }),
  );
});
