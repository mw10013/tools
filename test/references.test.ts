import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";

import * as Checkouts from "#references/checkouts.ts";
import type { Source } from "#references/sources.ts";

const git = (directory: string, ...args: string[]) =>
  execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const run = <A, E>(effect: Effect.Effect<A, E, FileSystemServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));
type FileSystemServices = Effect.Services<ReturnType<typeof Checkouts.sync>>;

const fixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "tools-references-"));
  const upstream = path.join(root, "upstream");
  mkdirSync(upstream);
  git(upstream, "init", "-b", "production");
  git(upstream, "config", "user.name", "Reference tests");
  git(upstream, "config", "user.email", "test@example.invalid");
  const commit = (text: string) => {
    writeFileSync(path.join(upstream, "page.md"), text);
    git(upstream, "add", "page.md");
    git(upstream, "commit", "-m", text);
    return git(upstream, "rev-parse", "HEAD");
  };
  commit("initial");
  const source: Source = {
    name: "docs",
    repository: `file://${upstream}`,
    kind: "branch",
    target: "production",
  };
  return {
    root,
    upstream,
    commit,
    source,
    destination: path.join(root, "downloads"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

await test("branch sync clones, fast-forwards, and preserves dirty or divergent checkouts", async () => {
  const f = fixture();
  try {
    assert.match(
      await run(Checkouts.status(f.destination, f.source)),
      /missing/u,
    );
    await run(Checkouts.sync(f.destination, f.source));
    const checkout = path.join(f.destination, "docs");
    const next = f.commit("updated");
    await run(Checkouts.sync(f.destination, f.source));
    assert.equal(git(checkout, "rev-parse", "HEAD"), next);
    writeFileSync(path.join(checkout, "untracked.md"), "keep me");
    assert.match(
      await run(Checkouts.status(f.destination, f.source)),
      /dirty/u,
    );
    await assert.rejects(
      run(Checkouts.sync(f.destination, f.source)),
      /local changes/u,
    );
    assert.equal(
      readFileSync(path.join(checkout, "untracked.md"), "utf8"),
      "keep me",
    );
    rmSync(path.join(checkout, "untracked.md"));
    git(checkout, "config", "user.name", "Reference tests");
    git(checkout, "config", "user.email", "test@example.invalid");
    writeFileSync(path.join(checkout, "local.md"), "local");
    git(checkout, "add", "local.md");
    git(checkout, "commit", "-m", "local");
    const local = git(checkout, "rev-parse", "HEAD");
    f.commit("upstream divergence");
    await assert.rejects(
      run(Checkouts.sync(f.destination, f.source)),
      /failed/u,
    );
    assert.equal(git(checkout, "rev-parse", "HEAD"), local);
  } finally {
    f.cleanup();
  }
});

await test("tag sync changes releases while refusing branches and untagged local commits", async () => {
  const f = fixture();
  try {
    git(f.upstream, "tag", "1.0.0");
    const first = {
      ...f.source,
      kind: "tag",
      target: "1.0.0",
    } satisfies Source;
    await run(Checkouts.sync(f.destination, first));
    const checkout = path.join(f.destination, "docs");
    assert.equal(git(checkout, "branch", "--show-current"), "");
    const next = f.commit("release two");
    git(f.upstream, "tag", "2.0.0");
    const second = { ...first, target: "2.0.0" };
    await run(Checkouts.sync(f.destination, second));
    assert.equal(git(checkout, "rev-parse", "HEAD"), next);
    git(checkout, "switch", "-c", "local");
    await assert.rejects(
      run(Checkouts.sync(f.destination, first)),
      /detached HEAD/u,
    );
    git(checkout, "checkout", "--detach");
    git(checkout, "config", "user.name", "Reference tests");
    git(checkout, "config", "user.email", "test@example.invalid");
    git(checkout, "commit", "--allow-empty", "-m", "local detached work");
    await assert.rejects(
      run(Checkouts.sync(f.destination, first)),
      /not tagged/u,
    );
  } finally {
    f.cleanup();
  }
});

await test("existing unrelated directories and origins are refused", async () => {
  const f = fixture();
  try {
    mkdirSync(path.join(f.destination, "docs"), { recursive: true });
    await assert.rejects(
      run(Checkouts.sync(f.destination, f.source)),
      /not a managed/u,
    );
    rmSync(path.join(f.destination, "docs"), { recursive: true });
    await run(Checkouts.sync(f.destination, f.source));
    const checkout = path.join(f.destination, "docs");
    git(
      checkout,
      "remote",
      "set-url",
      "origin",
      "https://example.invalid/other.git",
    );
    await assert.rejects(
      run(Checkouts.sync(f.destination, f.source)),
      /unexpected origin/u,
    );
  } finally {
    f.cleanup();
  }
});

await test("failed clones leave no destination or staging directory", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      run(
        Checkouts.sync(f.destination, {
          ...f.source,
          target: "missing-branch",
        }),
      ),
      /failed/u,
    );
    assert.deepEqual(readdirSync(f.destination), []);
  } finally {
    f.cleanup();
  }
});
