/**
 * A Vitest `globalSetup` for an app's integration project: every run starts with no
 * `<app>-test` stack in `.alchemy/`. Over a stage an earlier run left behind, Alchemy restarts a
 * local Worker on a new port but plans the bindings that carry its own URL from the stored one,
 * the old port, so the Worker points at nothing.
 *
 * It also stops the checkout's orphaned workerds ({@link orphansIn}): a run whose test process
 * died mid-run leaves its workerds holding their ports, which a dev server's port can collide
 * with.
 *
 * The app is the project's own, `project.config.root`, not the working directory's, so a
 * monorepo's root running every app's tests still cleans each app's stack.
 *
 * @module
 */
import fs from "node:fs";
import path from "node:path";

import type { TestProject } from "vite-plus/test/node";

import { app } from "#devkit/core/app.ts";
import {
  describeOrphan,
  orphansIn,
  stopOrphans,
} from "#devkit/core/orphans.ts";

export default function setup(project: TestProject) {
  const { root, name } = app(project.config.root);
  const workerds = orphansIn(root).filter(
    ({ command }) => path.basename(command) === "workerd",
  );
  if (workerds.length > 0) {
    stopOrphans(workerds);
    console.error(
      `integ: stopped ${String(workerds.length)} workerd an earlier run left running: ${workerds.map(describeOrphan).join(", ")}`,
    );
  }
  const stack = `${name}-test`;
  const dotAlchemy = path.join(root, ".alchemy");
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
