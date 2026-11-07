import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import { STAGE_RUN } from "#devkit/cloudflare/stage.ts";
import { APP_NAME, ROOT } from "#devkit/core/app.ts";

import {
  canonicalTrigger,
  check,
  ensureTrigger,
  replacesWebsite,
  STAGE_CONFIG_STACK,
  type Trigger,
  triggerDrift,
  writeStageConfig,
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
        PLAN.replace("[Backend] update", "[Backend] replace")
          .replace("[Website/BACKEND] noop", "[Website/BACKEND] replace")
          .concat("[20:38:14.753] INFO: [WebsiteAssets] replace\n"),
      ),
    ).toBe(false);
  });
});

const TAG = "c028ea6f87854c129e76a0f7a2e3251b";

/**
 * A spawner that answers each command line from `outputs` and records what ran, with the
 * environment it was given; an unlisted command fails, so a write would show.
 */
const fakeSpawner = (outputs: Record<string, string>) => {
  const ran: Array<{
    line: string;
    stageRun: unknown;
  }> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (command._tag !== "StandardCommand")
        throw new Error("unexpected piped command");
      const line = [command.command, ...command.args]
        .map((word) => (Redacted.isRedacted(word) ? "<redacted>" : word))
        .join(" ");
      ran.push({ line, stageRun: command.options.env?.[STAGE_RUN] });
      const out = outputs[line];
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(
          ChildProcessSpawner.ExitCode(out === undefined ? 1 : 0),
        ),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(out ?? "")),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  return { spawner, ran };
};

/** A Cloudflare account whose staging Website has one canonical trigger and a plan that succeeds. */
const canonicalAccount = () => {
  const canonical = canonicalTrigger("staging", TOKEN);
  return fakeSpawner({
    [`cf workers scripts search --name ${APP_NAME}-website-staging`]:
      JSON.stringify([{ id: TAG, script_name: `${APP_NAME}-website-staging` }]),
    "cf builds tokens list": JSON.stringify([
      {
        build_token_uuid: TOKEN,
        build_token_name: "Workers Builds - 2026-05-31 17:29",
      },
    ]),
    [`git -C ${ROOT} remote get-url origin`]:
      "git@github.com:mw10013/baton.git\n",
    [`cf builds triggers list --external-script-id ${TAG}`]: JSON.stringify([
      listed(canonical),
    ]),
    "cf builds triggers environment-variables list --trigger-uuid 2aad0c41-2dfb-4356-8af6-3d8a705c92fd":
      "{}",
    [`cf builds workers get ${TAG}`]: JSON.stringify({
      previews_enabled: false,
    }),
    "alchemy plan --stage staging": PLAN,
  });
};

const run = <A, E>(
  effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
) => {
  const lines: Array<string> = [];
  const console: Console.Console = Object.assign(
    Object.create(globalThis.console),
    {
      log: (...args: ReadonlyArray<unknown>) => lines.push(args.join(" ")),
      error: (...args: ReadonlyArray<unknown>) => lines.push(args.join(" ")),
    },
  );
  return Effect.runPromise(
    effect.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(Console.Console, console),
      Effect.exit,
    ),
  ).then((exit) => ({ exit, lines }));
};

describe("ensureTrigger", () => {
  it("says a canonical trigger is canonical on a dry run, and writes nothing", async () => {
    const { spawner, ran } = canonicalAccount();
    const { exit, lines } = await run(ensureTrigger("staging", true), spawner);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(lines).toContain("stage: the staging trigger needed no change");
    expect(lines).toContain(
      `staging: the trigger on ${APP_NAME}-website-staging is canonical`,
    );
    expect(ran.filter(({ line }) => line.includes("--dry-run"))).toStrictEqual(
      [],
    );
  });
});

describe("check", () => {
  it("marks its plan as the stage CLI's check, so the app stack lets it run", async () => {
    const { spawner, ran } = canonicalAccount();
    const { exit } = await run(check("staging"), spawner);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(
      ran.find(({ line }) => line.startsWith("alchemy plan"))?.stageRun,
    ).toBe("check");
  });
});

describe("writeStageConfig", () => {
  it("deploys the writer stack as the stage CLI's config run, so the state store lets it write", async () => {
    const line = `alchemy deploy --config ${STAGE_CONFIG_STACK} --stage production --yes`;
    const { spawner, ran } = fakeSpawner({ [line]: "" });
    const { exit } = await run(writeStageConfig("production"), spawner);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(ran).toStrictEqual([{ line, stageRun: "config" }]);
  });
});
