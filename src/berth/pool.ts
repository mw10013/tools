/**
 * The store pool: `stores.json` and the pure decisions `berth pool ensure`
 * makes over it. The shell lists the organization's stores, hands them in,
 * and carries out the {@link PoolPlan}.
 *
 * A store's identity is its domain: Shopify never changes a store's
 * `myshopify.com` domain, and a store's name can differ from it.
 *
 * @see https://shopify.dev/docs/apps/build/stores/development-stores
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { handleOf, StoreDomain } from "./domain.ts";

/** Shopify's numeric organization id, as `--organization-id` takes it. */
export const OrganizationId = Schema.String.check(
  Schema.isPattern(/^[0-9]+$/u),
).pipe(Schema.brand("OrganizationId"));
export type OrganizationId = typeof OrganizationId.Type;

/** A pool store's name is the prefix and two digits; the apps' devkit `StoreName` allows no more. */
export const PoolPrefix = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*-$/u),
).pipe(Schema.brand("PoolPrefix"));
export type PoolPrefix = typeof PoolPrefix.Type;

const POOL_NAMES = 100;

// Not `Schema.isUnique`: its message does not name the store listed twice.
const listedOnce = Schema.makeFilter<ReadonlyArray<StoreDomain>>(
  (stores) => {
    const twice = stores.filter(
      (store, index) => stores.indexOf(store) !== index,
    );
    return (
      twice.length === 0 ||
      `lists ${[...new Set(twice)].map(handleOf).join(", ")} more than once`
    );
  },
  { expected: "each store listed once" },
);

/**
 * `stores.json`, which only `berth pool ensure` writes. Every listed store was
 * checked to exist as a dev store on basic, and none twice. The file holds
 * handles.
 */
export const Pool = Schema.Struct({
  organization: OrganizationId,
  prefix: PoolPrefix,
  stores: Schema.Array(
    Schema.String.pipe(
      Schema.decodeTo(
        StoreDomain,
        SchemaTransformation.transform({
          decode: (handle) => `${handle}.myshopify.com`,
          encode: (domain) => domain.slice(0, -".myshopify.com".length),
        }),
      ),
    ),
  ).check(listedOnce),
});
export type Pool = typeof Pool.Type;

/** One entry of `shopify store list`, which lists every type of store. */
export interface OrgStore {
  readonly domain: string;
  readonly name: string | undefined;
  readonly type: string;
  readonly plan: string | undefined;
}

export const domainOf = (name: string): StoreDomain =>
  StoreDomain.make(`${name}.myshopify.com`);

export const poolNames = (prefix: PoolPrefix): ReadonlyArray<string> =>
  Array.from(
    { length: POOL_NAMES },
    (_, index) => `${prefix}${String(index).padStart(2, "0")}`,
  );

export const UnfitStore = Schema.Struct({
  store: Schema.String,
  reason: Schema.Literals(["missing", "type", "plan"]),
  found: Schema.optionalKey(Schema.String),
});
export type UnfitStore = typeof UnfitStore.Type;

const describeUnfit = ({ store, reason, found }: UnfitStore) =>
  reason === "missing"
    ? `${store} is not in the organization`
    : `${store} has ${reason} ${found ?? "(none)"}`;

/** berth never repairs or deletes a store, so a person decides what to do. */
export class PoolStoresUnfitError extends Schema.TaggedError<PoolStoresUnfitError>()(
  "PoolStoresUnfitError",
  { stores: Schema.Array(UnfitStore) },
) {
  override get message() {
    return `stores.json lists stores that are not dev stores on basic: ${this.stores.map(describeUnfit).join("; ")}`;
  }
}

export class PoolNamesExhaustedError extends Schema.TaggedError<PoolNamesExhaustedError>()(
  "PoolNamesExhaustedError",
  { prefix: Schema.String, count: Schema.Int },
) {
  override get message() {
    return `cannot grow the pool to ${String(this.count)}: no free name ${this.prefix}00 to ${this.prefix}99 is left`;
  }
}

export interface PoolPlan {
  /** Org stores at a free pool name, in name order: a run that crashed after a create left them. */
  readonly adopt: ReadonlyArray<StoreDomain>;
  /** Names to create, in order, after the adoptions. */
  readonly create: ReadonlyArray<string>;
}

const isFit = (store: OrgStore) =>
  store.type === "dev" && store.plan === "basic";

/** The pool only grows: a `count` at or below the pool's size creates nothing. */
export const planPool = Effect.fn("Pool.planPool")(function* (input: {
  readonly listed: ReadonlyArray<StoreDomain>;
  readonly orgStores: ReadonlyArray<OrgStore>;
  readonly prefix: PoolPrefix;
  readonly count: number;
}): Effect.fn.Return<PoolPlan, PoolStoresUnfitError | PoolNamesExhaustedError> {
  const byDomain = new Map(
    input.orgStores.map((store) => [store.domain, store]),
  );
  const unfit = input.listed.flatMap((domain): ReadonlyArray<UnfitStore> => {
    const store = handleOf(domain);
    const found = byDomain.get(domain);
    if (found === undefined) return [{ store, reason: "missing" }];
    if (found.type !== "dev")
      return [{ store, reason: "type", found: found.type }];
    if (found.plan !== "basic")
      return [
        {
          store,
          reason: "plan",
          ...(found.plan === undefined ? {} : { found: found.plan }),
        },
      ];
    return [];
  });
  if (unfit.length > 0)
    return yield* new PoolStoresUnfitError({ stores: unfit });

  const listed = new Set<string>(input.listed);
  const names = poolNames(input.prefix);
  const adopt = names
    .map(domainOf)
    .filter((domain) => !listed.has(domain))
    .filter((domain) => {
      const found = byDomain.get(domain);
      return found !== undefined && isFit(found);
    });

  // A taken name does not fail `store create`; Shopify gives the store a
  // suffixed domain, so skip every name an org store already uses.
  const taken = new Set<string>([
    ...input.orgStores.map((store) => store.domain),
    ...input.orgStores.flatMap((store) =>
      store.name === undefined ? [] : [`${store.name}.myshopify.com`],
    ),
    ...listed,
  ]);
  const wanted = Math.max(0, input.count - input.listed.length - adopt.length);
  const create = names
    .filter((name) => !taken.has(`${name}.myshopify.com`))
    .slice(0, wanted);
  if (create.length < wanted)
    return yield* new PoolNamesExhaustedError({
      prefix: input.prefix,
      count: input.count,
    });
  return { adopt, create };
});
