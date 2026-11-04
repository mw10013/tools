import path from "node:path";

/**
 * Which store a checkout's dev or e2e stage was set up for. A stage keeps the shops of every store
 * its server ran on, so once a lease moves to another store the fixture's members belong to two
 * shops, and a member's sign-in lands on the "Your stores" chooser instead of the leased shop. Each
 * server's start compares the lease's store with the record (`.state/<environment>.store`) and
 * destroys a stage set up for any other ({@link resetStaleStage}). `vp run e2e:start` records the
 * store as it starts, since every e2e run loads its own fixture; `vp run dev` records it once the
 * store is set up and the dev fixture applied, so a start that finds no record prepares the store.
 *
 * @module
 */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { APP_NAME, ROOT } from "#devkit/core/app.ts";

import { type Server, ServerError, step, stopServer } from "./server.ts";
import type { WebEnvironment } from "./web.ts";

export const stageStoreFile = (environment: WebEnvironment) =>
  `.state/${environment}.store`;

export const stageStateDirectory = (stage: string) =>
  `.alchemy/state/${APP_NAME}/${stage}`;

export const staleStageReason = (
  stage: { readonly exists: boolean; readonly store: Option.Option<string> },
  store: string,
): Option.Option<string> => {
  if (!stage.exists) return Option.none();
  return Option.match(stage.store, {
    onNone: () => Option.some("it records no store"),
    onSome: (recorded) =>
      recorded === store
        ? Option.none()
        : Option.some(`it was set up for ${recorded}`),
  });
};

export const recordedStore = (server: Server) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs
      .readFileString(path.join(ROOT, stageStoreFile(server.environment)))
      .pipe(
        Effect.map((text) => text.trim()),
        Effect.option,
      );
  });

export const recordStore = (server: Server) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = path.join(ROOT, stageStoreFile(server.environment));
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, `${server.store}\n`);
  });

/** `alchemy destroy` of the server's stage: local state and data only, nothing in the cloud. */
export const destroyStage = (server: Server) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const exitCode = yield* spawner.exitCode(
      ChildProcess.make(
        "alchemy",
        ["destroy", "--stage", server.stage, "--yes"],
        {
          cwd: ROOT,
          stdin: "ignore",
          stdout: "inherit",
          stderr: "inherit",
        },
      ),
    );
    if (exitCode !== ChildProcessSpawner.ExitCode(0))
      return yield* new ServerError({
        message: `alchemy destroy exited ${String(exitCode)}`,
      });
  });

export const resetStaleStage = (server: Server) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(
      path.join(ROOT, stageStateDirectory(server.stage)),
    );
    const reason = staleStageReason(
      { exists, store: yield* recordedStore(server) },
      server.store,
    );
    if (Option.isNone(reason)) return;
    yield* Console.log(
      `reset stage ${server.stage}: ${reason.value}, and the ${server.environment} lease is ${server.store}`,
    );
    yield* step("stop", stopServer(server.environment));
    yield* step(`destroy stage ${server.stage}`, destroyStage(server));
    yield* fs.remove(path.join(ROOT, stageStoreFile(server.environment)), {
      force: true,
    });
  });
