import path from "node:path";

/**
 * A checkout of this repository is either the main checkout, whose `.git` is
 * the repository, or a linked worktree on any branch, which `wt new` creates
 * under `~/.t3/worktrees/<project>/<name>`. Each checkout has its
 * own `.env`, `.alchemy/`, `.bosun/`, `.state/` and `.test-results/`, and its own berth leases
 * ({@link "./berth.ts"}), so each runs its own dev server, on a port it picks, and
 * its own `shopify app dev` session on its own dev store ({@link StoreName}).
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import {
  type PerDeveloper,
  PerDeveloperStage,
} from "#devkit/cloudflare/stage.ts";
import { runCommand } from "#devkit/core/command.ts";

export class WorktreeError extends Schema.TaggedError<WorktreeError>()(
  "WorktreeError",
  {
    message: Schema.String,
  },
) {}

/**
 * What a store is for, which its name says: `pool`, a store berth leases to any checkout and
 * environment, or a deployed stage's one store. Not {@link Environment}: `test` has no store, and
 * `production` has a store before it has a stage.
 */
export const StorePurpose = Schema.Literals(["pool", "staging", "production"]);
export type StorePurpose = typeof StorePurpose.Type;

const StoreIndex = Schema.String.check(Schema.isPattern(/^\d{2}$/u)).pipe(
  Schema.decodeTo(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 99 })),
    SchemaTransformation.transform({
      decode: Number,
      encode: (index) => String(index).padStart(2, "0"),
    }),
  ),
);

const PoolStoreName = Schema.TemplateLiteralParser([
  "mw10013-pool-",
  StoreIndex,
]).pipe(
  Schema.decodeTo(
    Schema.Struct({ purpose: Schema.Literal("pool"), index: Schema.Int }),
    SchemaTransformation.transform({
      decode: (parts) => ({ purpose: "pool" as const, index: parts[1] }),
      encode: ({ index }) => ["mw10013-pool-", index] as const,
    }),
  ),
);

const ShopStorePurpose = Schema.Literals(["staging", "production"]);

const ShopStoreName = Schema.TemplateLiteralParser([
  "mw10013-",
  ShopStorePurpose,
  "-shop-",
  StoreIndex,
]).pipe(
  Schema.decodeTo(
    Schema.Struct({ purpose: ShopStorePurpose, index: Schema.Int }),
    SchemaTransformation.transform({
      decode: (parts) => ({ purpose: parts[1], index: parts[3] }),
      encode: ({ purpose, index }) =>
        ["mw10013-", purpose, "-shop-", index] as const,
    }),
  ),
);

/**
 * `NN` is the store's index among its purpose's stores; it says nothing about which checkout holds
 * a pool store. Store names share one namespace across all of Shopify and a taken name silently becomes a suffixed domain, so
 * generic names are taken; `mw10013`, the organization's handle, keeps ours unique. berth leases a
 * pool store to one checkout and environment at a time because the CLI rewrites the app's URL per
 * store: two `shopify app dev` sessions on one store overwrite each other's, and the last wins.
 */
export const StoreName = Schema.Union([PoolStoreName, ShopStoreName]);
export type StoreName = typeof StoreName.Type;

const encodeShopStoreName = Schema.encodeSync(ShopStoreName);

/** The name of stage `purpose`'s store at `index`. No pool store's: no code names one, berth leases them. */
export const storeNameOf = (
  purpose: typeof ShopStorePurpose.Type,
  index: number,
) => encodeShopStoreName({ purpose, index });

export const StoreFor = (purposes: readonly StorePurpose[], expected: string) =>
  StoreName.pipe(
    Schema.check(
      Schema.makeFilter(
        (store: StoreName) =>
          purposes.includes(store.purpose) || `expected ${expected}`,
      ),
    ),
  );

const Lines = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Array(Schema.String),
    SchemaTransformation.transform({
      decode: (output): readonly string[] => output.trim().split("\n"),
      encode: (lines) => lines.join("\n"),
    }),
  ),
);

const gitDirs = runCommand("git", [
  "rev-parse",
  "--path-format=absolute",
  "--git-dir",
  "--git-common-dir",
]).pipe(
  Effect.flatMap(
    Schema.decodeUnknownEffect(
      Lines.pipe(Schema.decodeTo(Schema.Tuple([Schema.String, Schema.String]))),
    ),
  ),
  Effect.map(([gitDir, commonDir]) => ({ gitDir, commonDir })),
);

export const checkoutKind = Effect.all([
  gitDirs,
  runCommand("git", ["rev-parse", "--show-toplevel"]),
]).pipe(
  Effect.map(([{ gitDir, commonDir }, toplevel]) => ({
    root: toplevel.trim(),
    linked: gitDir !== commonDir,
    mainCheckout: path.dirname(commonDir),
  })),
);

/** Empty on a detached HEAD. */
export const currentBranch = runCommand("git", [
  "branch",
  "--show-current",
]).pipe(Effect.map((output) => output.trim()));

/**
 * The same in every checkout: each checkout keeps its per-developer stages in its own `.alchemy/`.
 */
export const stageOf = Effect.fn("Worktree.stageOf")(function* (
  environment: PerDeveloper,
  user: string | undefined,
) {
  return yield* Schema.encodeUnknownEffect(PerDeveloperStage)({
    environment,
    user,
  }).pipe(
    Effect.mapError(
      () =>
        new WorktreeError({
          message: `$USER must be lowercase letters and digits to name a stage, got ${JSON.stringify(user)}`,
        }),
    ),
  );
});

export const stage = (environment: PerDeveloper) =>
  stageOf(environment, process.env.USER);
