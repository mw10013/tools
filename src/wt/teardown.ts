/**
 * What `wt rm` stops and releases before it removes a worktree, found on disk
 * rather than asked of the repo: a bosun server leaves `.bosun/<name>/record.json`
 * in its app's folder, and a berth checkout has a `berth.json`, at any depth, so a
 * single-app repo and a monorepo's apps tear down alike.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { BOSUN_DIRECTORY } from "#bosun/domain.ts";

import { stream } from "./process.ts";

export type Teardown =
  | { readonly kind: "bosun-stop"; readonly dir: string; readonly name: string }
  | { readonly kind: "berth-release"; readonly dir: string };

/** Never descended: installed packages and git's own data hold no checkout's servers. */
const SKIPPED = new Set(["node_modules", ".git"]);

const byName = (entries: readonly FileSystem.DirectoryEntry[]) =>
  entries.toSorted((a, b) => a.name.localeCompare(b.name));

/**
 * Every bosun stop comes before every berth release: berth refuses to release a
 * lease while the checkout's `shopify app dev`, which a bosun server runs, is
 * still on its store. Symlinks are not followed, so the shared `refs` link
 * never reaches into the main checkout.
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
  const releases: Teardown[] = [];
  const visit = (dir: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (const entry of yield* entriesOf(dir)) {
        const full = path.join(dir, entry.name);
        if (entry.type === "File" && entry.name === "berth.json")
          releases.push({ kind: "berth-release", dir });
        if (entry.type !== "Directory" || SKIPPED.has(entry.name)) continue;
        if (entry.name !== BOSUN_DIRECTORY) {
          yield* visit(full);
          continue;
        }
        for (const server of yield* entriesOf(full)) {
          const record = path.join(full, server.name, "record.json");
          if (yield* fs.exists(record).pipe(Effect.orElseSucceed(() => false)))
            stops.push({ kind: "bosun-stop", dir, name: server.name });
        }
      }
    });
  yield* visit(worktree);
  return [...stops, ...releases] as readonly Teardown[];
});

/** Stops at the first failure, so `wt rm` removes nothing that still runs or holds a lease. */
export const run = Effect.fn("Teardown.run")(function* (
  actions: readonly Teardown[],
  worktree: string,
) {
  const path = yield* Path.Path;
  const steps: string[] = [];
  for (const action of actions) {
    const where = path.relative(worktree, action.dir) || ".";
    if (action.kind === "bosun-stop") {
      yield* stream(action.dir, "bosun", ["stop", action.name]);
      steps.push(`bosun stop ${action.name} in ${where}`);
    } else {
      yield* stream(action.dir, "berth", ["release"]);
      steps.push(`berth release in ${where}`);
    }
  }
  return steps;
});
