import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as Duration from "effect/Duration";
// core/orphans.ts
/**
* Processes a checkout left running with no owner: their parent is pid 1, and they work inside
* the checkout. An integration run's workerd becomes one when the test process dies mid-run:
* Alchemy's sidecar, workerd's parent, exits without stopping it, and it holds its ports until
* someone kills it.
*
* @module
*/
const STOP_GRACE = Duration.seconds(3);
const STOP_POLL = Duration.millis(100);
const output = (program, args) => {
	try {
		return execFileSync(program, args, {
			encoding: "utf8",
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			]
		});
	} catch (error) {
		const stdout = error.stdout;
		return typeof stdout === "string" ? stdout : "";
	}
};
/** `ps -A -o pid=,ppid=,comm=` lines, as pid, parent pid and executable. */
const parseProcesses = (text) => text.split("\n").flatMap((line) => {
	const fields = /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<command>.+?)\s*$/u.exec(line)?.groups;
	return fields?.pid === void 0 || fields.ppid === void 0 || fields.command === void 0 ? [] : [{
		pid: Number(fields.pid),
		ppid: Number(fields.ppid),
		command: fields.command
	}];
});
/** `lsof -Fpn -d cwd` output, as pid to working directory. */
const parseCwds = (text) => {
	const cwds = /* @__PURE__ */ new Map();
	let pid;
	for (const line of text.split("\n")) if (line.startsWith("p")) pid = Number(line.slice(1));
	else if (line.startsWith("n") && pid !== void 0) cwds.set(pid, line.slice(1));
	return cwds;
};
const isWithin = (cwd, directory) => cwd === directory || cwd.startsWith(`${directory}${path.sep}`);
/** The orphans whose working directory is `directory` or inside it. */
const orphansIn = (directory) => {
	const root = fs.realpathSync(directory);
	const parentless = parseProcesses(output("ps", [
		"-A",
		"-o",
		"pid=,ppid=,comm="
	])).filter((process) => process.ppid === 1);
	if (parentless.length === 0) return [];
	const cwds = parseCwds(output("lsof", [
		"-a",
		"-d",
		"cwd",
		"-Fpn",
		"-p",
		parentless.map((process) => String(process.pid)).join(",")
	]));
	return parentless.flatMap(({ pid, command }) => {
		const cwd = cwds.get(pid);
		return cwd !== void 0 && isWithin(cwd, root) ? [{
			pid,
			command,
			cwd
		}] : [];
	});
};
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const signal = (pid, name) => {
	try {
		process.kill(pid, name);
	} catch {}
};
/** Sends each orphan SIGTERM, then SIGKILL to any still running after 3 s. */
const stopOrphans = (orphans) => {
	for (const { pid } of orphans) signal(pid, "SIGTERM");
	const deadline = performance.now() + Duration.toMillis(STOP_GRACE);
	let running = orphans.filter(({ pid }) => alive(pid));
	while (running.length > 0 && performance.now() < deadline) {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Duration.toMillis(STOP_POLL));
		running = running.filter(({ pid }) => alive(pid));
	}
	for (const { pid } of running) signal(pid, "SIGKILL");
};
const describeOrphan = ({ pid, command }) => `pid ${String(pid)} (${path.basename(command)})`;
export { describeOrphan, isWithin, orphansIn, parseCwds, parseProcesses, stopOrphans };
