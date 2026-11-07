import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as FileSystem from "effect/FileSystem";
declare const AgentChromeError_base: Schema.Class<AgentChromeError, Schema.TaggedStruct<"AgentChromeError", {
  readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
export declare class AgentChromeError extends AgentChromeError_base {}
/**
 * The agent Chrome: one Chrome per machine that agents drive, with its own profile, logged in to
 * Shopify once by a person. It is not the person's own Chrome, which listens on 9222 for the
 * chrome-devtools MCP's `--autoConnect` and asks before every new connection. A debugging port on
 * a separate profile never asks, so an agent can drive it with nobody at the laptop. Every project
 * and checkout on the machine shares it, so one Shopify login covers every store.
 */
export declare const AGENT_CDP = "http://127.0.0.1:9333";
/**
 * A running one is left in whatever mode it is in: switching would close other agents' tabs.
 * Returns whether it was started, because a chrome-devtools server attached to the previous Chrome
 * has to be restarted.
 */
export declare const ensureAgentChrome: Effect.Effect<boolean, AgentChromeError, ChildProcessSpawner.ChildProcessSpawner>;
export declare const isStoreAdmin: (store: string, target: {
  readonly url: string;
  readonly title: string;
}) => boolean;
/**
 * Logged in, the admin titles
 * the page `<store name> · <page> · Shopify` at `admin.shopify.com/store/<store>` (the name is the
 * handle for the `mw10013` stores and a display name, "Sandbox Shop 01", for the Partner
 * organization's, so the URL names the store); a lapsed login lands on accounts.shopify.com, titled
 * "Log in — Shopify". Neither the first URL nor an early title tells them apart: Chrome titles a
 * loading tab with its URL, and a lapsed login passes through `admin.shopify.com/login` first.
 * Only a person may sign in, so a lapse fails for them to fix.
 */
export declare const checkShopifyLogin: (store: string) => Effect.Effect<undefined, AgentChromeError, never>;
/**
 * Run by a person, never an agent: the relaunches close every agent's tabs. The wait watches the
 * window's own tab rather than opening check tabs in front of someone typing a password.
 */
export declare const loginAgentChrome: (store: string) => Effect.Effect<undefined, AgentChromeError, ChildProcessSpawner.ChildProcessSpawner>;
/** Where the agent Chrome's exported Shopify login lives; it holds a login, so it stays under `playwright/.auth/`. */
export declare const storageStatePath = "playwright/.auth/shopify-admin.json";
/**
 * Reads the live browser, which renews the session itself, so the copy is as fresh as the agent
 * Chrome.
 */
export declare const exportShopifyAdminAuth: (args_0: {
  readonly output: string;
  readonly store: string;
}) => Effect.Effect<number, AgentChromeError | import("effect/PlatformError").PlatformError, ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem>;
export {};