import * as Option from "effect/Option";
import type { BrowserContext } from "playwright";

import type { RunningServer } from "./server.ts";

const routed = new WeakSet<BrowserContext>();

/**
 * Answers `context`'s requests for the app at `server`'s tunnel from the app's local port. The
 * browser runs on this machine, so the tunnel is only for Shopify's servers (webhooks); a dev load
 * is about 240 module requests, and through a quick tunnel each takes 0.2 to 1 s and every one past
 * 200 in flight is a 429 (developers.cloudflare.com/tunnel/get-started/quick-tunnels). The page
 * keeps the tunnel's URL, so its origin and cookies do not change, and the Host and forwarding
 * headers stay the tunnel's, so the app builds its URLs as it would behind the tunnel. Redirects
 * reach the browser unfollowed. Shopify CLI's own `/extensions` path and WebSockets still go
 * through the tunnel: the CLI does not tell the app its proxy's port, so only the app's own
 * server is reached directly.
 */
export const routeAppToLocal = async (
  context: BrowserContext,
  server: RunningServer,
): Promise<void> => {
  if (Option.isNone(server.url) || routed.has(context)) return;
  routed.add(context);
  const tunnel = new URL(server.url.value);
  const local = `http://localhost:${String(server.port)}`;
  await context.route(
    (url) =>
      url.origin === tunnel.origin && !url.pathname.startsWith("/extensions"),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const response = await route.fetch({
        url: `${local}${url.pathname}${url.search}`,
        headers: {
          ...request.headers(),
          host: tunnel.host,
          "x-forwarded-host": tunnel.host,
          "x-forwarded-proto": "https",
        },
        maxRedirects: 0,
      });
      await route.fulfill({ response });
    },
  );
};
