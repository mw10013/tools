import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { APP_NAME } from "#devkit/core/app.ts";

import {
  canonicalTrigger,
  replacesWebsite,
  stageVariables,
  type Trigger,
  triggerDrift,
  triggerPlan,
  undeclaredVariables,
  variableProblems,
} from "./deployed-stage.ts";

const TOKEN = "9faa0f15-edb6-4265-aa27-2f944dd4c14e";

/** Baton's production trigger as `cf builds triggers list` showed it on 2026-11-06. */
const listed = (overrides: Partial<Trigger> = {}): Trigger => ({
  trigger_uuid: "2aad0c41-2dfb-4356-8af6-3d8a705c92fd",
  trigger_name: "c028ea6f87854c129e76a0f7a2e3251b",
  build_token_uuid: TOKEN,
  build_command: "",
  deploy_command: "pnpm exec vp exec alchemy deploy --stage production --yes",
  root_directory: "/",
  branch_includes: ["production"],
  branch_excludes: [],
  path_includes: ["*"],
  path_excludes: [],
  build_caching_enabled: false,
  repo_connection: {
    repo_connection_uuid: "b4e1753e-dde3-4964-a5b1-8ff71afa0f1f",
    repo_name: "baton",
  },
  ...overrides,
});

describe("canonicalTrigger", () => {
  it("names the trigger after the Website and deploys through the stage's script", () => {
    expect(canonicalTrigger("staging", TOKEN)).toStrictEqual({
      trigger_name: `${APP_NAME}-website-staging`,
      build_token_uuid: TOKEN,
      build_command: "",
      deploy_command: "pnpm exec vp run deploy:staging",
      root_directory: "/",
      branch_includes: ["main"],
      branch_excludes: [],
      path_includes: ["*"],
      path_excludes: [],
      build_caching_enabled: false,
    });
    expect(canonicalTrigger("production", TOKEN).branch_includes).toStrictEqual(
      ["production"],
    );
  });
});

describe("triggerDrift", () => {
  it("names each setting that differs from the canonical trigger", () => {
    expect(
      triggerDrift(listed(), canonicalTrigger("production", TOKEN)),
    ).toStrictEqual(["trigger_name", "deploy_command"]);
  });

  it("is empty for a canonical trigger", () => {
    const canonical = canonicalTrigger("production", TOKEN);
    expect(triggerDrift(listed(canonical), canonical)).toStrictEqual([]);
  });

  it("catches a preview trigger's branches and another token", () => {
    expect(
      triggerDrift(
        listed({
          ...canonicalTrigger("staging", "other-token"),
          branch_includes: ["*"],
          branch_excludes: ["main"],
        }),
        canonicalTrigger("staging", TOKEN),
      ),
    ).toStrictEqual(["build_token_uuid", "branch_includes", "branch_excludes"]);
  });
});

/** Lines of baton's staging `alchemy plan` as `check` captured it on 2026-11-06. */
const PLAN = `[20:38:14.751] INFO: Plan ready (20.7s)
[20:38:14.752] INFO: Plan: 2 to update, 1 tasks
[20:38:14.752] INFO: [Backend] update
[20:38:14.753] INFO: [Database] noop
[20:38:14.753] INFO: [Website] update
[20:38:14.753] INFO: [Website/BACKEND] noop
[20:38:14.753] INFO: [Seed] run [action]
`;

describe("replacesWebsite", () => {
  it("spots the Website's replacement after the log prefix", () => {
    expect(
      replacesWebsite(PLAN.replace("[Website] update", "[Website] replace")),
    ).toBe(true);
    expect(
      replacesWebsite(
        "\u001B[90m[20:38:14.753]\u001B[0m \u001B[32mINFO\u001B[0m: \u001B[36m[Website]\u001B[0m \u001B[33mreplace\u001B[0m",
      ),
    ).toBe(true);
  });

  it("ignores an update and the replacement of another resource or a binding", () => {
    expect(replacesWebsite(PLAN)).toBe(false);
    expect(
      replacesWebsite(
        `${PLAN.replace("[Backend] update", "[Backend] replace").replace(
          "[Website/BACKEND] noop",
          "[Website/BACKEND] replace",
        )}[20:38:14.753] INFO: [WebsiteAssets] replace\n`,
      ),
    ).toBe(false);
  });
});

