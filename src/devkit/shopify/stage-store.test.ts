import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { staleStageReason } from "./stage-store.ts";

describe("staleStageReason", () => {
  it("keeps a stage set up for the lease's store", () => {
    assert.isTrue(
      Option.isNone(
        staleStageReason(
          { exists: true, store: Option.some("mw10013-pool-01") },
          "mw10013-pool-01",
        ),
      ),
    );
  });

  it("destroys a stage set up for another store", () => {
    assert.deepStrictEqual(
      staleStageReason(
        { exists: true, store: Option.some("mw10013-e2e-shop-00") },
        "mw10013-pool-01",
      ),
      Option.some("it was set up for mw10013-e2e-shop-00"),
    );
  });

  it("destroys a stage whose store is unknown", () => {
    assert.deepStrictEqual(
      staleStageReason(
        { exists: true, store: Option.none() },
        "mw10013-pool-01",
      ),
      Option.some("it records no store"),
    );
  });

  it("has nothing to destroy before the stage first starts", () => {
    assert.isTrue(
      Option.isNone(
        staleStageReason(
          { exists: false, store: Option.some("mw10013-pool-00") },
          "mw10013-pool-01",
        ),
      ),
    );
    assert.isTrue(
      Option.isNone(
        staleStageReason(
          { exists: false, store: Option.none() },
          "mw10013-pool-01",
        ),
      ),
    );
  });
});
