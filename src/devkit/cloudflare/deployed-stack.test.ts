import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import {
  encodeState,
  reviveState,
  reviveStateRecursive,
  State,
} from "alchemy/State";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { STAGE_RUN, StageRun } from "#devkit/cloudflare/stage.ts";

import {
  alchemyCommandOf,
  decodeRecord,
  decodeStageConfig,
  deployedRunRefusal,
  DeployedRunRefusedError,
  guardDeployedRun,
  guardShell,
  parseStageFile,
  refuseUnsafeNuke,
  ShellHoldsStageConfigError,
  shellOverrides,
  StageConfigRecordError,
  UnsafeNukeRefusedError,
} from "./deployed-stack.ts";

const Fields = Schema.Struct({
  API_KEY: Schema.NonEmptyString,
  API_SECRET: Schema.Redacted(Schema.NonEmptyString),
  RETRIES: Schema.FiniteFromString,
});

const SECRET = "s3cr3t-value";

/** What the writer stack returns, so what Alchemy persists as its output. */
const written = {
  API_KEY: "key",
  API_SECRET: Redacted.make(SECRET),
  RETRIES: 3,
};

/** `LocalState`'s write then read of a stack output. */
const throughLocalState = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(encodeState(value), null, 2), reviveState);

/** `HttpStateStore`'s, which `Cloudflare.state()` is: the payload arrives parsed. */
const throughHttpState = (value: unknown): unknown => {
  const payload = JSON.stringify(encodeState(value));
  return reviveStateRecursive(JSON.parse(payload));
};

const writeEnv = (text: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deployed-stack-"));
  const file = path.join(dir, ".env.staging");
  fs.writeFileSync(file, text);
  return file;
};

describe("a Redacted field through Alchemy state", () => {
  for (const [store, roundTrip] of [
    ["local", throughLocalState],
    ["Cloudflare", throughHttpState],
  ] as const) {
    it(`persists the value and reads back a Redacted (${store} state)`, () => {
      assert.include(JSON.stringify(encodeState(written)), SECRET);
      const read = roundTrip(written) as Record<string, unknown>;
      assert.isTrue(Redacted.isRedacted(read.API_SECRET));
      assert.strictEqual(read.RETRIES, 3);
    });

    it.effect(`decodes against the Type side (${store} state)`, () =>
      Effect.gen(function* () {
        const decoded = yield* decodeRecord(Fields)(roundTrip(written));
        assert.strictEqual(Redacted.value(decoded.API_SECRET), SECRET);
        assert.strictEqual(decoded.RETRIES, 3);
      }),
    );
  }

  it("would fail against the Encoded side, which expects the dotenv string", () => {
    const exit = Schema.decodeUnknownExit(Fields)(throughLocalState(written));
    assert.isTrue(Exit.isFailure(exit));
  });
});

describe("decodeRecord", () => {
  it.effect("names a missing field and an invalid one, never a value", () =>
    Effect.gen(function* () {
      const error = yield* decodeRecord(Fields)({
        API_SECRET: Redacted.make(""),
        RETRIES: 3,
      }).pipe(Effect.flip);
      assert.instanceOf(error, StageConfigRecordError);
      assert.deepStrictEqual(error.fields, ["API_KEY", "API_SECRET"]);
      assert.notInclude(error.message, SECRET);
    }),
  );
});

/** Resolves an Output the way Alchemy does at plan time, against a stored record. */
const evaluate = <A>(output: Output.Output<A, never>, stored: unknown) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    yield* state.setOutput({
      stack: "app-stage-config",
      stage: "staging",
      value: throughLocalState(stored),
    });
    return yield* Output.evaluate(output, {});
  }).pipe(
    Effect.provide(Alchemy.inMemoryState()),
    Effect.provideService(Alchemy.Stage, "staging"),
  );

describe("decodeStageConfig", () => {
  const record = decodeStageConfig(Fields)(
    Effect.runSync(
      Output.stackRef<typeof Fields.Type>("app-stage-config", {
        stage: "staging",
      }),
    ),
  );

  it.effect("resolves each field from the stored record", () =>
    Effect.gen(function* () {
      const secret = yield* evaluate(record.API_SECRET, written);
      assert.strictEqual(Redacted.value(secret), SECRET);
    }),
  );

  it.effect("fails the evaluation when the record lacks a field", () =>
    Effect.gen(function* () {
      const exit = yield* evaluate(record.API_KEY, {
        API_SECRET: Redacted.make(SECRET),
        RETRIES: 3,
      }).pipe(Effect.exit);
      assert.isTrue(Exit.hasDies(exit));
      assert.include(String(Exit.isFailure(exit) && exit.cause), "API_KEY");
    }),
  );
});

describe("parseStageFile", () => {
  it.effect("reads the file and ignores the shell", () =>
    Effect.gen(function* () {
      const file = writeEnv(`API_KEY=key\nAPI_SECRET=${SECRET}\nRETRIES=3\n`);
      process.env.API_KEY = "from-the-shell";
      const record = yield* parseStageFile(Fields, file).pipe(
        Effect.ensuring(Effect.sync(() => delete process.env.API_KEY)),
      );
      assert.strictEqual(record.API_KEY, "key");
      assert.strictEqual(Redacted.value(record.API_SECRET), SECRET);
      assert.strictEqual(record.RETRIES, 3);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "names the fields the file lacks or gets wrong, never a value",
    () =>
      Effect.gen(function* () {
        const file = writeEnv(`API_SECRET=${SECRET}\nRETRIES=three\n`);
        process.env.API_KEY = "from-the-shell";
        const error = yield* parseStageFile(Fields, file).pipe(
          Effect.flip,
          Effect.ensuring(Effect.sync(() => delete process.env.API_KEY)),
        );
        assert.include(error.message, "API_KEY, RETRIES");
        assert.notInclude(error.message, SECRET);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("shellOverrides", () => {
  it("lists only the record's names the shell sets", () => {
    assert.deepStrictEqual(
      shellOverrides(Fields, { PATH: "/bin", API_SECRET: "x", RETRIES: "" }),
      ["API_SECRET", "RETRIES"],
    );
  });
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
      expect(refusal).toContain("vp run stage bootstrap production");
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
      ["bootstrap", "deploy", "production"],
      ["config", "deploy", "production"],
      ["check", "plan", "production"],
      ["reset", "destroy", "staging"],
      ["reset", "deploy", "staging"],
    ] as const;
    for (const [run, command, stage] of allowed)
      expect(
        deployedRunRefusal(stage, command, { [STAGE_RUN]: run }),
      ).toStrictEqual(Option.none());
    const refused = [
      ["bootstrap", "destroy", "staging"],
      ["config", "destroy", "staging"],
      ["check", "deploy", "staging"],
      ["check", "destroy", "staging"],
      ["reset", "plan", "staging"],
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
          { [STAGE_RUN]: "bootstrap" },
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

describe("guardShell", () => {
  const guard = (stage: string, env: Record<string, string>) =>
    withRun(
      guardShell(Fields).pipe(Effect.provideService(Alchemy.Stage, stage)),
      env,
      ["deploy", "--stage", stage],
    );

  it.effect(
    "refuses a deployed stage whose shell sets a record field, and ignores a per-developer one",
    () =>
      Effect.gen(function* () {
        assert.isTrue(Exit.isSuccess(yield* guard("staging", {})));
        assert.instanceOf(
          defect(yield* guard("staging", { API_KEY: "x" })),
          ShellHoldsStageConfigError,
        );
        assert.isTrue(Exit.isSuccess(yield* guard("dev-mw", { API_KEY: "x" })));
      }),
  );
});
