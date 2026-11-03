import { execFile, execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import * as Option from "effect/Option";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { RunId, runOutput, ServerName, stateOf } from "./domain.ts";

const execFileAsync = promisify(execFile);
const ENTRY = path.resolve(import.meta.dirname, "../../bosun.ts");

const FIXTURE = `
import http from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
if (process.argv[2] === "crash") { console.log("crashing on purpose"); process.exit(7); }
spawn("sleep", ["600"], { stdio: "ignore" });
const server = http.createServer((_, res) => res.end("hi"));
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  console.log("listening on " + port);
  console.error("a stderr line");
  writeFileSync(process.env.BOSUN_ENDPOINT, JSON.stringify({ port, url: "http://x.test/" + port }));
});
process.on("SIGTERM", () => { console.log("got SIGTERM"); server.close(() => process.exit(0)); });
`;

let checkout: string;

const bosun = (...args: Array<string>) => {
  const result = spawnSync("vpx", [ENTRY, ...args], {
    cwd: checkout,
    encoding: "utf8",
  });
  return {
    code: result.status,
    json: result.stdout.trim() === "" ? undefined : JSON.parse(result.stdout),
    stderr: result.stderr,
  };
};

const log = () =>
  fs.readFileSync(path.join(checkout, ".logs/dev/current"), "utf8");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

beforeEach(() => {
  checkout = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "bosun-test-")),
  );
  execFileSync("git", ["init", "-q"], { cwd: checkout });
  fs.writeFileSync(path.join(checkout, "server.mjs"), FIXTURE);
});

afterEach(() => {
  bosun("stop", "dev");
  fs.rmSync(checkout, { recursive: true, force: true });
});

describe("bosun", () => {
  it("starts, adopts, reports and stops a server, logging its run", () => {
    const started = bosun("start", "dev", "--", "node", "server.mjs");
    expect(started.code).toBe(0);
    expect(started.json).toMatchObject({ state: "running", name: "dev" });
    expect(started.json.url).toBe(`http://x.test/${started.json.port}`);

    const adopted = bosun("start", "dev", "--", "node", "server.mjs");
    expect(adopted.json.run).toBe(started.json.run);
    expect(adopted.stderr).toContain("adopted");

    expect(bosun("status", "dev").json.state).toBe("running");

    expect(bosun("stop", "dev").code).toBe(0);
    expect(alive(started.json.group)).toBe(false);
    const after = bosun("status", "dev");
    expect(after.code).toBe(3);
    expect(after.json.state).toBe("stopped");
    expect(log()).toContain("a stderr line");
    expect(log()).toContain("got SIGTERM");
    expect(log()).toContain(`==== dev exit run=${started.json.run} code=0`);
  }, 60_000);

  it("fails a start whose server exits, with that run's output", () => {
    const crashed = bosun("start", "dev", "--", "node", "server.mjs", "crash");
    expect(crashed.code).toBe(1);
    expect(crashed.json.error._tag).toBe("ServerExitedError");
    expect(crashed.json.error.message).toContain("crashing on purpose");
    expect(crashed.json.error.message).toContain("code=7");
  }, 60_000);

  it("stops an orphaned server before starting a new one", () => {
    const started = bosun("start", "dev", "--", "node", "server.mjs");
    process.kill(started.json.pid, "SIGKILL");
    expect(bosun("status", "dev").json.state).toBe("orphaned");

    const restarted = bosun("start", "dev", "--", "node", "server.mjs");
    expect(restarted.json.state).toBe("running");
    expect(restarted.json.run).not.toBe(started.json.run);
    expect(alive(started.json.group)).toBe(false);
  }, 60_000);

  it("runs one server for two starts at once", async () => {
    const launch = () =>
      execFileAsync(
        "vpx",
        [ENTRY, "start", "dev", "--", "node", "server.mjs"],
        {
          cwd: checkout,
        },
      ).then(({ stdout }) => JSON.parse(stdout));
    const [first, second] = await Promise.all([launch(), launch()]);
    expect(first.run).toBe(second.run);
  }, 60_000);
});

describe("runOutput", () => {
  const name = ServerName.make("dev");
  const run = RunId.make("0123abcd");
  const log = [
    "t0  ==== dev start 2026 run=ffffffff",
    "t1  old run",
    "t2  ==== dev exit run=ffffffff code=0",
    "t3  ==== dev start 2026 run=0123abcd store=x",
    "t4  line one",
    "t5  ==== dev exit run=0123abcd code=1",
    "t6  ==== dev start 2026 run=99999999",
  ].join("\n");

  it("keeps one run's lines through its exit marker", () => {
    expect(runOutput(log, name, run)).toEqual(
      Option.some("t4  line one\nt5  ==== dev exit run=0123abcd code=1"),
    );
  });

  it("is none for a run the log does not hold", () => {
    expect(runOutput(log, name, RunId.make("deadbeef"))).toEqual(Option.none());
  });
});

describe("stateOf", () => {
  const record = Option.some({
    bosun: 1 as const,
    name: ServerName.make("dev"),
    run: RunId.make("0123abcd"),
    pid: 10,
    group: 11,
    startedAt: "2026-11-03T00:00:00.000Z",
    command: ["node"],
  });

  it("reads a dead runner with a live group as orphaned", () => {
    expect(
      stateOf(record, { runner: false, group: true, answering: true }),
    ).toBe("orphaned");
  });

  it("reads a record with nothing alive as stopped", () => {
    expect(
      stateOf(record, { runner: false, group: false, answering: false }),
    ).toBe("stopped");
  });

  it("reads a live runner that does not answer yet as starting", () => {
    expect(
      stateOf(record, { runner: true, group: true, answering: false }),
    ).toBe("starting");
  });
});
