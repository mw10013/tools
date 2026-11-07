import * as Schema from "effect/Schema";
import * as Config from "effect/Config";
// shopify/web.ts
/**
* Which environment a server in this checkout serves. The dev and e2e servers both run Shopify
* CLI's one web command (`shopify.web.toml`), so `SANDBOX_ENVIRONMENT` in the session's
* environment tells them apart: unset is `dev`, and each server's bosun command sets it ({@link "./server.ts"}).
*
* @module
*/
/** The per-developer environments that run a server: all but `test`, which has none. */
const WebEnvironment = Schema.Literals(["dev", "e2e"]);
/** `SANDBOX_ENVIRONMENT`, `dev` when unset; any other value fails rather than serve the wrong one. */
const webEnvironment = Config.schema(WebEnvironment, "SANDBOX_ENVIRONMENT").pipe(Config.withDefault("dev"));
/** {@link webEnvironment}, read synchronously from `process.env`, for configs that cannot run an effect. */
const webEnvironmentSync = () => Schema.decodeUnknownSync(WebEnvironment)(process.env.SANDBOX_ENVIRONMENT ?? "dev");
export { WebEnvironment, webEnvironment, webEnvironmentSync };
