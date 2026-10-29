import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Project from "#refs/project.ts";

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const run = <A, E>(
  effect: Effect.Effect<A, E, Effect.Services<ReturnType<typeof Project.sync>>>,
) => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));
const COMMIT = "a".repeat(40);
const fixture = () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "tools-refs-")));
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.invalid");
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ dependencies: { effect: "4.0.5" } }),
  );
  writeFileSync(path.join(root, "AGENTS.md"), "keep this exactly\n");
  writeFileSync(path.join(root, ".gitignore"), "# existing\n/refs/\n");
  const stamp = (version = "4.0.5") => {
    const directory = path.join(root, "refs", "effect");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, ".ref.json"),
      JSON.stringify({
        repository: "Effect-TS/effect",
        version,
        commit: COMMIT,
        fetchedAt: "2026-10-29T00:00:00Z",
      }),
    );
    writeFileSync(path.join(directory, "source.ts"), "previous source");
  };
  return {
    root,
    stamp,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

await test("init is repeatable, fixes directory-only ignores, and leaves agent instructions untouched", async () => {
  const f = fixture();
  try {
    await run(Project.init(f.root));
    await run(Project.init(f.root));
    assert.equal(existsSync(path.join(f.root, "refs.json")), false);
    assert.equal(existsSync(path.join(f.root, "refs.lock.json")), false);
    assert.equal(
      readFileSync(path.join(f.root, ".gitignore"), "utf8"),
      "# existing\n/refs\n",
    );
    assert.equal(
      readFileSync(path.join(f.root, "AGENTS.md"), "utf8"),
      "keep this exactly\n",
    );
    assert.match(await run(Project.status(f.root)), /missing; want 4.0.5/u);
    f.stamp();
    assert.match(await run(Project.sync(f.root)), /effect: ok/u);
    assert.equal(existsSync(path.join(f.root, "refs", ".sync-lock")), false);
    writeFileSync(
      path.join(f.root, "package.json"),
      JSON.stringify({ dependencies: { effect: "^4.0.5" } }),
    );
    await assert.rejects(run(Project.version(f.root)), /exact version pin/u);
  } finally {
    f.cleanup();
  }
});

await test("linked worktrees share an ignored symlink and conflicting pins block synchronization", async () => {
  const f = fixture();
  try {
    await run(Project.init(f.root));
    f.stamp();
    git(f.root, "add", ".");
    git(f.root, "commit", "-m", "fixture");
    const worktree = path.join(f.root, "wt");
    git(f.root, "worktree", "add", "-b", "wt-test", worktree);
    await run(Project.init(worktree));
    await run(Project.init(worktree));
    assert.equal(
      readlinkSync(path.join(worktree, "refs")),
      path.join(f.root, "refs"),
    );
    assert.equal(git(worktree, "check-ignore", "refs"), "refs");
    assert.match(await run(Project.sync(worktree)), /effect: ok/u);
    writeFileSync(
      path.join(worktree, "package.json"),
      JSON.stringify({ dependencies: { effect: "4.0.6" } }),
    );
    assert.match(await run(Project.status(worktree)), /stale/u);
    await assert.rejects(
      run(Project.sync(worktree)),
      /refusing to replace shared refs/u,
    );
    await assert.rejects(
      run(Project.sync(f.root)),
      /refusing to replace shared refs/u,
    );
    assert.equal(
      readFileSync(path.join(f.root, "refs", "effect", "source.ts"), "utf8"),
      "previous source",
    );
    rmSync(path.join(worktree, "refs"));
    mkdirSync(path.join(worktree, "refs"));
    await assert.rejects(run(Project.init(worktree)), /must link/u);
  } finally {
    f.cleanup();
  }
});

await test("archive sync preserves old snapshots on failure and replaces them after successful extraction", async () => {
  const f = fixture();
  const previousPath = process.env.PATH;
  try {
    await run(Project.init(f.root));
    f.stamp("4.0.4");
    const realGit = execFileSync("/usr/bin/which", ["git"], {
      encoding: "utf8",
    }).trim();
    const bin = path.join(f.root, "bin");
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh
if [ "$1" = "ls-remote" ]; then
  printf '%s\\trefs/tags/effect@4.0.5\\n' '${COMMIT}'
else
  exec '${realGit}' "$@"
fi
`,
    );
    chmodSync(path.join(bin, "git"), 0o755);
    writeFileSync(path.join(bin, "curl"), "#!/bin/sh\nexit 1\n");
    chmodSync(path.join(bin, "curl"), 0o755);
    process.env.PATH = `${bin}:${previousPath}`;
    await assert.rejects(run(Project.sync(f.root)), /curl .* failed/u);
    assert.deepEqual(readdirSync(path.join(f.root, "refs")), ["effect"]);
    assert.equal(
      readFileSync(path.join(f.root, "refs", "effect", "source.ts"), "utf8"),
      "previous source",
    );
    const source = path.join(f.root, "archive-source");
    mkdirSync(source);
    writeFileSync(path.join(source, "source.ts"), "new source");
    execFileSync("tar", [
      "-czf",
      path.join(f.root, "fixture.tar.gz"),
      "-C",
      f.root,
      "archive-source",
    ]);
    writeFileSync(
      path.join(bin, "curl"),
      '#!/bin/sh\nprintf "%s" "$2" > fetched-url\ncp fixture.tar.gz "$4"\n',
    );
    assert.match(await run(Project.sync(f.root)), /effect: ok/u);
    assert.equal(
      readFileSync(path.join(f.root, "fetched-url"), "utf8"),
      `https://codeload.github.com/Effect-TS/effect/tar.gz/${COMMIT}`,
    );
    assert.equal(
      readFileSync(path.join(f.root, "refs", "effect", "source.ts"), "utf8"),
      "new source",
    );
    assert.deepEqual(readdirSync(path.join(f.root, "refs")), ["effect"]);
    mkdirSync(path.join(f.root, "refs", ".sync-lock"));
    await assert.rejects(
      run(Project.sync(f.root)),
      /another sync may be running/u,
    );
    rmSync(path.join(f.root, "refs", ".sync-lock"), { recursive: true });
    rmSync(path.join(f.root, "refs", "effect", ".ref.json"));
    await assert.rejects(run(Project.sync(f.root)), /unmanaged/u);
  } finally {
    process.env.PATH = previousPath;
    f.cleanup();
  }
});
