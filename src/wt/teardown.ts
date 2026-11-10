/**
 * What `wt rm` stops before it removes a worktree, found on disk rather than
 * asked of the repo: a `rigging server` leaves
 * `.rigging/servers/<name>/record.json` in its app's folder, at any depth, so
 * a single-app repo and a monorepo's apps tear down alike.
 *
 * @module
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { stream } from "./process.ts";

export interface Teardown {
  readonly kind: "rigging-stop";
  readonly dir: string;
  readonly name: string;
}

/** `rigging server`'s state folder in an app, per rigging's `docs/server.md`. */
const RIGGING_DIRECTORY = ".rigging";
const RIGGING_SERVERS = "servers";

/** Never descended: installed packages and git's own data hold no checkout's servers. */
const SKIPPED = new Set(["node_modules", ".git"]);

const byName = (entries: readonly FileSystem.DirectoryEntry[]) =>
  entries.toSorted((a, b) => a.name.localeCompare(b.name));

/**
 * Symlinks are not followed, so the shared `refs` link never reaches into the
 * main checkout.
 */
export const discover = Effect.fn("Teardown.discover")(function* (
  worktree: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entriesOf = (dir: string) =>
    fs.readDirectoryEntries(dir).pipe(
      Effect.map(byName),
      Effect.orElseSucceed(() => []),
    );
  const stops: Teardown[] = [];
  const visit = (dir: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (const entry of yield* entriesOf(dir)) {
        const full = path.join(dir, entry.name);
        if (entry.type !== "Directory" || SKIPPED.has(entry.name)) continue;
        if (entry.name !== RIGGING_DIRECTORY) {
          yield* visit(full);
          continue;
        }
        const servers = path.join(full, RIGGING_SERVERS);
        for (const server of yield* entriesOf(servers)) {
          const record = path.join(servers, server.name, "record.json");
          if (yield* fs.exists(record).pipe(Effect.orElseSucceed(() => false)))
            stops.push({ kind: "rigging-stop", dir, name: server.name });
        }
      }
    });
  yield* visit(worktree);
  return stops;
});

const RiggingRecord = Schema.fromJsonString(
  Schema.Struct({ pid: Schema.Int, group: Schema.Int }),
);

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
    // Already gone.
  }
};

/**
 * Stops a server from its record alone, for an app whose `node_modules` no
 * longer holds `rigging`: SIGTERM to the command's group and the runner, then
 * SIGKILL after 30 seconds, as `rigging server stop` does.
 */
const stopFromRecord = Effect.fn("Teardown.stopFromRecord")(function* (
  serverDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const record = yield* Schema.decodeEffect(RiggingRecord)(
    yield* fs.readFileString(path.join(serverDir, "record.json")),
  );
  const running = () => alive(-record.group) || alive(record.pid);
  signal(-record.group, "SIGTERM");
  signal(record.pid, "SIGTERM");
  for (let waited = 0; running() && waited < 30; waited += 1)
    yield* Effect.sleep(Duration.seconds(1));
  if (running()) {
    signal(-record.group, "SIGKILL");
    signal(record.pid, "SIGKILL");
  }
  yield* fs.remove(serverDir, { recursive: true, force: true });
});

/** Stops at the first failure, so `wt rm` removes nothing that still runs. */
export const run = Effect.fn("Teardown.run")(function* (
  actions: readonly Teardown[],
  worktree: string,
) {
  const path = yield* Path.Path;
  const steps: string[] = [];
  for (const action of actions) {
    const where = path.relative(worktree, action.dir) || ".";
    const fs = yield* FileSystem.FileSystem;
    const bin = path.join(action.dir, "node_modules", ".bin", "rigging");
    if (yield* fs.exists(bin).pipe(Effect.orElseSucceed(() => false))) {
      yield* stream(action.dir, bin, ["server", "stop", action.name]);
      steps.push(`rigging server stop ${action.name} in ${where}`);
    } else {
      yield* stopFromRecord(
        path.join(action.dir, RIGGING_DIRECTORY, RIGGING_SERVERS, action.name),
      );
      steps.push(`stopped ${action.name} from its record in ${where}`);
    }
  }
  return steps;
});
