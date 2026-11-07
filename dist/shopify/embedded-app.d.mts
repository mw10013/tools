import { FrameLocator, Page } from "playwright";
/**
 * The embedded app's iframe: its `src` carries `embedded=1`; the Shopify admin's own chrome is the
 * top-level `page`. Re-resolved on every call on purpose: App Bridge re-renders the iframe during
 * navigation, so a captured `contentFrame()` handle detaches and throws, where a `frameLocator`
 * never does. `embedded=1` alone is not unique: an open `s-app-window` is a second embedded
 * iframe carrying it, and every locator built on that fails with a strict mode violation, so
 * `chrome=window` is excluded to keep this the app's own frame.
 */
export declare const appFrame: (page: Page) => FrameLocator;
/**
 * CSS that hides the Shopify admin overlays a recording or picture must not show: the dev mini
 * console, the Sidekick composer, the Sidekick field around it (its grey banner sits at the foot
 * of the content area, positioned absolutely, not fixed) and the toast viewport. The class stems
 * are Shopify's generated names and change without notice, so a caller that must not film an
 * overlay checks for one too, as `help-screenshots`' overlap check does.
 */
export declare const HIDE_OVERLAYS = "[class*=\"_Composer_\"], [class*=\"_SidekickField_\"], [class*=\"_MiniConsole_\"], #admin-next-toast-viewport { visibility: hidden !important; }";
/**
 * Waits until the document in `scope` is safe to interact with: the `data-hydrated` marker on
 * `<body>`, which flips in the commit that clears the body's `inert`. Playwright's actionability
 * is inert-blind, so a click inside an inert subtree passes every check and is silently
 * swallowed by the browser.
 */
export declare const awaitHydration: (scope: Page | FrameLocator, timeout?: number) => Promise<void>;
/**
 * Collapses the Shopify CLI's Dev Console panel if it is expanded. The panel is an admin-document
 * overlay over the lower half of the viewport that outranks the app's iframe in the top
 * document's hit test, so a click Playwright finds actionable inside the frame lands on the
 * console instead, and silently: the action reports success and the app never sees the event.
 * Whether it is expanded comes from the Shopify admin session the storage state was exported from, so it
 * varies between machines and runs; it is closed here rather than left to whoever opened it last.
 *
 * Expansion is read from the panel's geometry, not the toggle: the button keeps its name in both
 * states and has no `aria-expanded`, so an unconditional click would expand a collapsed console
 * every other run. Collapsing slides the "Dev Console" heading below the viewport. No heading
 * means no console (a production-like admin), and nothing to do.
 *
 * The toggle is found by Shopify's generated class stem: its accessible name is `hide`, which
 * another admin button shares. Self-contained, because `scripts/browser.ts` sends its source
 * into a browser session.
 */
export declare const closeDevConsole: (page: Page) => Promise<void>;
/**
 * One wait, no reload: a cold load hydrates in about 3 s (at most 5 s over 30 loads routed by
 * `routeAppToLocal`, 5 s at the 90th percentile through the tunnel), so a frame that is not
 * hydrated after 15 s is stuck on a request that will never finish, and a reload only hides which.
 *
 * A store with no plan is sent to Shopify's plan selection page
 * (`/store/<store>/charges/<app>/pricing_plans`), so a timed-out wait there fails naming the fix.
 * Self-contained but for {@link appFrame}, {@link awaitHydration} and {@link closeDevConsole}, because
 * `scripts/browser.ts` sends its source into a browser session with theirs.
 */
export declare const prepareApp: (page: Page) => Promise<FrameLocator>;
/**
 * Shopify immediately redirects to re-run the embed handshake. Waiting for `"load"` can abort
 * navigation; `"commit"` resolves before that redirect and {@link prepareApp} gates interaction.
 */
export declare const gotoApp: (page: Page, path?: string) => Promise<FrameLocator>;