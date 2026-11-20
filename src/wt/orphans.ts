/**
 * Processes a checkout left running with no owner: their parent is the process that adopts
 * orphans, and they work inside the checkout. An integration run's workerd becomes one when the
 * test process dies mid-run: Alchemy's sidecar, workerd's parent, exits without stopping it, and
 * it holds its ports until someone kills it.
 *
 * On macOS orphans go to launchd, pid 1. On Linux they go to the nearest ancestor that is a child
 * subreaper (prctl(2) `PR_SET_CHILD_SUBREAPER`), which in a desktop session is the user's
 * `systemd --user` manager, and only otherwise to pid 1: measured on Arch (Omarchy), where a
 * shell's background `sleep` was adopted by `systemd --user`.
 *
 * @module
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import * as Duration from "effect/Duration";

export interface Orphan {
  readonly pid: number;
  /** The executable's path, as `ps -o comm=` prints it. */
  readonly command: string;
  readonly cwd: string;
}

const STOP_GRACE = Duration.seconds(3);
const STOP_POLL = Duration.millis(100);

const output = (program: string, args: readonly string[]) => {
  try {
    return execFileSync(program, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    // `lsof` exits 1 when some pid has gone, and still prints the rest.
    const stdout = (error as { stdout?: unknown }).stdout;
    return typeof stdout === "string" ? stdout : "";
  }
};

/** `ps -A -o pid=,ppid=,comm=` lines, as pid, parent pid and executable. */
export const parseProcesses = (text: string) =>
  text.split("\n").flatMap((line) => {
    const fields = /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<command>.+?)\s*$/u.exec(
      line,
    )?.groups;
    return fields?.pid === undefined ||
      fields.ppid === undefined ||
      fields.command === undefined
      ? []
      : [
          {
            pid: Number(fields.pid),
            ppid: Number(fields.ppid),
            command: fields.command,
          },
        ];
  });

/** `lsof -Fpn -d cwd` output, as pid to working directory. */
export const parseCwds = (text: string) => {
  const cwds = new Map<number, string>();
  let pid: number | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== undefined)
      cwds.set(pid, line.slice(1));
  }
  return cwds;
};

export const isWithin = (cwd: string, directory: string) =>
  cwd === directory || cwd.startsWith(`${directory}${path.sep}`);

type Process = ReturnType<typeof parseProcesses>[number];

/**
 * Whether a process's parent adopts orphans: pid 1, or on Linux a `systemd` manager, the
 * subreaper a session's orphans reach. Executables are compared by name, since `ps` may print a
 * bare name or a path.
 */
export const isAdopted = (
  process: Process,
  commands: ReadonlyMap<number, string>,
  platform: NodeJS.Platform,
) => {
  if (process.ppid === 1) return true;
  if (platform !== "linux") return false;
  const parent = commands.get(process.ppid);
  return parent !== undefined && path.basename(parent) === "systemd";
};

/** Each pid's working directory: `/proc/<pid>/cwd` on Linux, which has no `lsof` by default. */
const cwdsOf = (pids: readonly number[]) => {
  if (process.platform !== "linux")
    return parseCwds(
      output("lsof", [
        "-a",
        "-d",
        "cwd",
        "-Fpn",
        "-p",
        pids.map(String).join(","),
      ]),
    );
  const cwds = new Map<number, string>();
  for (const pid of pids) {
    try {
      cwds.set(pid, fs.readlinkSync(`/proc/${String(pid)}/cwd`));
    } catch {
      // Gone already, or not ours to read.
    }
  }
  return cwds;
};

/** The orphans whose working directory is `directory` or inside it. */
export const orphansIn = (directory: string): readonly Orphan[] => {
  const root = fs.realpathSync(directory);
  const processes = parseProcesses(
    output("ps", ["-A", "-o", "pid=,ppid=,comm="]),
  );
  const commands = new Map(processes.map(({ pid, command }) => [pid, command]));
  const parentless = processes.filter((candidate) =>
    isAdopted(candidate, commands, process.platform),
  );
  if (parentless.length === 0) return [];
  const cwds = cwdsOf(parentless.map(({ pid }) => pid));
  return parentless.flatMap(({ pid, command }) => {
    const cwd = cwds.get(pid);
    return cwd !== undefined && isWithin(cwd, root)
      ? [{ pid, command, cwd }]
      : [];
  });
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const signal = (pid: number, name: NodeJS.Signals) => {
  try {
    process.kill(pid, name);
  } catch {
    // Gone already.
  }
};

/** Sends each orphan SIGTERM, then SIGKILL to any still running after 3 s. */
export const stopOrphans = (orphans: readonly Orphan[]) => {
  for (const { pid } of orphans) signal(pid, "SIGTERM");
  const deadline = performance.now() + Duration.toMillis(STOP_GRACE);
  let running = orphans.filter(({ pid }) => alive(pid));
  while (running.length > 0 && performance.now() < deadline) {
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      Duration.toMillis(STOP_POLL),
    );
    running = running.filter(({ pid }) => alive(pid));
  }
  for (const { pid } of running) signal(pid, "SIGKILL");
};

export const describeOrphan = ({ pid, command }: Orphan) =>
  `pid ${String(pid)} (${path.basename(command)})`;
