/**
 * What a linked worktree takes from the main checkout, the files git does not
 * carry: every untracked `.env`, `.env.<suffix>` and `refs` directory, at any
 * depth, is symlinked to the same relative path, so each app's values and the
 * reference sources exist once and an edit in any checkout is seen by all.
 *
 * @module
 */
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

/** A path, relative to the checkout, that a worktree links to the main checkout's. */
export interface Share {
  readonly path: string;
}

const ENV_FILE = /(?:^|\/)\.env(?:\.[^/]+)?$/u;
const REFS_DIRECTORY = /(?:^|\/)refs\/$/u;

/**
 * The untracked paths of `main` to share, symlinks left out. `--directory`
 * reports a directory with nothing tracked inside as one entry ending in `/`,
 * so git never descends into `node_modules`, and no worktree could hold a path
 * beneath an untracked directory anyway.
 */
export const discover = Effect.fn("Share.discover")(function* (main: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const candidates = (yield* run(main, "git", [
    "ls-files",
    "-z",
    "--others",
    "--directory",
  ]))
    .split("\0")
    .filter(
      (entry) =>
        (ENV_FILE.test(entry) || REFS_DIRECTORY.test(entry)) &&
        !entry.split("/").includes("node_modules"),
    )
    .map((entry) => entry.replace(/\/$/u, ""))
    .toSorted();
  const paths = yield* Effect.filter(candidates, (entry) =>
    fs
      .readLink(path.join(main, entry))
      .pipe(Effect.match({ onFailure: () => true, onSuccess: () => false })),
  );
  return paths.map((entry): Share => ({ path: entry }));
});

const isCopyOf = Effect.fn("Share.isCopyOf")(function* (
  at: string,
  target: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const [copy, original] = yield* Effect.all([fs.stat(at), fs.stat(target)]);
  return (
    copy.type === "File" &&
    original.type === "File" &&
    (yield* fs.readFileString(at)) === (yield* fs.readFileString(target))
  );
});

/**
 * Links each share whose parent folder the worktree has. A path that already
 * links to the main checkout's is left alone. A file with the main checkout's
 * content, the copy of `.env` an older `wt` made, becomes the link; anything
 * else in the way fails, so no differing file is lost.
 */
export const link = Effect.fn("Share.link")(function* (
  worktree: string,
  main: string,
  shares: readonly Share[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const share of shares) {
    if (!(yield* fs.exists(path.join(worktree, path.dirname(share.path)))))
      continue;
    const at = path.join(worktree, share.path);
    const target = path.join(main, share.path);
    const existing = yield* fs.readLink(at).pipe(Effect.option);
    if (Option.contains(existing, target)) continue;
    if (Option.isSome(existing))
      return yield* new SharedPathError({ path: at, expected: target });
    if (yield* fs.exists(at)) {
      if (!(yield* isCopyOf(at, target)))
        return yield* new SharedPathError({ path: at, expected: target });
      yield* fs.remove(at);
      yield* fs.symlink(target, at);
      yield* Console.error(
        `wt: replaced the copied ${share.path} with a link to the main checkout's, its content the same`,
      );
      continue;
    }
    yield* fs.symlink(target, at);
    yield* Console.error(`wt: linked ${share.path} to the main checkout's`);
  }
});

export const share = Effect.fn("Share.share")(function* (
  worktree: string,
  main: string,
) {
  yield* link(worktree, main, yield* discover(main));
});
