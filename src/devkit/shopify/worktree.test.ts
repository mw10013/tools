import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { StoreName, storeNameOf } from "./worktree.ts";

const decode = Schema.decodeUnknownOption(StoreName);

describe("StoreName", () => {
  for (const purpose of ["staging", "production"] as const)
    for (const index of [0, 9]) {
      it(`round-trips ${purpose} ${String(index)}`, () => {
        const name = storeNameOf(purpose, index);
        assert.strictEqual(name, `mw10013-${purpose}-shop-0${String(index)}`);
        assert.deepStrictEqual(decode(name), Option.some({ purpose, index }));
      });
    }

  it("reads a pool store", () => {
    assert.deepStrictEqual(
      decode("mw10013-pool-07"),
      Option.some({ purpose: "pool", index: 7 }),
    );
  });

  for (const name of [
    "dev-shop-00",
    "mw10013-dev-shop-00",
    "mw10013-e2e-shop-09",
    "sandbox-shop-00",
    "mw10013-test-shop-00",
    "mw10013-staging-shop-0",
    "mw10013-staging-shop-100",
    "mw10013-pool-shop-00",
    "mw10013-pool-0",
    "pool-00",
  ])
    it(`rejects ${name}`, () => {
      assert.isTrue(Option.isNone(decode(name)));
    });
});
