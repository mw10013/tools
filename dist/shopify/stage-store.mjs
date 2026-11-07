import { app } from "../core/app.mjs";
import { ServerError, step, stopServer } from "./server.mjs";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Option from "effect/Option";
import * as Console from "effect/Console";
import * as FileSystem from "effect/FileSystem";
// shopify/stage-store.ts
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
const stageStoreFile = (environment) => `.state/${environment}.store`;
const stageStateDirectory = (stage) => `.alchemy/state/${app().name}/${stage}`;
const staleStageReason = (stage, store) => {
	if (!stage.exists) return Option.none();
	return Option.match(stage.store, {
		onNone: () => Option.some("it records no store"),
		onSome: (recorded) => recorded === store ? Option.none() : Option.some(`it was set up for ${recorded}`)
	});
};
const recordedStore = (server) => Effect.gen(function* () {
	return yield* (yield* FileSystem.FileSystem).readFileString(path.join(app().root, stageStoreFile(server.environment))).pipe(Effect.map((text) => text.trim()), Effect.option);
});
const recordStore = (server) => Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const file = path.join(app().root, stageStoreFile(server.environment));
	yield* fs.makeDirectory(path.dirname(file), { recursive: true });
	yield* fs.writeFileString(file, `${server.store}\n`);
});
/** `alchemy destroy` of the server's stage: local state and data only, nothing in the cloud. */
const destroyStage = (server) => Effect.gen(function* () {
	const exitCode = yield* (yield* ChildProcessSpawner.ChildProcessSpawner).exitCode(ChildProcess.make("alchemy", [
		"destroy",
		"--stage",
		server.stage,
		"--yes"
	], {
		cwd: app().root,
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit"
	}));
	if (exitCode !== ChildProcessSpawner.ExitCode(0)) return yield* new ServerError({ message: `alchemy destroy exited ${String(exitCode)}` });
});
const resetStaleStage = (server) => Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const exists = yield* fs.exists(path.join(app().root, stageStateDirectory(server.stage)));
	const reason = staleStageReason({
		exists,
		store: yield* recordedStore(server)
	}, server.store);
	if (Option.isNone(reason)) return;
	yield* Console.log(`reset stage ${server.stage}: ${reason.value}, and the ${server.environment} lease is ${server.store}`);
	yield* step("stop", stopServer(server.environment));
	yield* step(`destroy stage ${server.stage}`, destroyStage(server));
	yield* fs.remove(path.join(app().root, stageStoreFile(server.environment)), { force: true });
});
export { destroyStage, recordStore, recordedStore, resetStaleStage, stageStateDirectory, stageStoreFile, staleStageReason };
