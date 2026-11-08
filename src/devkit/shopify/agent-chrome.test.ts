import { assert, describe, it } from "@effect/vitest";
import { type Browser, chromium } from "playwright";
import { vi } from "vite-plus/test";

import { AGENT_CDP, connectAgentChrome, isStoreAdmin } from "./agent-chrome.ts";

describe("connectAgentChrome", () => {
  it("connects with noDefaults, leaving other agents' tabs and downloads alone", async () => {
    const connect = vi
      .spyOn(chromium, "connectOverCDP")
      .mockResolvedValue({} as Browser);
    try {
      await connectAgentChrome();
      assert.deepStrictEqual<readonly (readonly unknown[])[]>(
        connect.mock.calls,
        [[AGENT_CDP, { noDefaults: true }]],
      );
    } finally {
      connect.mockRestore();
    }
  });
});

describe("isStoreAdmin", () => {
  const store = "sandbox-shop-01";

  it("matches the store's admin by URL when the title shows a display name", () => {
    assert.isTrue(
      isStoreAdmin(store, {
        url: `https://admin.shopify.com/store/${store}`,
        title: "Sandbox Shop 01 · Home · Shopify",
      }),
    );
    assert.isTrue(
      isStoreAdmin(store, {
        url: `https://admin.shopify.com/store/${store}/orders`,
        title: `${store} · Orders · Shopify`,
      }),
    );
  });

  it("rejects another store whose handle starts with this one", () => {
    assert.isFalse(
      isStoreAdmin(store, {
        url: `https://admin.shopify.com/store/${store}0`,
        title: "Sandbox Shop 010 · Home · Shopify",
      }),
    );
  });

  it("rejects a tab still loading, titled with its URL", () => {
    assert.isFalse(
      isStoreAdmin(store, {
        url: `https://admin.shopify.com/store/${store}`,
        title: `admin.shopify.com/store/${store}`,
      }),
    );
  });

  it("rejects the login page and a tab with no URL yet", () => {
    assert.isFalse(
      isStoreAdmin(store, {
        url: "https://accounts.shopify.com/lookup",
        title: "Log in · Shopify",
      }),
    );
    assert.isFalse(isStoreAdmin(store, { url: "", title: "" }));
  });
});
