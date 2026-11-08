/**
 * `devkit release <x.y.z>` publishes devkit as the tag `devkit-v<x.y.z>` through
 * `@mw10013/devkit/core/release`. Its tree is the built package, `LICENSE` and a README naming
 * the spec apps install it with.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as CoreRelease from "#devkit/core/release.ts";

import * as Spec from "./spec.ts";

const SOURCE_PATH = "src/devkit";

const readmeOf = (version: string) =>
  `# @mw10013/devkit

The dev tooling shared by the apps, built from \`${SOURCE_PATH}\` in https://github.com/mw10013/tools at the commit this release commit's message names.

Install it as \`${Spec.specOf(version)}\`.

This commit holds build output only. Fix devkit in tools and release a new version.
`;

export const release = <E, R>(
  tools: string,
  version: string,
  options: { readonly dryRun: boolean } & Pick<
    CoreRelease.Options<E, R>,
    "verify" | "build"
  >,
) =>
  CoreRelease.release({
    repo: tools,
    version,
    dryRun: options.dryRun,
    name: "devkit",
    tagPrefix: Spec.TAG_PREFIX,
    sourcePath: SOURCE_PATH,
    readme: readmeOf,
    verify: options.verify,
    build: (directory, stamped) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* options.build(directory, stamped);
        yield* fs.copyFile(
          path.join(tools, "LICENSE"),
          path.join(directory, "LICENSE"),
        );
      }),
  });
