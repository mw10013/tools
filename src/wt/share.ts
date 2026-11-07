/**
 * What a linked worktree takes from the main checkout, the files git does not
 * carry: `.env` is copied, and `refs` and every untracked `.env.<suffix>` are
 * symlinked, so a deployed stage's values and the reference sources exist
 * once.
 *
 * A hand edit to a worktree's `.env` is lost on the next run: make it in the
 * main checkout's and run `wt init`.
 *
 * @module
 */
import { parseEnv } from "node:util";

import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { run } from "./process.ts";

export class SharedPathError extends Schema.TaggedError<SharedPathError>()(
  "SharedPathError",
  { path: Schema.String, expected: Schema.String },
) {
  override get message() {
    return `${this.path} is not a link to ${this.expected}; remove it and run wt init`;
  }
}

export const envChanges = (before: string, after: string) => {
  const was = parseEnv(before);
  const now = parseEnv(after);
  return {
    added: Object.keys(now).filter((key) => !Object.hasOwn(was, key)),
    changed: Object.keys(now).filter(
      (key) => Object.hasOwn(was, key) && was[key] !== now[key],
    ),
    removed: Object.keys(was).filter((key) => !Object.hasOwn(now, key)),
  };
};

const describeChanges = (before: string, after: string) => {
  const { added, changed, removed } = envChanges(before, after);
  const part = (label: string, keys: readonly string[]) =>
    keys.length === 0 ? [] : [`${label} ${keys.join(", ")}`];
  const parts = [
    ...part("added", added),
    ...part("changed", changed),
    ...part("removed", removed),
  ];
  return parts.length === 0 ? "layout only" : parts.join("; ");
};

const readOption = Effect.fn("Share.readOption")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return (yield* fs.exists(file))
    ? Option.some(yield* fs.readFileString(file))
    : Option.none<string>();
});

const copyEnv = Effect.fn("Share.copyEnv")(function* (
  worktree: string,
  main: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const want = yield* readOption(path.join(main, ".env"));
  if (Option.isNone(want)) return;
  const file = path.join(worktree, ".env");
  const have = yield* readOption(file);
  if (Option.contains(have, want.value)) return;
  yield* fs.writeFileString(file, want.value);
  yield* Console.error(
    Option.isNone(have)
      ? "wt: copied .env from the main checkout"
      : `wt: rebuilt .env from the main checkout: ${describeChanges(have.value, want.value)}`,
  );
});

const link = Effect.fn("Share.link")(function* (
  worktree: string,
  main: string,
  name: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const at = path.join(worktree, name);
  const target = path.join(main, name);
  const existing = yield* fs.readLink(at).pipe(Effect.option);
  if (Option.contains(existing, target)) return;
  if (
    Option.isSome(existing) ||
    (yield* fs.exists(at).pipe(Effect.orElseSucceed(() => false)))
  )
    return yield* new SharedPathError({ path: at, expected: target });
  yield* fs.symlink(target, at);
  yield* Console.error(`wt: linked ${name} to the main checkout's`);
});

const sharedNames = Effect.fn("Share.sharedNames")(function* (main: string) {
  const fs = yield* FileSystem.FileSystem;
  const tracked = new Set(
    (yield* run(main, "git", ["ls-files", "--", ".env.*"]))
      .split("\n")
      .filter((line) => line.length > 0),
  );
  const entries = yield* fs.readDirectory(main);
  return [
    ...(entries.includes("refs") ? ["refs"] : []),
    ...entries
      .filter((name) => /^\.env\..+/u.test(name) && !tracked.has(name))
      .toSorted(),
  ];
});

export const share = Effect.fn("Share.share")(function* (
  worktree: string,
  main: string,
) {
  yield* copyEnv(worktree, main);
  yield* Effect.forEach(yield* sharedNames(main), (name) =>
    link(worktree, main, name),
  );
});
