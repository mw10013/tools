import { App } from "../core/app.mjs";
import { WebEnvironment } from "./web.mjs";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Result from "effect/Result";
declare const LeaseNotGrantedError_base: Schema.Class<LeaseNotGrantedError, Schema.TaggedStruct<"LeaseNotGrantedError", {
  readonly environment: Schema.String;
  readonly reason: Schema.String;
  readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
export declare class LeaseNotGrantedError extends LeaseNotGrantedError_base {}
export interface Lease {
  /** The store's handle, such as `mw10013-pool-00`, which `--store` and admin URLs take. */
  readonly store: string;
  /** The app config file the server's `shopify app dev` runs with. */
  readonly config: string;
}
export declare const leaseOf: (environment: WebEnvironment, stdout: string) => Result.Result<Lease, LeaseNotGrantedError>;
export declare const acquire: (environment: "dev" | "e2e") => Effect.Effect<Lease, LeaseNotGrantedError, ChildProcessSpawner.ChildProcessSpawner>;
/**
 * {@link acquire} for configs that cannot run an effect (Playwright's); throws its failure's
 * message. A config passes `app(import.meta.dirname)`, so the lease is the config's app's even
 * when another directory loads the config.
 */
export declare const acquireSync: (environment: WebEnvironment, { root }?: App) => Lease;
export {};