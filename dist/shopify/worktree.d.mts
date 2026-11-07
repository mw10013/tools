import { PerDeveloper } from "../cloudflare/stage.mjs";
import { CommandError } from "../core/command.mjs";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
declare const WorktreeError_base: Schema.Class<WorktreeError, Schema.TaggedStruct<"WorktreeError", {
  readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
export declare class WorktreeError extends WorktreeError_base {}
/**
 * What a store is for, which its name says: `pool`, a store berth leases to any checkout and
 * environment, or a deployed stage's one store. Not {@link Environment}: `test` has no store, and
 * `production` has a store before it has a stage.
 */
export declare const StorePurpose: Schema.Literals<readonly ["pool", "staging", "production"]>;
export type StorePurpose = typeof StorePurpose.Type;
declare const ShopStorePurpose: Schema.Literals<readonly ["staging", "production"]>;
/**
 * `NN` is the store's index among its purpose's stores; it says nothing about which checkout holds
 * a pool store. Store names share one namespace across all of Shopify and a taken name silently becomes a suffixed domain, so
 * generic names are taken; `mw10013`, the organization's handle, keeps ours unique. berth leases a
 * pool store to one checkout and environment at a time because the CLI rewrites the app's URL per
 * store: two `shopify app dev` sessions on one store overwrite each other's, and the last wins.
 */
export declare const StoreName: Schema.Union<readonly [Schema.decodeTo<Schema.Struct<{
  readonly purpose: Schema.Literal<"pool">;
  readonly index: Schema.Int;
}>, Schema.TemplateLiteralParser<readonly ["mw10013-pool-", Schema.decodeTo<Schema.Int, Schema.String, never, never>]>, never, never>, Schema.decodeTo<Schema.Struct<{
  readonly purpose: Schema.Literals<readonly ["staging", "production"]>;
  readonly index: Schema.Int;
}>, Schema.TemplateLiteralParser<readonly ["mw10013-", Schema.Literals<readonly ["staging", "production"]>, "-shop-", Schema.decodeTo<Schema.Int, Schema.String, never, never>]>, never, never>]>;
export type StoreName = typeof StoreName.Type;
/** The name of stage `purpose`'s store at `index`. No pool store's: no code names one, berth leases them. */
export declare const storeNameOf: (purpose: typeof ShopStorePurpose.Type, index: number) => `mw10013-production-shop-${string}` | `mw10013-staging-shop-${string}`;
export declare const StoreFor: (purposes: readonly StorePurpose[], expected: string) => Schema.Union<readonly [Schema.decodeTo<Schema.Struct<{
  readonly purpose: Schema.Literal<"pool">;
  readonly index: Schema.Int;
}>, Schema.TemplateLiteralParser<readonly ["mw10013-pool-", Schema.decodeTo<Schema.Int, Schema.String, never, never>]>, never, never>, Schema.decodeTo<Schema.Struct<{
  readonly purpose: Schema.Literals<readonly ["staging", "production"]>;
  readonly index: Schema.Int;
}>, Schema.TemplateLiteralParser<readonly ["mw10013-", Schema.Literals<readonly ["staging", "production"]>, "-shop-", Schema.decodeTo<Schema.Int, Schema.String, never, never>]>, never, never>]>;
export declare const checkoutKind: Effect.Effect<{
  root: string;
  linked: boolean;
  mainCheckout: string;
}, CommandError | Schema.SchemaError, import("effect/process/ChildProcessSpawner").ChildProcessSpawner>;
/** Empty on a detached HEAD. */
export declare const currentBranch: Effect.Effect<string, CommandError, import("effect/process/ChildProcessSpawner").ChildProcessSpawner>;
/**
 * The same in every checkout: each checkout keeps its per-developer stages in its own `.alchemy/`.
 */
export declare const stageOf: (environment: "dev" | "e2e" | "test", user: string | undefined) => Effect.Effect<`dev-${string}` | `e2e-${string}` | `test-${string}`, WorktreeError, never>;
export declare const stage: (environment: PerDeveloper) => Effect.Effect<`dev-${string}` | `e2e-${string}` | `test-${string}`, WorktreeError, never>;
export {};