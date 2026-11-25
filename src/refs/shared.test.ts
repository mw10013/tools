import { describe, expect, it } from "@effect/vitest";

import * as Shared from "./shared.ts";

describe("t3Version", () => {
  it("reads the version from `t3 --version` output", () => {
    expect(Shared.t3Version("t3 v0.1.12-nightly.20261124.5204")).toBe(
      "0.1.12-nightly.20261124.5204",
    );
    expect(Shared.t3Version("t3 v0.2.0")).toBe("0.2.0");
  });

  it("rejects output that is not a single `t3 v<version>` line", () => {
    expect(Shared.t3Version("0.1.12")).toBeUndefined();
    expect(Shared.t3Version("t3 v0.1.12\nextra")).toBeUndefined();
  });
});
