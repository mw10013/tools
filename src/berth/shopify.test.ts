import { describe, expect, it } from "vite-plus/test";

import { resultText } from "./shopify.ts";

describe("resultText", () => {
  it("takes the last pretty-printed object after progress lines", () => {
    const stdout = [
      '{"event":"progress","status":"PENDING"}',
      "{",
      '  "store": { "domain": "shop-00.myshopify.com" }',
      "}",
      "",
    ].join("\n");
    expect(JSON.parse(resultText(stdout))).toEqual({
      store: { domain: "shop-00.myshopify.com" },
    });
  });
});