describe("triggerPlan", () => {
  const canonical = canonicalTrigger("production", TOKEN);

  it("is empty for one canonical trigger with previews off", () => {
    const trigger = listed(canonical);
    expect(triggerPlan(canonical, "baton", [trigger], false)).toStrictEqual({
      kept: trigger,
      steps: [],
    });
  });

  it("creates the trigger when the Website has none on the repository", () => {
    expect(
      triggerPlan(canonical, "baton", [], false).steps.map(({ _tag }) => _tag),
    ).toStrictEqual(["Create"]);
    const elsewhere = listed({
      repo_connection: { repo_connection_uuid: "x", repo_name: "other" },
    });
    expect(
      triggerPlan(canonical, "baton", [elsewhere], false).steps.map(
        ({ _tag }) => _tag,
      ),
    ).toStrictEqual(["Create", "Delete"]);
  });

  it("updates the stage branch's trigger in place, then deletes the rest and turns previews off", () => {
    const preview = listed({
      ...canonical,
      trigger_uuid: "preview",
      branch_includes: ["*"],
      branch_excludes: ["production"],
    });
    const own = listed();
    const { kept, steps } = triggerPlan(
      canonical,
      "baton",
      [preview, own],
      true,
    );
    expect(kept).toBe(own);
    expect(steps).toStrictEqual([
      {
        _tag: "Update",
        trigger: own,
        settings: ["trigger_name", "deploy_command"],
      },
      { _tag: "Delete", trigger: preview },
      { _tag: "DisablePreviews" },
    ]);
  });
});

const Fields = Schema.Struct({
  API_KEY: Schema.NonEmptyString,
  API_SECRET: Schema.Redacted(Schema.String.check(Schema.isPattern(/^sk_/u))),
});

const SECRET = "sk_s3cr3t-value";

const variablesOf = (file: Record<string, string>) =>
  Effect.runSyncExit(stageVariables(Fields, file, ".env.staging"));

const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "";

describe("stageVariables", () => {
  it("makes one variable per field, a Redacted field a secret, the value the file's raw string", () => {
    const exit = variablesOf({ API_KEY: "key", API_SECRET: SECRET });
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isFailure(exit)) return;
    expect(
      exit.value.map(({ name, value, secret }) => ({
        name,
        value: Redacted.value(value),
        secret,
      })),
    ).toStrictEqual([
      { name: "API_KEY", value: "key", secret: false },
      { name: "API_SECRET", value: SECRET, secret: true },
    ]);
  });

  it("names a missing, invalid or undeclared field, never a value", () => {
    const message = failureOf(
      variablesOf({ API_SECRET: "not-a-key", EXTRA: SECRET }),
    );
    expect(message).toContain("lacks or has invalid API_KEY, API_SECRET");
    expect(message).toContain(
      "holds EXTRA, which stacks/stage-env.ts does not declare",
    );
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain("not-a-key");
  });

  it("refuses an empty value for a non-empty field", () => {
    expect(
      failureOf(variablesOf({ API_KEY: "", API_SECRET: SECRET })),
    ).toContain("lacks or has invalid API_KEY");
  });
});

describe("trigger variables", () => {
  const exit = variablesOf({ API_KEY: "key", API_SECRET: SECRET });
  const variables = Exit.isSuccess(exit) ? exit.value : [];

  it("finds the trigger's variables no field declares", () => {
    expect(
      undeclaredVariables(variables, {
        API_KEY: { is_secret: false },
        OLD: { is_secret: true },
      }),
    ).toStrictEqual(["OLD"]);
  });

  it("reports a missing name, a wrong secrecy and an undeclared name, and nothing when they match", () => {
    expect(
      variableProblems(variables, {
        API_KEY: { is_secret: true },
        OLD: { is_secret: false },
      }),
    ).toStrictEqual([
      "the trigger holds API_KEY as a secret",
      "the trigger lacks API_SECRET",
      "the trigger holds OLD, which no field declares",
    ]);
    expect(
      variableProblems(variables, {
        API_KEY: { is_secret: false },
        API_SECRET: { is_secret: true },
      }),
    ).toStrictEqual([]);
  });
});
