import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SchemaTransformation from "effect/SchemaTransformation";
// cloudflare/stage.ts
/**
* An environment is a role (`dev`, `test`, `e2e`, `staging`, `production`); a stage is one copy of the stack in
* an environment. Never shortened to `env`, which already means `.env`, `process.env` and a
* Worker's bindings.
*
* Imports only `effect`, so any bundle may carry it.
*
* @module
*/
/** The environments with one stage per developer and checkout; deployed stages are shared. */
const PerDeveloper = Schema.Literals([
	"dev",
	"test",
	"e2e"
]);
const Deployed = Schema.Literals(["staging", "production"]);
/** The branch whose pushes deploy the stage. Production moves only by fast-forward from `main`. */
const branchOf = (stage) => stage === "staging" ? "main" : "production";
/**
* The variable the `stage` CLI sets on the Alchemy runs it starts on a {@link Deployed} stage
* outside Workers Builds, naming why, so the stage's state store lets them through.
*/
const STAGE_RUN = "DEVKIT_STAGE_RUN";
const StageRun = Schema.Literals([
	"check",
	"reset",
	"up"
]);
/** Only disposable deployed data may be destroyed by the reset command. */
const ResettableDeployed = Schema.Literals(["staging"]);
const Environment = Schema.Literals([...PerDeveloper.literals, ...Deployed.literals]);
/** Lowercase letters and digits, so a user never contains the `-` between a stage's parts. */
const User = Schema.String.check(Schema.isPattern(/^[a-z0-9]+$/u));
/**
* A per-developer stage's state and data live in its checkout's `.alchemy/`, so checkouts never
* share one. Dashes, because Alchemy turns every other separator into `-` in physical names, so
* the stage reads the same in the CLI, state, logs and Cloudflare.
*/
const PerDeveloperStage = Schema.TemplateLiteralParser([
	PerDeveloper,
	"-",
	User
]).pipe(Schema.decodeTo(Schema.Struct({
	environment: PerDeveloper,
	user: Schema.String
}), SchemaTransformation.transform({
	decode: (parts) => ({
		environment: parts[0],
		user: parts[2]
	}),
	encode: ({ environment, user }) => [
		environment,
		"-",
		user
	]
})));
const TestFileSuffix = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]*$/u));
/** Each integ file deploys and destroys its own, so files run side by side without sharing state, ports or data. */
const TestFileStage = Schema.TemplateLiteralParser([
	Schema.Literal("test"),
	"-",
	User,
	"-",
	TestFileSuffix
]).pipe(Schema.decodeTo(Schema.Struct({
	user: Schema.String,
	suffix: Schema.String
}), SchemaTransformation.transform({
	decode: (parts) => ({
		user: parts[2],
		suffix: parts[4]
	}),
	encode: ({ user, suffix }) => [
		"test",
		"-",
		user,
		"-",
		suffix
	]
})));
var UnknownStageError = class extends Schema.TaggedError()("UnknownStageError", { stage: Schema.String }) {
	get message() {
		return `stage "${this.stage}" belongs to no known environment`;
	}
};
const decodePerDeveloper = Schema.decodeUnknownOption(PerDeveloperStage);
const decodeTestFileStage = Schema.decodeUnknownOption(TestFileStage);
const isDeployed = Schema.is(Deployed);
/**
* An unknown stage dies rather than falling back: an environment not listed in {@link Environment}
* is one nobody has thought through (its seed, its state store, its policy), a misconfiguration no
* caller can act on.
*/
const environmentOf = (stage) => isDeployed(stage) ? Effect.succeed(stage) : Option.isSome(decodeTestFileStage(stage)) ? Effect.succeed("test") : Option.match(decodePerDeveloper(stage), {
	onNone: () => Effect.die(new UnknownStageError({ stage })),
	onSome: ({ environment }) => Effect.succeed(environment)
});
function workerNameOf(app, stage, worker) {
	return isDeployed(stage) ? `${app}-${worker}-${stage}` : void 0;
}
/**
* Whether this code runs in a deployed bundle rather than while the stack is planned: Alchemy's
* bundler folds `globalThis.__ALCHEMY_RUNTIME__` to `true` in every runtime artifact, so a branch
* on it is dead code in the other phase.
*/
const isAlchemyRuntime = () => globalThis.__ALCHEMY_RUNTIME__ === true;
export { Deployed, Environment, PerDeveloper, PerDeveloperStage, ResettableDeployed, STAGE_RUN, StageRun, TestFileStage, UnknownStageError, branchOf, environmentOf, isAlchemyRuntime, workerNameOf };
