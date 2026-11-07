import { Deployed, ResettableDeployed, STAGE_RUN, StageRun, branchOf, environmentOf } from "./stage.mjs";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import * as SchemaAST from "effect/SchemaAST";
// cloudflare/deployed-stack.ts
/**
* What an app's Alchemy stacks share on a {@link Deployed} stage: the providers, the state store,
* the `secrets` policy, and the check that the stage's environment holds every field the app
* declares ({@link requireStageEnv}).
*
* A deployed stage's values are its Workers Builds trigger's variables, which `vp run stage up`
* syncs from `.env.<stage>` and Builds puts in the deploy's environment.
*
* {@link stageState} admits a run on a deployed stage only from Workers Builds on the stage's
* branch or from the `stage` CLI, and only the Alchemy command that run is for
* ({@link deployedRunRefusal}). Alchemy builds the state store on every command that addresses a
* stage, `destroy` included, which never runs the stack's program; so a hand-run
* `alchemy deploy`, `plan` or `destroy --stage production` dies before it reads state.
*
* Stack-time only: imports Alchemy, so no Worker bundle may carry it. {@link Deployed} and the
* other names a bundle needs stay in `stage.ts`.
*
* @see `~/.claude/skills/coder/references/deployed-stages.md` for the lifecycle these enforce.
* @module
*/
const isDeployed = Schema.is(Deployed);
/**
* The stack's state store, chosen by the stage's environment. State lives where the resources
* live: `dev`, `test` and `e2e` run in workerd and its simulators, so their state is local under
* `.alchemy/`; `staging` and `production` run in Cloudflare, so their state does too, behind
* {@link guardDeployedRun}.
*
* `Test.make`'s own `state` option is built outside the stage, so integ files pass none and use
* this layer from the stack.
*/
const stageState = Layer.unwrap(Effect.gen(function* () {
	yield* guardDeployedRun;
	const environment = yield* environmentOf(yield* Alchemy.Stage);
	return Match.value(environment).pipe(Match.whenOr("dev", "test", "e2e", () => Alchemy.localState()), Match.whenOr("staging", "production", () => Cloudflare.state()), Match.exhaustive);
}));
var UnsafeNukeRefusedError = class extends Schema.TaggedError()("UnsafeNukeRefusedError", {}) {
	get message() {
		return "alchemy unsafe nuke deletes every Alchemy resource the account holds, every app's staging and production included, so an app stack refuses it. Reset local data with vp run db:reset and staging with vp run stage reset staging";
	}
};
/** Dies when this process is `alchemy unsafe nuke`. */
const refuseUnsafeNuke = Effect.suspend(() => alchemyCommandOf(process.argv) === "unsafe" ? Effect.die(new UnsafeNukeRefusedError()) : Effect.void);
/**
* The `providers` option of every app stack: Cloudflare's, behind
* {@link refuseUnsafeNuke}. Nuke builds a stack's providers and nothing else, no stage and no
* state store (Alchemy's `src/Alchemist/Nuke.ts`), so {@link guardDeployedRun} never runs, and it
* deletes across the whole account, not one stage.
*/
const stageProviders = Layer.unwrap(Effect.as(refuseUnsafeNuke, Cloudflare.providers()));
/**
* The `secrets` option of every app stack. A per-developer stage reads `.env`, then the shell. A
* {@link Deployed} stage reads no file: Workers Builds puts its trigger's variables in the shell. Its list
* is empty rather than `ProcessEnv({ disabled: true })` because Alchemy appends the shell to any
* list that does not name it, and the providers are built under the same configuration, so the
* shell is where Workers Builds hands the deploy its Cloudflare credentials.
*
* Declaring `secrets` also makes `--env-file` a hard error, so no flag can bring a file back.
*/
const deployedSecrets = ({ stage }) => isDeployed(stage) ? [] : [Alchemy.Secrets.DotEnv()];
/** Alchemy's CLI commands, as its `src/Cli/main.ts` lists them. */
const AlchemyCommand = Schema.Literals([
	"provider",
	"deploy",
	"dev",
	"destroy",
	"plan",
	"logs",
	"profile",
	"state",
	"drift",
	"unsafe"
]);
/**
* The command Alchemy's CLI runs for `argv`, `undefined` outside its CLI. Alchemy picks it the
* same way, as the first argument naming a command, so the two cannot disagree.
*
* @see `requestedCommand` in Alchemy's `src/Cli/main.ts`
*/
const alchemyCommandOf = (argv) => argv.slice(2).find(Schema.is(AlchemyCommand));
/**
* What each run may do. Builds only deploys; each `stage` subcommand runs the one command it is
* for, `up` the stage's first deploy from a checkout at the stage's branch. Only `reset` destroys,
* and only a {@link ResettableDeployed} stage, so nothing destroys production.
*/
const permits = {
	builds: {
		commands: ["deploy"],
		stages: Deployed.literals
	},
	check: {
		commands: ["plan"],
		stages: Deployed.literals
	},
	reset: {
		commands: ["destroy"],
		stages: ResettableDeployed.literals
	},
	up: {
		commands: ["deploy"],
		stages: Deployed.literals
	}
};
const isStageRun = Schema.is(StageRun);
const ONLY_RESET_DESTROYS = "only vp run stage reset staging destroys a deployed stage, and nothing destroys production";
/**
* Why Alchemy must not run `command` on `stage` here, or `None`. Workers Builds deploys the stage
* from its branch; the `stage` CLI names its reason in {@link STAGE_RUN}; each may run only what
* {@link permits} gives it. Anywhere else a deploy would ship whatever the checkout holds, not
* what the branch holds (`up` deploys only from a clean checkout at the branch), and a destroy
* would delete the stage's data.
*/
const deployedRunRefusal = (stage, command, env) => {
	const branch = branchOf(stage);
	const reason = env[STAGE_RUN];
	if (reason !== void 0 && !isStageRun(reason)) return Option.some(`${STAGE_RUN} is "${reason}", not one of ${StageRun.literals.join(", ")}. Only vp run stage sets it; unset it`);
	if (reason === void 0 && env.WORKERS_CI === "1" && env.WORKERS_CI_BRANCH !== branch) return Option.some(`${stage} deploys from branch ${branch}, not ${env.WORKERS_CI_BRANCH ?? "(none)"}. Point the trigger at ${branch} with vp run stage up ${stage}`);
	const run = reason ?? (env.WORKERS_CI === "1" ? "builds" : void 0);
	if (run === void 0) return Option.some(command === "destroy" ? `${stage} is not destroyed by hand: ${ONLY_RESET_DESTROYS}` : `${stage} runs only in Workers Builds: push to ${branch} to deploy it. Plan it with vp run stage check ${stage}`);
	const permit = permits[run];
	if (command !== void 0 && permit.commands.includes(command) && permit.stages.includes(stage)) return Option.none();
	const who = run === "builds" ? "Workers Builds" : `vp run stage ${run}`;
	return Option.some(`${who} runs alchemy ${permit.commands.join(" or ")} on ${permit.stages.join(" or ")}, not alchemy ${command ?? "(no command)"} on ${stage}${command === "destroy" ? `: ${ONLY_RESET_DESTROYS}` : ""}`);
};
var DeployedRunRefusedError = class extends Schema.TaggedError()("DeployedRunRefusedError", { reason: Schema.String }) {
	get message() {
		return this.reason;
	}
};
/**
* Dies on a {@link Deployed} stage unless {@link deployedRunRefusal} allows this process's Alchemy
* command. {@link stageState} runs it as it builds; a stack with another store runs it the same way.
*/
const guardDeployedRun = Effect.flatMap(Alchemy.Stage, (stage) => {
	if (!isDeployed(stage)) return Effect.void;
	const refusal = deployedRunRefusal(stage, alchemyCommandOf(process.argv), process.env);
	return Option.isSome(refusal) ? Effect.die(new DeployedRunRefusedError({ reason: refusal.value })) : Effect.void;
});
/**
* Parses each of `fields` from `env` as `Config` reads it in a Worker. A parse failure's own
* message can quote the value, a secret included, so an invalid field carries only its name.
*/
const checkStageEnv = (fields, env) => {
	const provider = ConfigProvider.fromEnv({ env: Object.fromEntries(Object.entries(env).filter((entry) => entry[1] !== void 0)) });
	return Effect.forEach(Object.entries(fields.fields), ([name, field]) => Effect.gen(function* () {
		const raw = yield* Effect.option(Config.schema(Schema.String, name).parse(provider));
		if (Option.isNone(raw)) return {
			_tag: SchemaAST.isOptional(field.ast) ? "Absent" : "Invalid",
			name
		};
		const parsed = yield* Effect.option(Config.schema(field, name).parse(provider));
		return Option.match(parsed, {
			onNone: () => ({
				_tag: "Invalid",
				name
			}),
			onSome: (value) => ({
				_tag: "Set",
				name,
				value: Redacted.make(raw.value),
				secret: Redacted.isRedacted(value)
			})
		});
	}));
};
var StageEnvMissingError = class extends Schema.TaggedError()("StageEnvMissingError", {
	stage: Deployed,
	names: Schema.Array(Schema.String)
}) {
	get message() {
		return `${this.stage}'s environment lacks or has invalid ${this.names.join(", ")}. Add them to .env.${this.stage} and run vp run stage up ${this.stage}`;
	}
};
/**
* The app stack's first step. On a {@link Deployed} stage it dies unless the environment holds
* every required one of `fields` and each optional one it holds is valid, so a Builds deploy
* missing a trigger variable fails instead of binding nothing where a Worker reads `Config.option`.
*
* @example
* export default Alchemy.Stack("app", { providers: stageProviders, state: stageState, secrets: deployedSecrets },
*   Effect.gen(function* () {
*     yield* requireStageEnv(StageEnv);
*     // ...
*   }),
* );
*/
const requireStageEnv = (fields) => Effect.gen(function* () {
	const stage = yield* Alchemy.Stage;
	if (!isDeployed(stage)) return;
	const invalid = (yield* checkStageEnv(fields, process.env)).filter((field) => field._tag === "Invalid").map(({ name }) => name);
	if (invalid.length > 0) return yield* Effect.die(new StageEnvMissingError({
		stage,
		names: invalid
	}));
});
export { DeployedRunRefusedError, StageEnvMissingError, UnsafeNukeRefusedError, alchemyCommandOf, checkStageEnv, deployedRunRefusal, deployedSecrets, guardDeployedRun, refuseUnsafeNuke, requireStageEnv, stageProviders, stageState };
