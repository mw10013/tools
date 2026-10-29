import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { Source } from "./sources.ts";

class CheckoutError extends Schema.TaggedError<CheckoutError>()(
  "CheckoutError",
  {
    message: Schema.String,
  },
) {}

export const git = Effect.fn("Checkouts.git")(function* (
  directory: string,
  args: readonly string[],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make("git", ["-C", directory, ...args], {
          stdin: "ignore",
          stderr: "inherit",
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        }),
      );
      const output = yield* Stream.mkString(Stream.decodeText(child.stdout));
      const exit = yield* child.exitCode;
      if (exit !== 0)
        return yield* new CheckoutError({
          message: `git ${args[0]} failed in ${directory} (exit ${String(exit)})`,
        });
      return output.trim();
    }),
  );
});

const inspect = Effect.fn("Checkouts.inspect")(function* (
  directory: string,
  source: Source,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(path.join(directory, ".git"))))
    return yield* new CheckoutError({
      message: `${directory} exists but is not a managed Git checkout`,
    });
  const origin = yield* git(directory, ["remote", "get-url", "origin"]);
  if (origin !== source.repository)
    return yield* new CheckoutError({
      message: `${directory} has an unexpected origin; expected ${source.repository}`,
    });
  const dirty =
    (yield* git(directory, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ])) !== "";
  const head = yield* git(directory, ["rev-parse", "HEAD"]);
  const branch = yield* git(directory, ["branch", "--show-current"]);
  return { dirty, head, branch };
});

export const status = Effect.fn("Checkouts.status")(function* (
  root: string,
  source: Source,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(root, source.name);
  if (!(yield* fs.exists(directory)))
    return `${source.name}: missing; want ${source.target} (${directory})`;
  const state = yield* inspect(directory, source);
  const target =
    source.kind === "branch"
      ? `refs/remotes/origin/${source.target}`
      : `refs/tags/${source.target}`;
  const desired = yield* git(directory, [
    "rev-parse",
    "--verify",
    `${target}^{commit}`,
  ]).pipe(Effect.orElseSucceed(() => ""));
  const matches =
    desired === state.head &&
    (source.kind === "branch"
      ? state.branch === source.target
      : state.branch === "");
  return `${source.name}: ${state.dirty ? "dirty; " : ""}${matches ? "at" : "differs from"} ${source.target}; HEAD ${state.head.slice(0, 12)} (${directory})`;
});

export const sync = Effect.fn("Checkouts.sync")(function* (
  root: string,
  source: Source,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(root, { recursive: true });
  const directory = path.join(root, source.name);
  if (!(yield* fs.exists(directory))) {
    const staging = yield* fs.makeTempDirectory({
      directory: root,
      prefix: `.${source.name}-`,
    });
    yield* Effect.gen(function* () {
      yield* git(root, [
        "clone",
        "--depth",
        "1",
        "--single-branch",
        "--branch",
        source.target,
        "--",
        source.repository,
        staging,
      ]);
      if (source.kind === "tag")
        yield* git(staging, [
          "checkout",
          "--detach",
          `refs/tags/${source.target}`,
        ]);
      yield* fs.rename(staging, directory);
    }).pipe(
      Effect.ensuring(
        fs.remove(staging, { recursive: true, force: true }).pipe(Effect.orDie),
      ),
    );
  } else {
    const state = yield* inspect(directory, source);
    if (state.dirty)
      return yield* new CheckoutError({
        message: `${directory} has local changes; sync refused`,
      });
    if (source.kind === "branch") {
      if (state.branch !== source.target)
        return yield* new CheckoutError({
          message: `${directory} must be on ${source.target}; sync refused`,
        });
      yield* git(directory, [
        "fetch",
        "--no-tags",
        "origin",
        `refs/heads/${source.target}:refs/remotes/origin/${source.target}`,
      ]);
      yield* git(directory, [
        "merge",
        "--ff-only",
        `refs/remotes/origin/${source.target}`,
      ]);
    } else {
      if (state.branch !== "")
        return yield* new CheckoutError({
          message: `${directory} must have a detached HEAD; sync refused`,
        });
      const tags = yield* git(directory, ["tag", "--points-at", "HEAD"]);
      if (tags === "")
        return yield* new CheckoutError({
          message: `${directory} HEAD is not tagged; sync refused to leave possible local commits`,
        });
      yield* git(directory, [
        "fetch",
        "--depth",
        "1",
        "--no-tags",
        "origin",
        `refs/tags/${source.target}:refs/tags/${source.target}`,
      ]);
      yield* git(directory, [
        "checkout",
        "--detach",
        `refs/tags/${source.target}`,
      ]);
    }
  }
  return yield* status(root, source);
});
