/**
 * Helpers for the devkit-cli tests: scratch directories, git repositories with a bare `origin`,
 * and running an Effect that needs the Node services.
 *
 * @module
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

export const git = (directory: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();

export const write = (root: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};

export const scratch = () =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "devkit-test-")));

/** A repository with a committer and no signing, so its commits and tags need no setup. */
export const initRepository = (directory: string, bare = false) => {
  fs.mkdirSync(directory, { recursive: true });
  git(directory, "init", "--quiet", "-b", "main", ...(bare ? ["--bare"] : []));
  git(directory, "config", "user.email", "devkit@test");
  git(directory, "config", "user.name", "devkit");
  git(directory, "config", "commit.gpgsign", "false");
  git(directory, "config", "tag.gpgsign", "false");
};

export const commitAll = (directory: string, message = "change") => {
  git(directory, "add", "-A");
  git(directory, "commit", "--quiet", "-m", message);
};

/** A bare repository holding annotated `devkit-v<version>` tags on empty commits, by version and annotation. */
export const publishedTags = (
  parent: string,
  annotations: Readonly<Record<string, string>>,
) => {
  const bare = path.join(parent, "published.git");
  const work = path.join(parent, "published");
  initRepository(bare, true);
  initRepository(work);
  git(work, "remote", "add", "origin", bare);
  for (const [version, annotation] of Object.entries(annotations)) {
    git(work, "commit", "--quiet", "--allow-empty", "-m", `devkit ${version}`);
    git(work, "tag", "-a", `devkit-v${version}`, "-m", annotation);
  }
  git(work, "push", "--quiet", "origin", "--tags");
  return bare;
};

export const runEffect = <A, E>(
  effect: Effect.Effect<A, E, NodeServices.NodeServices>,
) => Effect.runPromiseExit(effect.pipe(Effect.provide(NodeServices.layer)));

export const value = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isFailure(exit)) throw new Error(String(exit.cause));
  return exit.value;
};

export const failureTag = (
  exit: Exit.Exit<unknown, { readonly _tag: string }>,
) =>
  Exit.isFailure(exit)
    ? Option.getOrUndefined(
        Option.map(Exit.findErrorOption(exit), (e) => e._tag),
      )
    : undefined;
