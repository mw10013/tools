export type TestRunKind = "e2e" | "test";
/**
 * This run's directory, made on first call. The first call stores it in the environment, so
 * Playwright's workers, which load the config again, get the same one. Each path in `carry`,
 * relative to a run's directory, is copied from the last run into this one: Playwright's
 * `results/.last-run.json`, which `--last-failed` reads.
 */
export declare const testRunDirectory: (kind: TestRunKind, carry?: readonly string[], root?: string) => string;