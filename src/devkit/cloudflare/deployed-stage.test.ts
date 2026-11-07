import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { APP_NAME } from "#devkit/core/app.ts";

import {
  branchOf,
  canonicalTrigger,
  deployRefusal,
  replacesWebsite,
  type Trigger,
  triggerDrift,
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

describe("deployRefusal", () => {
  it("allows Workers Builds on the stage's branch", () => {
    expect(
      deployRefusal(
        "staging",
        { WORKERS_CI: "1", WORKERS_CI_BRANCH: "main" },
        false,
      ),
    ).toStrictEqual(Option.none());
    expect(
      deployRefusal(
        "production",
        { WORKERS_CI: "1", WORKERS_CI_BRANCH: "production" },
        false,
      ),
    ).toStrictEqual(Option.none());
  });

  it("refuses a build of another branch", () => {
    expect(
      Option.getOrThrow(
        deployRefusal(
          "production",
          { WORKERS_CI: "1", WORKERS_CI_BRANCH: "main" },
          false,
        ),
      ),
    ).toContain("not main");
  });

  it("refuses a laptop unless the owner bootstraps", () => {
    expect(Option.getOrThrow(deployRefusal("staging", {}, false))).toContain(
      "--bootstrap",
    );
    expect(deployRefusal("production", {}, true)).toStrictEqual(Option.none());
  });

  it("maps each stage to its branch", () => {
    expect([branchOf("staging"), branchOf("production")]).toStrictEqual([
      "main",
      "production",
    ]);
  });
});

describe("replacesWebsite", () => {
  it("spots the Website's replacement in a plain or colored plan", () => {
    expect(
      replacesWebsite(
        "Plan: 1 to replace, 2 to update\n[Backend] update\n[Website] replace\n",
      ),
    ).toBe(true);
    expect(
      replacesWebsite(
        "\u001B[36m[Website]\u001B[0m \u001B[33mreplace\u001B[0m",
      ),
    ).toBe(true);
  });

  it("ignores an update and another resource's replacement", () => {
    expect(replacesWebsite("[Website] update\n[WebsiteAssets] replace\n")).toBe(
      false,
    );
  });
});
