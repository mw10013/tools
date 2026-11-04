/**
 * Where a test run keeps its results: `.test-results/<kind>/<start time>/`, one directory per
 * run, so a run never deletes the last one's evidence (Playwright empties its `outputDir` at every
 * start). `.test-results/<kind>/latest` links to the newest. The oldest beyond {@link KEPT} are
 * removed. Synchronous, because the Playwright and Vite configs call it at load.
 *
 * @module
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const KEPT = 30;

export type TestRunKind = "e2e" | "test";

const VARIABLE: Record<TestRunKind, string> = {
  e2e: "E2E_RUN_DIR",
  test: "TEST_RUN_DIR",
};

/**
 * This run's directory, made on first call. The first call stores it in the environment, so
 * Playwright's workers, which load the config again, get the same one. Each path in `carry`,
 * relative to a run's directory, is copied from the last run into this one: Playwright's
 * `results/.last-run.json`, which `--last-failed` reads.
 */
export const testRunDirectory = (
  kind: TestRunKind,
  carry: readonly string[] = [],
  root = process.cwd(),
): string => {
  const known = process.env[VARIABLE[kind]];
  if (known !== undefined) return known;
  const runs = path.join(root, ".test-results", kind);
  const stamp = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d+Z$/u, "Z");
  let directory = path.join(runs, stamp);
  for (let n = 2; fs.existsSync(directory); n++)
    directory = path.join(runs, `${stamp}-${String(n)}`);
  fs.mkdirSync(directory, { recursive: true });
  const latest = path.join(runs, "latest");
  for (const file of carry)
    if (fs.existsSync(path.join(latest, file))) {
      fs.mkdirSync(path.dirname(path.join(directory, file)), {
        recursive: true,
      });
      fs.copyFileSync(path.join(latest, file), path.join(directory, file));
    }
  fs.rmSync(latest, { force: true });
  fs.symlinkSync(path.basename(directory), latest);
  const old = fs
    .readdirSync(runs)
    .filter((name) => name !== "latest")
    .toSorted()
    .slice(0, -KEPT);
  for (const name of old)
    fs.rmSync(path.join(runs, name), { recursive: true, force: true });
  process.env[VARIABLE[kind]] = directory;
  return directory;
};
