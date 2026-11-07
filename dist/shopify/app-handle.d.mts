/**
 * The `handle = "…"` line of `tomlFile` in the working directory: `shopify.app.toml` for the dev
 * app, which the dev and e2e stores run, or a stage's `shopify.app.<stage>.toml`. Synchronous,
 * because `playwright.config.ts` builds its URLs with it.
 */
export declare const appHandle: (tomlFile?: string) => string;