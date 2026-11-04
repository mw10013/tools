import { readFileSync } from "node:fs";

/**
 * The app's handle, which names it in admin URLs: `/apps/<handle>` and `/charges/<handle>`.
 *
 * @module
 */
import * as Array from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const AppHandleLine = Schema.TemplateLiteralParser([
  'handle = "',
  Schema.String,
  '"',
]);
const decodeAppHandleLine = Schema.decodeUnknownOption(AppHandleLine);

/**
 * The `handle = "…"` line of `tomlFile` in the working directory: `shopify.app.toml` for the dev
 * app, which the dev and e2e stores run, or a stage's `shopify.app.<stage>.toml`. Synchronous,
 * because `playwright.config.ts` builds its URLs with it.
 */
export const appHandle = (tomlFile = "shopify.app.toml"): string =>
  Option.getOrThrowWith(
    Array.findFirst(readFileSync(tomlFile, "utf8").split("\n"), (line) =>
      Option.map(decodeAppHandleLine(line.trim()), ([, handle]) => handle),
    ),
    () => new Error(`${tomlFile} has no handle = "<app handle>" line`),
  );
