/**
 * The annotations of the published `devkit-v<x.y.z>` releases, read from a throwaway bare
 * repository, and the release log `devkit upgrade` prints from them. The tags themselves are
 * listed by `listTags` in `@mw10013/devkit/core/release`.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import {
  compareVersions,
  parseVersion,
  versionOfTag,
} from "#devkit/core/release.ts";
import { run } from "#wt/process.ts";

import * as Spec from "./spec.ts";

/**
 * Each release's tag annotation, by tag name. The tags are fetched into a throwaway bare
 * repository, because `ls-remote` shows no messages and an app has no tools repository.
 */
export const annotations = (remote: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "devkit-tags-",
      });
      yield* run(directory, "git", ["init", "--bare", "--quiet"]);
      yield* run(directory, "git", [
        "fetch",
        "--quiet",
        "--filter=blob:none",
        remote,
        `+refs/tags/${Spec.TAG_PREFIX}*:refs/tags/${Spec.TAG_PREFIX}*`,
      ]);
      const listed = yield* run(directory, "git", [
        "for-each-ref",
        "--format=%(refname:strip=2)%09%(contents)%00",
        `refs/tags/${Spec.TAG_PREFIX}*`,
      ]);
      return new Map(
        listed
          .split("\0")
          .map((record) => record.replace(/^\n/u, ""))
          .filter((record) => record.length > 0)
          .map((record): [string, string] => {
            const at = record.indexOf("\t");
            return [record.slice(0, at), record.slice(at + 1).trim()];
          }),
      );
    }),
  );

/** The annotations of the releases after `from` up to and including `to`, newest first. */
export const releaseLog = (
  messages: ReadonlyMap<string, string>,
  from: Option.Option<string>,
  to: string,
) => {
  const after = Option.flatMap(from, parseVersion);
  const upTo = parseVersion(to);
  return [...messages]
    .flatMap(([tag, message]) =>
      Option.match(
        Option.flatMap(versionOfTag(Spec.TAG_PREFIX, tag), (version) =>
          Option.map(parseVersion(version), (parsed) => ({
            tag,
            message,
            parsed,
          })),
        ),
        { onNone: () => [], onSome: (entry) => [entry] },
      ),
    )
    .filter(
      ({ parsed }) =>
        Option.match(upTo, {
          onNone: () => false,
          onSome: (limit) => compareVersions(parsed, limit) <= 0,
        }) &&
        Option.match(after, {
          onNone: () => true,
          onSome: (floor) => compareVersions(parsed, floor) > 0,
        }),
    )
    .toSorted((a, b) => compareVersions(b.parsed, a.parsed))
    .map(({ tag, message }) => ({ tag, message }));
};
