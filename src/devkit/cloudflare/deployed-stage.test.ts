import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { APP_NAME } from "#devkit/core/app.ts";

import {
  canonicalTrigger,
  ensureWebsite,
  replacesWebsite,
  stageVariables,
  staleVariables,
  type Trigger,
  triggerDrift,
  triggerPlan,
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
  CONTROL_TOKEN: Schema.optional(
    Schema.Redacted(Schema.String.check(Schema.isPattern(/^ct_/u))),
  ),
});

const SECRET = "sk_s3cr3t-value";
const CONTROL_TOKEN = "ct_s3cr3t-token";

const variablesOf = (file: Record<string, string>) =>
  Effect.runSyncExit(stageVariables(Fields, file, ".env.staging"));

const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "";

const shownVariablesOf = (file: Record<string, string>) => {
  const exit = variablesOf(file);
  return Exit.isSuccess(exit)
    ? exit.value.map(({ name, value, secret }) => ({
        name,
        value: Redacted.value(value),
        secret,
      }))
    : failureOf(exit);
};

describe("stageVariables", () => {
  it("makes one variable per field the file sets, a Redacted field a secret, the value the file's raw string", () => {
    expect(
      shownVariablesOf({
        API_KEY: "key",
        API_SECRET: SECRET,
        CONTROL_TOKEN,
      }),
    ).toStrictEqual([
      { name: "API_KEY", value: "key", secret: false },
      { name: "API_SECRET", value: SECRET, secret: true },
      { name: "CONTROL_TOKEN", value: CONTROL_TOKEN, secret: true },
    ]);
  });

  it("makes no variable for an optional field the file leaves out or leaves empty", () => {
    const required = [
      { name: "API_KEY", value: "key", secret: false },
      { name: "API_SECRET", value: SECRET, secret: true },
    ];
    expect(
      shownVariablesOf({ API_KEY: "key", API_SECRET: SECRET }),
    ).toStrictEqual(required);
    expect(
      shownVariablesOf({
        API_KEY: "key",
        API_SECRET: SECRET,
        CONTROL_TOKEN: "",
      }),
    ).toStrictEqual(required);
  });

  it("names an optional field the file holds invalid, never its value", () => {
    const message = failureOf(
      variablesOf({
        API_KEY: "key",
        API_SECRET: SECRET,
        CONTROL_TOKEN: "bad-token",
      }),
    );
    expect(message).toContain("lacks or has invalid CONTROL_TOKEN");
    expect(message).not.toContain("bad-token");
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
  const variablesFor = (file: Record<string, string>) => {
    const exit = variablesOf(file);
    return Exit.isSuccess(exit) ? exit.value : [];
  };
  const variables = variablesFor({ API_KEY: "key", API_SECRET: SECRET });

  it("finds the trigger's variables the file does not set", () => {
    expect(
      staleVariables(variables, {
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
      "the trigger holds OLD, which the file does not set",
    ]);
    expect(
      variableProblems(variables, {
        API_KEY: { is_secret: false },
        API_SECRET: { is_secret: true },
      }),
    ).toStrictEqual([]);
  });

  it("deletes an optional field the file leaves out from the trigger, and sets it where the file holds it", () => {
    const trigger = {
      API_KEY: { is_secret: false },
      API_SECRET: { is_secret: true },
      CONTROL_TOKEN: { is_secret: true },
    };
    expect(variables.map(({ name }) => name)).toStrictEqual([
      "API_KEY",
      "API_SECRET",
    ]);
    expect(staleVariables(variables, trigger)).toStrictEqual(["CONTROL_TOKEN"]);
    expect(variableProblems(variables, trigger)).toStrictEqual([
      "the trigger holds CONTROL_TOKEN, which the file does not set",
    ]);
    const staging = variablesFor({
      API_KEY: "key",
      API_SECRET: SECRET,
      CONTROL_TOKEN,
    });
    expect(staleVariables(staging, trigger)).toStrictEqual([]);
    expect(variableProblems(staging, trigger)).toStrictEqual([]);
  });
});

/** `cf`, `git` and `alchemy` as `ensureWebsite` calls them, reading and writing files in `$DEVKIT_FAKES`. */
const FAKES = {
  cf: `#!/bin/sh
case "$*" in
  "workers scripts search --name "*) cat "$DEVKIT_FAKES/scripts.json" ;;
  *) echo "unexpected cf $*" >&2; exit 1 ;;
esac
`,
  git: `#!/bin/sh
shift 2
echo "$*" >> "$DEVKIT_FAKES/git.log"
case "$*" in
  "status --porcelain") cat "$DEVKIT_FAKES/status" ;;
  "fetch origin "*) ;;
  "rev-parse HEAD") cat "$DEVKIT_FAKES/head" ;;
  "rev-parse origin/"*) cat "$DEVKIT_FAKES/origin" ;;
  *) echo "unexpected git $*" >&2; exit 1 ;;
esac
`,
  alchemy: `#!/bin/sh
echo "$*" > "$DEVKIT_FAKES/alchemy.args"
echo "$DEVKIT_STAGE_RUN $API_KEY $API_SECRET" > "$DEVKIT_FAKES/alchemy.env"
cp "$DEVKIT_FAKES/deployed.json" "$DEVKIT_FAKES/scripts.json"
`,
};

describe("ensureWebsite", () => {
  const saved = { path: process.env.PATH, fakes: process.env.DEVKIT_FAKES };
  let fakes = "";
  const fake = (file: string) => path.join(fakes, file);
  const read = (file: string) =>
    fs.existsSync(fake(file)) ? fs.readFileSync(fake(file), "utf8") : "";
  const website = (stage: "staging" | "production", id: string) =>
    JSON.stringify([{ id, script_name: `${APP_NAME}-website-${stage}` }]);
  const checkout = (state: {
    status?: string;
    head?: string;
    origin?: string;
  }) => {
    fs.writeFileSync(fake("status"), state.status ?? "");
    fs.writeFileSync(fake("head"), state.head ?? "abc123\n");
    fs.writeFileSync(fake("origin"), state.origin ?? "abc123\n");
  };
  const exit = variablesOf({ API_KEY: "key", API_SECRET: SECRET });
  const variables = Exit.isSuccess(exit) ? exit.value : [];
  const run = (stage: "staging" | "production") =>
    Effect.runPromiseExit(
      ensureWebsite(stage, variables).pipe(Effect.provide(NodeServices.layer)),
    );

  beforeEach(() => {
    fakes = fs.mkdtempSync(path.join(os.tmpdir(), "devkit-stage-"));
    for (const [name, script] of Object.entries(FAKES))
      fs.writeFileSync(fake(name), script, { mode: 0o755 });
    fs.writeFileSync(fake("scripts.json"), "[]");
    fs.writeFileSync(fake("deployed.json"), website("staging", "tag-new"));
    process.env.PATH = `${fakes}:/usr/bin:/bin`;
    process.env.DEVKIT_FAKES = fakes;
  });

  afterEach(() => {
    process.env.PATH = saved.path;
    process.env.DEVKIT_FAKES = saved.fakes;
    fs.rmSync(fakes, { recursive: true, force: true });
  });

  it("reaches only the fake alchemy", () => {
    expect(
      (process.env.PATH ?? "")
        .split(":")
        .filter((directory) => fs.existsSync(path.join(directory, "alchemy"))),
    ).toStrictEqual([fakes]);
  });

  it("deploys a missing Website from a clean checkout at origin, values in the environment only", async () => {
    checkout({});
    const result = await run("staging");
    expect(Exit.isSuccess(result) && result.value).toBe("tag-new");
    expect(read("git.log")).toContain("fetch origin main");
    expect(read("alchemy.args")).toBe("deploy --stage staging --yes\n");
    expect(read("alchemy.env")).toBe(`up key ${SECRET}\n`);
  });

  it("checks production's checkout against origin/production", async () => {
    checkout({});
    fs.writeFileSync(fake("deployed.json"), website("production", "tag-prod"));
    const result = await run("production");
    expect(Exit.isSuccess(result) && result.value).toBe("tag-prod");
    expect(read("git.log")).toContain("rev-parse origin/production");
    expect(read("alchemy.args")).toBe("deploy --stage production --yes\n");
  });

  it("refuses a dirty checkout before deploying", async () => {
    checkout({ status: " M src/app.ts\n" });
    expect(failureOf(await run("staging"))).toContain(
      "has uncommitted changes; commit or stash them",
    );
    expect(read("alchemy.args")).toBe("");
  });

  it("refuses a checkout that is not origin's branch", async () => {
    checkout({ head: "abc123\n", origin: "def456\n" });
    expect(failureOf(await run("staging"))).toContain(
      "HEAD abc123 is not origin/main def456; check out main at origin/main (git switch main, then git pull --ff-only if behind or git push if ahead)",
    );
    expect(read("alchemy.args")).toBe("");
  });

  it("deploys nothing and reads no checkout when the Website exists", async () => {
    fs.writeFileSync(fake("scripts.json"), website("staging", "tag-old"));
    const result = await run("staging");
    expect(Exit.isSuccess(result) && result.value).toBe("tag-old");
    expect(read("git.log")).toBe("");
    expect(read("alchemy.args")).toBe("");
  });
});
