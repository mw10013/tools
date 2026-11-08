/**
 * How an app names a devkit release. A release is the tag `devkit-v<x.y.z>` in `mw10013/tools`,
 * and an app pins it with the one spec {@link specOf} writes. Every other spec (`file:`, `link:`,
 * a branch, a sha, a prerelease) is a trial that must not reach `main`, and {@link pinOf} says
 * which kind it is.
 *
 * @module
 */
import * as Option from "effect/Option";

import { versionOfTag } from "#devkit/core/release.ts";

export const PACKAGE = "@mw10013/devkit";
export const REPOSITORY = "https://github.com/mw10013/tools.git";
export const TAG_PREFIX = "devkit-v";
const SPEC_PREFIX = "github:mw10013/tools";

export const tagOf = (version: string) => `${TAG_PREFIX}${version}`;

/** The spec an app declares to depend on a release. */
export const specOf = (version: string) => `${SPEC_PREFIX}#${tagOf(version)}`;

export type UnpinnedKind =
  | "file"
  | "link"
  | "branch"
  | "sha"
  | "prerelease"
  | "other";

export type Pin =
  | { readonly _tag: "Pinned"; readonly version: string }
  | { readonly _tag: "Unpinned"; readonly kind: UnpinnedKind };

const unpinned = (kind: UnpinnedKind): Pin => ({ _tag: "Unpinned", kind });

const PRERELEASE_TAG = /^devkit-v\d+\.\d+\.\d+-/u;
const SHA = /^[0-9a-f]{7,40}$/u;

/** Whether a declared spec pins a release, or which kind of trial it is. */
export const pinOf = (spec: string): Pin => {
  if (spec.startsWith("file:")) return unpinned("file");
  if (spec.startsWith("link:")) return unpinned("link");
  if (spec !== SPEC_PREFIX && !spec.startsWith(`${SPEC_PREFIX}#`))
    return unpinned("other");
  const ref = spec.slice(SPEC_PREFIX.length + 1);
  return Option.match(versionOfTag(TAG_PREFIX, ref), {
    onSome: (version): Pin => ({ _tag: "Pinned", version }),
    onNone: () =>
      PRERELEASE_TAG.test(ref)
        ? unpinned("prerelease")
        : unpinned(SHA.test(ref) ? "sha" : "branch"),
  });
};
