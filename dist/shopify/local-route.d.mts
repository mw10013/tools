import { RunningServer } from "./server.mjs";
import { BrowserContext } from "playwright";
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
export declare const routeAppToLocal: (context: BrowserContext, server: RunningServer) => Promise<void>;