import { CommandError } from "./command.mjs";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
/** A release version: `major.minor.patch` and nothing after it. Releases carry no prerelease. */
export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}
export declare const parseVersion: (text: string) => Option.Option<Version>;
export declare const compareVersions: (a: Version, b: Version) => number;
/** The version a `<tagPrefix><x.y.z>` tag names, `None` for any other name. */
export declare const versionOfTag: (tagPrefix: string, tag: string) => Option.Option<string>;
/** A published release. `commit` is the release commit the tag names, which lockfiles pin. */
export interface Tag {
  readonly version: string;
  readonly tag: string;
  readonly commit: string;
}
/**
 * The `<tagPrefix><x.y.z>` tags in the `refs/tags/` lines of `ls-remote`, oldest first. A peeled
 * `^{}` line names the commit.
 */
export declare const parseTags: (tagPrefix: string, lsRemote: string) => readonly Tag[];
export declare const latestOf: (tags: readonly Tag[]) => Option.Option<Tag>;
declare const TagsUnreachableError_base: Schema.Class<TagsUnreachableError, Schema.TaggedStruct<"TagsUnreachableError", {
  readonly remote: Schema.String;
  readonly tagPrefix: Schema.String;
  readonly detail: Schema.String;
}>, import("effect/Cause").YieldableError>;
export declare class TagsUnreachableError extends TagsUnreachableError_base {
  get message(): string;
}
/**
 * The releases `remote` (a URL, or `.` for the local tags) holds, oldest first, run from
 * `directory`. Fails when it cannot be reached.
 */
export declare const listTags: (directory: string, remote: string, tagPrefix: string) => Effect.Effect<readonly Tag[], TagsUnreachableError, import("effect/process/ChildProcessSpawner").ChildProcessSpawner>;
declare const DirtyCheckoutError_base: Schema.Class<DirtyCheckoutError, Schema.TaggedStruct<"DirtyCheckoutError", {
  readonly directory: Schema.String;
  readonly changes: Schema.$Array<Schema.String>;
}>, import("effect/Cause").YieldableError>;
export declare class DirtyCheckoutError extends DirtyCheckoutError_base {
  get message(): string;
}
/** Fails while the checkout holds a change, a deleted file or an untracked one. */
export declare const requireClean: (directory: string) => Effect.Effect<undefined, CommandError | DirtyCheckoutError, import("effect/process/ChildProcessSpawner").ChildProcessSpawner>;
declare const NotAtOriginMainError_base: Schema.Class<NotAtOriginMainError, Schema.TaggedStruct<"NotAtOriginMainError", {
  readonly head: Schema.String;
  readonly origin: Schema.String;
}>, import("effect/Cause").YieldableError>;
export declare class NotAtOriginMainError extends NotAtOriginMainError_base {
  get message(): string;
}
declare const SourceMovedError_base: Schema.Class<SourceMovedError, Schema.TaggedStruct<"SourceMovedError", {
  readonly head: Schema.String;
  readonly now: Schema.String;
  readonly step: Schema.String;
}>, import("effect/Cause").YieldableError>;
export declare class SourceMovedError extends SourceMovedError_base {
  get message(): string;
}
declare const NotReleaseTagError_base: Schema.Class<NotReleaseTagError, Schema.TaggedStruct<"NotReleaseTagError", {
  readonly tag: Schema.String;
  readonly commit: Schema.String;
  readonly name: Schema.String;
}>, import("effect/Cause").YieldableError>;
export declare class NotReleaseTagError extends NotReleaseTagError_base {
  get message(): string;
}
declare const NotRepositoryRootError_base: Schema.Class<NotRepositoryRootError, Schema.TaggedStruct<"NotRepositoryRootError", {
  readonly repo: Schema.String;
  readonly root: Schema.String;
}>, import("effect/Cause").YieldableError>;
export declare class NotRepositoryRootError extends NotRepositoryRootError_base {
  get message(): string;
}
declare const SourcePathNotFoundError_base: Schema.Class<SourcePathNotFoundError, Schema.TaggedStruct<"SourcePathNotFoundError", {
  readonly sourcePath: Schema.String;
  readonly head: Schema.String;
}>, import("effect/Cause").YieldableError>;
export declare class SourcePathNotFoundError extends SourcePathNotFoundError_base {
  get message(): string;
}
declare const InvalidVersionError_base: Schema.Class<InvalidVersionError, Schema.TaggedStruct<"InvalidVersionError", {
  readonly version: Schema.String;
}>, import("effect/Cause").YieldableError>;
export declare class InvalidVersionError extends InvalidVersionError_base {
  get message(): string;
}
declare const VersionNotGreaterError_base: Schema.Class<VersionNotGreaterError, Schema.TaggedStruct<"VersionNotGreaterError", {
  readonly version: Schema.String;
  readonly latest: Schema.String;
}>, import("effect/Cause").YieldableError>;
export declare class VersionNotGreaterError extends VersionNotGreaterError_base {
  get message(): string;
}
declare const TagTreeMismatchError_base: Schema.Class<TagTreeMismatchError, Schema.TaggedStruct<"TagTreeMismatchError", {
  readonly tag: Schema.String;
  readonly existing: Schema.String;
  readonly built: Schema.String;
}>, import("effect/Cause").YieldableError>;
export declare class TagTreeMismatchError extends TagTreeMismatchError_base {
  get message(): string;
}
/** What one repository's releases are: where they come from, what they are called and what they hold. */
export interface Options<E, R> {
  /** The checkout's top level to release from. Its `HEAD` must be `origin/main`, with no change. */
  readonly repo: string;
  /** The release commit's first line is `<name> <version>`. */
  readonly name: string;
  /** Each release is the tag `<tagPrefix><version>`. */
  readonly tagPrefix: string;
  /** The path, relative to `repo`, whose commits since the previous release the message lists. */
  readonly sourcePath: string;
  /** The tree's `README.md`. */
  readonly readme: (version: string) => string;
  /**
   * Refuses a source that does not pass its checks. Skipped when the version exists. It must leave
   * the checkout clean and at the same `HEAD`, as must `build`.
   */
  readonly verify: Effect.Effect<void, E, R>;
  /** Writes the tree, except its README, into `directory`, which does not exist yet. */
  readonly build: (directory: string, version: string) => Effect.Effect<unknown, E, R>;
}
/**
 * Releases `version`. A dry run builds the tree and writes the release commit, but creates no tag
 * and pushes nothing. When the version exists, its tree must equal the built one; the tag is then
 * pushed if origin lacks it, and nothing else is created.
 */
export declare const release: <E, R>(options: Options<E, R> & {
  readonly version: string;
  readonly dryRun: boolean;
}) => Effect.Effect<{
  version: string;
  tag: string;
  commit: string;
  tree: string;
  parent: string | null;
  source: string;
  files: string[];
  existing: boolean;
  dryRun: boolean;
  tagged: boolean;
  pushed: boolean;
}, E | CommandError | DirtyCheckoutError | InvalidVersionError | NotAtOriginMainError | NotReleaseTagError | NotRepositoryRootError | import("effect/PlatformError").PlatformError | SourceMovedError | SourcePathNotFoundError | TagTreeMismatchError | TagsUnreachableError | VersionNotGreaterError, R | import("effect/process/ChildProcessSpawner").ChildProcessSpawner | FileSystem.FileSystem | Path.Path>;
export {};