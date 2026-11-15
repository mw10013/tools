import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import * as Project from "./project.ts";

const failureMessage = (
  exit: Exit.Exit<unknown, { readonly message: string }>,
) =>
  Exit.isFailure(exit)
    ? Option.getOrUndefined(
        Option.map(Exit.findErrorOption(exit), (error) => error.message),
      )
    : undefined;

const withProject = <A, E, R>(
  manifest: unknown,
  use: (root: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "refs-project-"))),
    (root) =>
      Effect.sync(() => {
        fs.writeFileSync(
          path.join(root, "package.json"),
          JSON.stringify(manifest),
        );
      }).pipe(Effect.andThen(use(root))),
    (root) =>
      Effect.sync(() => {
        fs.rmSync(root, { recursive: true, force: true });
      }),
  );

describe("references", () => {
  it("keeps scoped package names out of reference and directory names", () => {
    expect(Project.sources["yielded-auth"]).toStrictEqual({
      repository: "yielded-dev/auth",
      dependency: "@yielded/auth",
      tag: "@yielded/auth@",
    });
    expect(
      (Object.keys(Project.sources) as Project.Reference[]).filter(
        (reference) => reference.includes("/"),
      ),
    ).toStrictEqual([]);
  });

  it("accepts both Yielded Auth packages, preferring @yielded/auth", () => {
    expect(Project.acceptedDependencies("yielded-auth")).toStrictEqual([
      "@yielded/auth",
      "@yielded/auth-persistence",
    ]);
  });

  it("still accepts either Playwright package", () => {
    expect(Project.acceptedDependencies("playwright")).toStrictEqual([
      "@playwright/test",
      "playwright",
    ]);
  });

  it("uses the single declared dependency for other references", () => {
    expect(Project.acceptedDependencies("effect")).toStrictEqual(["effect"]);
  });

  it("builds per-package tags with their scope intact", () => {
    expect(Project.tagRef("yielded-auth", "0.1.0-beta.48")).toBe(
      "refs/tags/@yielded/auth@0.1.0-beta.48",
    );
    expect(Project.tagRef("effect", "4.1.2")).toBe("refs/tags/effect@4.1.2");
    expect(Project.tagRef("playwright", "1.58.0")).toBe("refs/tags/v1.58.0");
  });
});

layer(NodeServices.layer)("Project.version", (it) => {
  it.effect("reads the pinned prerelease of the preferred package", () =>
    withProject(
      {
        dependencies: {
          "@yielded/auth": "0.1.0-beta.48",
          "@yielded/auth-persistence": "0.1.0-beta.48",
        },
      },
      (root) =>
        Effect.gen(function* () {
          expect(yield* Project.version(root, "yielded-auth")).toBe(
            "0.1.0-beta.48",
          );
        }),
    ),
  );

  it.effect("prefers @yielded/auth when both packages are pinned", () =>
    withProject(
      {
        dependencies: {
          "@yielded/auth": "0.1.0-beta.48",
          "@yielded/auth-persistence": "0.1.0-beta.49",
        },
      },
      (root) =>
        Effect.gen(function* () {
          expect(yield* Project.version(root, "yielded-auth")).toBe(
            "0.1.0-beta.48",
          );
        }),
    ),
  );

  it.effect("accepts @yielded/auth-persistence on its own", () =>
    withProject(
      { devDependencies: { "@yielded/auth-persistence": "0.1.0-beta.48" } },
      (root) =>
        Effect.gen(function* () {
          expect(yield* Project.version(root, "yielded-auth")).toBe(
            "0.1.0-beta.48",
          );
        }),
    ),
  );

  it.effect("names the preferred package when neither is declared", () =>
    withProject({ dependencies: { xstate: "5.0.0" } }, (root) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(Project.version(root, "yielded-auth"));
        expect(failureMessage(exit)).toBe(
          `${path.join(root, "package.json")}: @yielded/auth is not declared`,
        );
      }),
    ),
  );

  it.effect("rejects a prerelease range instead of resolving it", () =>
    withProject(
      { dependencies: { "@yielded/auth": "^0.1.0-beta.48" } },
      (root) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            Project.version(root, "yielded-auth"),
          );
          expect(failureMessage(exit)).toBe(
            `${path.join(root, "package.json")}: @yielded/auth must have an exact version pin`,
          );
        }),
    ),
  );
});
