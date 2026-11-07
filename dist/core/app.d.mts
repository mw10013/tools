import * as Schema from "effect/Schema";
export interface App {
  /** The directory holding the app's `package.json`: where devkit runs commands and finds `.alchemy/`, `.env.<stage>` and `shopify.app.toml`. */
  readonly root: string;
  /** `package.json`'s `name`: the app's Alchemy stack and the prefix of its deployed Workers. */
  readonly name: string;
}
declare const NoAppError_base: Schema.Class<NoAppError, Schema.TaggedStruct<"NoAppError", {
  readonly directory: Schema.String;
}>, import("effect/Cause").YieldableError>;
export declare class NoAppError extends NoAppError_base {
  get message(): string;
}
/**
 * The app `directory` belongs to, by default the working directory's. Synchronous, because the
 * Vite and Playwright configs call devkit at load. It reads one `package.json` and stats at most
 * a few directories, so callers call it where they need it instead of caching it.
 *
 * Callers that know the app's directory pass it: a config passes `import.meta.dirname` and the
 * Vitest `globalSetup` passes `project.config.root`, so a monorepo root that loads an app's
 * config still resolves that app. CLIs and scripts take the default, since bosun, `vp run` and
 * `vp -C <app>` all start them in the app's directory.
 *
 * @throws {NoAppError} outside any app
 */
export declare const app: (directory?: string) => App;
export {};