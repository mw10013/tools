import * as Schema from "effect/Schema";
import * as Config from "effect/Config";
/** The per-developer environments that run a server: all but `test`, which has none. */
export declare const WebEnvironment: Schema.Literals<readonly ["dev", "e2e"]>;
export type WebEnvironment = typeof WebEnvironment.Type;
/** `SANDBOX_ENVIRONMENT`, `dev` when unset; any other value fails rather than serve the wrong one. */
export declare const webEnvironment: Config.Config<"dev" | "e2e">;
/** {@link webEnvironment}, read synchronously from `process.env`, for configs that cannot run an effect. */
export declare const webEnvironmentSync: () => WebEnvironment;