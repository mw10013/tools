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
 * reach the browser unfollowed, so it follows them at the tunnel's origin. A request is retried
 * once on ECONNRESET, as Chrome retries one sent on a keep-alive connection the server just
 * closed, and a request that still fails fails in the page instead of throwing in the test.
 * Shopify CLI's own `/extensions` path and WebSockets still go through the tunnel: the CLI does
 * not tell the app its proxy's port, so only the app's own server is reached directly.
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
      const fetched = await route
        .fetch({
          url: `${local}${url.pathname}${url.search}`,
          headers: {
            ...request.headers(),
            host: tunnel.host,
            "x-forwarded-host": tunnel.host,
            "x-forwarded-proto": "https",
          },
          maxRedirects: 0,
          maxRetries: 1,
        })
        .then(async (response) => ({
          status: response.status(),
          headers: response.headers(),
          body: await response.body(),
        }))
        .catch(() => undefined);
      // The body is read here because `fulfill({ response })` sends Playwright a reference to it,
      // which closing the context disposes: a request in flight as a spec's `afterAll` closes the
      // context failed the test with "Fetch response has been disposed". `abort` and `fulfill`
      // themselves are silenced once the page is closed.
      await (fetched === undefined
        ? route.abort("connectionfailed")
        : route.fulfill(fetched));
    },
  );
};
