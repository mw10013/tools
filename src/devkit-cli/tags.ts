/**
 * The published releases: the `devkit-v<x.y.z>` tags of a tools repository, read from a remote
 * with `git ls-remote` (no clone, no token for a public repository) and their annotations from a
 * throwaway bare repository.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { capture, run } from "#wt/process.ts";

import * as Spec from "./spec.ts";

export class TagsUnreachableError extends Schema.TaggedError<TagsUnreachableError>()(
  "TagsUnreachableError",
  { remote: Schema.String, detail: Schema.String },
) {
  override get message() {
    return `cannot list the devkit releases of ${this.remote}: ${this.detail}`;
  }
}

/** A published release. `commit` is the release commit the tag names, which lockfiles pin. */
export interface Tag {
  readonly version: string;
  readonly tag: string;
  readonly commit: string;
}

const byVersion = (a: Tag, b: Tag) =>
  Option.match(
    Option.all({
      a: Spec.parseVersion(a.version),
      b: Spec.parseVersion(b.version),
    }),
    { onNone: () => 0, onSome: ({ a, b }) => Spec.compareVersions(a, b) },
  );

/** The release tags in `refs/tags/` lines of `ls-remote`, oldest first. A peeled `^{}` line names the commit. */
export const parseTags = (lsRemote: string): readonly Tag[] => {
  const commits = new Map<string, string>();
  for (const line of lsRemote.split("\n")) {
    const [sha = "", ref = ""] = line.split("\t");
    if (!ref.startsWith("refs/tags/")) continue;
    const name = ref.slice("refs/tags/".length);
    const peeled = name.endsWith("^{}");
    const tag = peeled ? name.slice(0, -3) : name;
    if (peeled || !commits.has(tag)) commits.set(tag, sha);
  }
  return [...commits]
    .flatMap(([tag, commit]) =>
      Option.match(Spec.versionOfTag(tag), {
        onNone: () => [],
        onSome: (version): Tag[] => [{ version, tag, commit }],
      }),
    )
    .toSorted(byVersion);
};

/** The releases `remote` (a URL, or `.` for the local tags) holds, oldest first. Fails when it cannot be reached. */
export const listTags = Effect.fn("Tags.listTags")(function* (
  directory: string,
  remote: string,
) {
  const output = yield* capture(directory, "git", [
    "ls-remote",
    "--tags",
    remote,
    `refs/tags/${Spec.TAG_PREFIX}*`,
  ]).pipe(
    Effect.mapError(
      (error) => new TagsUnreachableError({ remote, detail: error.detail }),
    ),
  );
  if (output.exitCode !== 0)
    return yield* new TagsUnreachableError({
      remote,
      detail: output.stderr.trim().split("\n").at(-1) ?? "no output",
    });
  return parseTags(output.stdout);
});

export const latestOf = (tags: readonly Tag[]) =>
  Option.fromNullishOr(tags.at(-1));

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
  const after = Option.flatMap(from, Spec.parseVersion);
  const upTo = Spec.parseVersion(to);
  return [...messages]
    .flatMap(([tag, message]) =>
      Option.match(
        Option.flatMap(Spec.versionOfTag(tag), (version) =>
          Option.map(Spec.parseVersion(version), (parsed) => ({
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
          onSome: (limit) => Spec.compareVersions(parsed, limit) <= 0,
        }) &&
        Option.match(after, {
          onNone: () => true,
          onSome: (floor) => Spec.compareVersions(parsed, floor) > 0,
        }),
    )
    .toSorted((a, b) => Spec.compareVersions(b.parsed, a.parsed))
    .map(({ tag, message }) => ({ tag, message }));
};
