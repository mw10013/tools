import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";

import { leaseOf } from "./berth.ts";

const grantedLease = {
  berth: 1,
  project: "baton",
  checkout: "/Users/mw/projects/baton",
  env: "e2e",
  machine: "mw-mbp",
  ports: {},
  store: {
    domain: "mw10013-pool-01.myshopify.com",
    config: "shopify.app.e2e.toml",
  },
  acquiredAt: "2026-11-01T09:12:44.120Z",
};
const granted = JSON.stringify(grantedLease);

describe("leaseOf", () => {
  it("reads the store's handle and the config", () => {
    assert.deepStrictEqual(
      leaseOf("e2e", granted),
      Result.succeed({
        store: "mw10013-pool-01",
        config: "shopify.app.e2e.toml",
      }),
    );
  });

  it("carries berth's tag and message when every store is leased", () => {
    const message = "all 14 stores in stores.json are leased";
    const result = leaseOf(
      "dev",
      JSON.stringify({
        berth: 1,
        error: { _tag: "StorePoolExhaustedError", stores: 14, message },
      }),
    );
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      assert.strictEqual(result.failure.reason, "StorePoolExhaustedError");
      assert.strictEqual(result.failure.message, message);
    }
  });

  it("fails on output that is not berth's JSON, such as a usage error's help", () => {
    const result = leaseOf("dev", "USAGE\n  berth acquire <env>\n");
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result))
      assert.strictEqual(result.failure.reason, "UnreadableOutput");
  });
});
