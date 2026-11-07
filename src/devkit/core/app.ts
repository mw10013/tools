/**
 * The app devkit acts on: the nearest directory at or above `directory` that holds a
 * `package.json`, never above the repository's top level (the first directory holding a `.git`
 * entry, a directory in a checkout and a file in a worktree). This is the rule bosun and wt apply,
 * so every tool agrees on which app a command runs for. devkit never locates the app from where
 * devkit itself sits: installed as a package it lives under `node_modules`, and a vendored copy
 * sits wherever the app put it.
 *
 * @module
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import * as Schema from "effect/Schema";

export interface App {
  /** The directory holding the app's `package.json`: where devkit runs commands and finds `.alchemy/`, `.env.<stage>` and `shopify.app.toml`. */
  readonly root: string;
  /** `package.json`'s `name`: the app's Alchemy stack and the prefix of its deployed Workers. */
  readonly name: string;
}

export class NoAppError extends Schema.TaggedError<NoAppError>()("NoAppError", {
  directory: Schema.String,
}) {
  override get message() {
    return `no package.json at or above ${this.directory} inside its repository: run this from the app's directory`;
  }
}

const decodeManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String })),
);

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
export const app = (directory: string = process.cwd()): App => {
  let candidate = path.resolve(directory);
  for (;;) {
    const manifest = path.join(candidate, "package.json");
    if (existsSync(manifest))
      return {
        root: candidate,
        name: decodeManifest(readFileSync(manifest, "utf8")).name,
      };
    const parent = path.dirname(candidate);
    if (existsSync(path.join(candidate, ".git")) || parent === candidate)
      throw new NoAppError({ directory });
    candidate = parent;
  }
};
