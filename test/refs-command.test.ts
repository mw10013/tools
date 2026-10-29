import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as CliOutput from "effect/cli/CliOutput";
import * as Command from "effect/cli/Command";
import * as TestConsole from "effect/testing/TestConsole";

import { command } from "#refs/command.ts";

const run = (args: readonly string[]) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* Effect.result(
        Command.runWith(command, { version: "0.1.0" })(args),
      );
      return {
        result,
        output: (yield* TestConsole.logLines).join("\n"),
        errors: (yield* TestConsole.errorLines).join("\n"),
      };
    }).pipe(
      Effect.provide(TestConsole.layer),
      Effect.provide(
        CliOutput.layer(CliOutput.defaultFormatter({ colors: false })),
      ),
      Effect.provide(NodeServices.layer),
    ),
  );

await test("root help and no arguments show commands, shared flags, and examples without accessing a project", async () => {
  for (const args of [[], ["--help"], ["-h"]]) {
    const { output } = await run(args);
    assert.match(output, /refs <subcommand>/u);
    assert.match(output, /--project, -p/u);
    assert.match(output, /init\s+Prepare/u);
    assert.match(output, /status\s+Compare/u);
    assert.match(output, /sync\s+Download/u);
    assert.match(output, /EXAMPLES/u);
    assert.match(output, /vpx \.\/refs.ts sync effect/u);
  }
});

await test("each subcommand has help with inherited flags and a runnable example", async () => {
  for (const name of ["init", "status", "sync"]) {
    const { result, output } = await run([name, "--help"]);
    assert.equal(result._tag, "Success");
    assert.match(output, new RegExp(`refs ${name}`));
    assert.match(output, /--project, -p/u);
    assert.match(output, /EXAMPLES/u);
    if (name !== "init") {
      assert.match(output, /reference/u);
      assert.match(output, /effect/u);
    }
  }
});

await test("Effect handles version output, completions, and malformed invocations", async () => {
  const version = await run(["--version"]);
  assert.equal(version.result._tag, "Success");
  assert.match(version.output, /0\.1\.0/u);
  const completion = await run(["--completions", "zsh"]);
  assert.equal(completion.result._tag, "Success");
  assert.match(completion.output, /refs/u);
  for (const args of [
    ["unknown"],
    ["sync", "unknown"],
    ["status", "--unknown"],
    ["--project", path.resolve("package.json"), "status"],
    ["--project"],
  ]) {
    const { result, errors } = await run(args);
    assert.equal(result._tag, "Failure");
    assert.notEqual(errors, "");
  }
});

await test("shared project flags route handlers, and operation failures become user errors", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "refs-command-")));
  try {
    execFileSync("git", ["-C", root, "init", "-b", "main"], {
      stdio: "ignore",
    });
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ devDependencies: { effect: "4.0.5" } }),
    );
    const init = await run(["-p", root, "init"]);
    assert.equal(init.result._tag, "Success");
    assert.match(init.output, /Initialized Effect references/u);
    assert.equal(
      readFileSync(path.join(root, ".gitignore"), "utf8"),
      "/refs\n",
    );
    const status = await run(["status", "effect", "--project", root]);
    assert.equal(status.result._tag, "Success");
    assert.match(status.output, /missing; want 4\.0\.5/u);
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { effect: "^4.0.5" } }),
    );
    const failure = await run(["-p", root, "sync"]);
    assert.equal(failure.result._tag, "Failure");
    if (failure.result._tag === "Failure")
      assert.equal(failure.result.failure._tag, "UserError");
    assert.match(failure.errors, /exact version pin/u);
    assert.doesNotMatch(failure.errors, /at Project\./u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("the executable returns successful help and nonzero usage errors", () => {
  const entry = path.resolve("refs.ts");
  for (const args of [[], ["--help"], ["sync", "--help"]]) {
    const child = spawnSync("vpx", [entry, ...args], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /USAGE/u);
  }
  const child = spawnSync("vpx", [entry, "sync", "unknown"], {
    encoding: "utf8",
  });
  assert.equal(child.status, 1);
  assert.match(child.stdout + child.stderr, /unknown/u);
});
