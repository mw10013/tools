/**
 * A Vitest `globalSetup` for an app's integration project: every run starts with no
 * `<app>-test` stack in `.alchemy/`. Over a stage an earlier run left behind (interrupted, or
 * kept on purpose), Alchemy restarts a local Worker on a new port but plans the bindings that
 * carry its own URL from the stored one, the old port, so the Worker points at nothing. The stack
 * is local and exists only for these runs, so its state, data and bundles are removed before any
 * file deploys.
 *
 * @module
 */
import fs from "node:fs";
import path from "node:path";

import { APP_NAME, ROOT } from "#devkit/core/app.ts";

export default function setup() {
  const stack = `${APP_NAME}-test`;
  const dotAlchemy = path.join(ROOT, ".alchemy");
  fs.rmSync(path.join(dotAlchemy, "state", stack), {
    recursive: true,
    force: true,
  });
  for (const directory of ["local", "bundles"]) {
    const parent = path.join(dotAlchemy, directory);
    if (!fs.existsSync(parent)) continue;
    for (const name of fs.readdirSync(parent))
      if (name.startsWith(`${stack}-`))
        fs.rmSync(path.join(parent, name), { recursive: true, force: true });
  }
}
