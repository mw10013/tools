import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { appRoot } from "./git.ts";

let scratch: string;
let repo: string;

const write = (file: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), "{}\n");
};

const appRootOf = (directory: string) =>
  Effect.runPromise(
    appRoot(path.join(repo, directory)).pipe(
      Effect.provide(NodeServices.layer),
    ),
  );

beforeEach(() => {
  scratch = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "git-test-")),
  );
  repo = path.join(scratch, "repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "--quiet"], { cwd: repo });
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("appRoot", () => {
  it("is the toplevel of a single-app repo, from any folder in it", async () => {
    write("package.json");
    write("src/web/.keep");
    expect(await appRootOf(".")).toBe(repo);
    expect(await appRootOf("src/web")).toBe(repo);
  });

  it("is the nearest folder with a package.json in a monorepo", async () => {
    write("package.json");
    write("apps/x/package.json");
    write("apps/x/src/.keep");
    write("docs/.keep");
    expect(await appRootOf("apps/x")).toBe(path.join(repo, "apps/x"));
    expect(await appRootOf("apps/x/src")).toBe(path.join(repo, "apps/x"));
    expect(await appRootOf("apps")).toBe(repo);
    expect(await appRootOf("docs")).toBe(repo);
    expect(await appRootOf(".")).toBe(repo);
  });

  it("is the toplevel when no folder up to it has a package.json", async () => {
    write("a/b/.keep");
    expect(await appRootOf("a/b")).toBe(repo);
  });

  it("never looks above the toplevel", async () => {
    fs.writeFileSync(path.join(scratch, "package.json"), "{}\n");
    write("a/.keep");
    expect(await appRootOf("a")).toBe(repo);
  });

  it("fails outside a git checkout", async () => {
    const exit = await Effect.runPromiseExit(
      appRoot(scratch).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(
      Exit.isFailure(exit)
        ? Option.getOrUndefined(
            Option.map(Exit.findErrorOption(exit), (error) => error._tag),
          )
        : undefined,
    ).toBe("NotARepositoryError");
  });
});
