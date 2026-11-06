import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { handleOf, type StoreDomain } from "./domain.ts";
import { domainOf, planPool, type Pool } from "./pool.ts";
import { loadPool, savePool } from "./settings.ts";
import { ShopifyCli } from "./shopify.ts";

/** Shopify gave the new store a suffixed domain because its name was taken. */
export class StoreDomainTakenError extends Schema.TaggedError<StoreDomainTakenError>()(
  "StoreDomainTakenError",
  { name: Schema.String, domain: Schema.String },
) {
  override get message() {
    return `shopify created ${this.name} at ${this.domain}, not ${this.name}.myshopify.com; berth left it out of stores.json`;
  }
}

export interface Ensured {
  readonly pool: Pool;
  readonly adopted: ReadonlyArray<StoreDomain>;
  readonly created: ReadonlyArray<StoreDomain>;
}

/**
 * Creates one store at a time and writes `stores.json` after each, so a
 * failed run keeps every store it made and `acquire` never sees a store that
 * does not exist.
 */
export const ensure = Effect.fn("PoolEnsure.ensure")(function* (
  file: string,
  count: Option.Option<number>,
) {
  const shopify = yield* ShopifyCli;
  const listed = yield* loadPool(file);
  const orgStores = yield* shopify.listDevStores(listed.organization);
  const plan = yield* planPool({
    listed: listed.stores,
    orgStores,
    prefix: listed.prefix,
    count: Option.getOrElse(count, () => 0),
  });
  for (const domain of listed.stores)
    yield* Console.error(`ok       ${handleOf(domain)}`);
  for (const domain of plan.adopt)
    yield* Console.error(`adopted  ${handleOf(domain)}`);

  let pool: Pool = { ...listed, stores: [...listed.stores, ...plan.adopt] };
  let changed = yield* savePool(file, pool);
  const created: Array<StoreDomain> = [];
  const commitHint = Effect.suspend(() =>
    changed
      ? Console.error("stores.json changed: commit it in ~/projects/tools")
      : Effect.void,
  );
  yield* Effect.gen(function* () {
    for (const name of plan.create) {
      const domain = yield* shopify.createDevStore(listed.organization, name);
      if (domain !== domainOf(name))
        return yield* new StoreDomainTakenError({ name, domain });
      created.push(domainOf(name));
      pool = { ...pool, stores: [...pool.stores, domainOf(name)] };
      changed = (yield* savePool(file, pool)) || changed;
      yield* Console.error(`created  ${name}`);
    }
  }).pipe(Effect.ensuring(commitHint));
  return { pool, adopted: plan.adopt, created } satisfies Ensured;
});
