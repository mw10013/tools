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

import { STAGE_RUN } from "#devkit/cloudflare/stage.ts";

import {
  decodeRecord,
  decodeStageConfig,
  deployedRunRefusal,
  DeployedRunRefusedError,
  guardDeployedRun,
  parseStageFile,
  ShellHoldsStageConfigError,
  shellOverrides,
  StageConfigRecordError,
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
const throughLocalState = (value: unknown) =>
  JSON.parse(JSON.stringify(encodeState(value), null, 2), reviveState);

/** `HttpStateStore`'s, which `Cloudflare.state()` is: the payload arrives parsed. */
const throughHttpState = (value: unknown) =>
  reviveStateRecursive(JSON.parse(JSON.stringify(encodeState(value))));

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
const evaluate = <A>(output: Output.Output<A>, stored: unknown) =>
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

describe("deployedRunRefusal", () => {
  it("allows Workers Builds on the stage's branch", () => {
    expect(
      deployedRunRefusal("staging", {
        WORKERS_CI: "1",
        WORKERS_CI_BRANCH: "main",
      }),
    ).toStrictEqual(Option.none());
    expect(
      deployedRunRefusal("production", {
        WORKERS_CI: "1",
        WORKERS_CI_BRANCH: "production",
      }),
    ).toStrictEqual(Option.none());
  });

  it("refuses a build of another branch", () => {
    expect(
      Option.getOrThrow(
        deployedRunRefusal("production", {
          WORKERS_CI: "1",
          WORKERS_CI_BRANCH: "main",
        }),
      ),
    ).toContain("deploys from branch production, not main");
  });

  it("refuses a hand-run alchemy on a laptop, naming the commands to use", () => {
    const refusal = Option.getOrThrow(deployedRunRefusal("production", {}));
    expect(refusal).toContain("push to production");
    expect(refusal).toContain("vp run stage check production");
    expect(refusal).toContain("vp run stage bootstrap production");
  });

  it("allows the stage CLI's runs, and only the reasons it sets", () => {
    for (const run of ["bootstrap", "reset", "check"])
      expect(deployedRunRefusal("staging", { [STAGE_RUN]: run })).toStrictEqual(
        Option.none(),
      );
    expect(
      Option.getOrThrow(deployedRunRefusal("staging", { [STAGE_RUN]: "1" })),
    ).toContain("Only vp run stage sets it");
  });
});

describe("guardDeployedRun", () => {
  const guard = (stage: string, env: Record<string, string>) => {
    const saved = { ...process.env };
    for (const name of [
      "WORKERS_CI",
      "WORKERS_CI_BRANCH",
      STAGE_RUN,
      ...Object.keys(Fields.fields),
    ])
      delete process.env[name];
    Object.assign(process.env, env);
    return guardDeployedRun(Fields).pipe(
      Effect.provideService(Alchemy.Stage, stage),
      Effect.exit,
      Effect.ensuring(
        Effect.sync(() => {
          process.env = saved;
        }),
      ),
    );
  };
  const defect = (exit: Exit.Exit<void>) =>
    Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

  it.effect(
    "dies on a hand-run deployed stage and passes a per-developer one",
    () =>
      Effect.gen(function* () {
        assert.instanceOf(
          defect(yield* guard("production", {})),
          DeployedRunRefusedError,
        );
        assert.isTrue(Exit.isSuccess(yield* guard("dev-mw", {})));
      }),
  );

  it.effect(
    "passes Workers Builds, then refuses a shell that sets a record field",
    () =>
      Effect.gen(function* () {
        const builds = { WORKERS_CI: "1", WORKERS_CI_BRANCH: "main" };
        assert.isTrue(Exit.isSuccess(yield* guard("staging", builds)));
        assert.instanceOf(
          defect(yield* guard("staging", { ...builds, API_KEY: "x" })),
          ShellHoldsStageConfigError,
        );
      }),
  );
});
