import { runCommand } from "./command.mjs";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
// core/release.ts
/**
* Releases a repository's built package as an annotated tag `<tagPrefix><x.y.z>`. The tag names
* an orphan release commit whose tree is what the caller's `build` writes plus a README, and
* nothing else: an app installs that commit as `github:<owner>/<repo>#<tag>`, and no branch holds
* it. Each release commit's parent is the previous one, so `git log <tag>` is the release history.
* The commit is written through a throwaway index, so the working tree is never touched.
*
* A tag is never moved, because lockfiles pin its commit. Releasing a version that exists again
* succeeds and creates nothing when the build gives the same tree.
*
* @module
*/
const ORIGIN = "origin";
const MAIN = "main";
const STABLE = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$/u;
const parseVersion = (text) => {
	const groups = STABLE.exec(text)?.groups;
	if (groups === void 0) return Option.none();
	return Option.some({
		major: Number(groups.major),
		minor: Number(groups.minor),
		patch: Number(groups.patch)
	});
};
const compareVersions = (a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch;
/** The version a `<tagPrefix><x.y.z>` tag names, `None` for any other name. */
const versionOfTag = (tagPrefix, tag) => tag.startsWith(tagPrefix) ? Option.filter(Option.some(tag.slice(tagPrefix.length)), (version) => Option.isSome(parseVersion(version))) : Option.none();
const byVersion = (a, b) => Option.match(Option.all({
	a: parseVersion(a.version),
	b: parseVersion(b.version)
}), {
	onNone: () => 0,
	onSome: ({ a, b }) => compareVersions(a, b)
});
/**
* The `<tagPrefix><x.y.z>` tags in the `refs/tags/` lines of `ls-remote`, oldest first. A peeled
* `^{}` line names the commit.
*/
const parseTags = (tagPrefix, lsRemote) => {
	const commits = /* @__PURE__ */ new Map();
	for (const line of lsRemote.split("\n")) {
		const [sha = "", ref = ""] = line.split("	");
		if (!ref.startsWith("refs/tags/")) continue;
		const name = ref.slice(10);
		const peeled = name.endsWith("^{}");
		const tag = peeled ? name.slice(0, -3) : name;
		if (peeled || !commits.has(tag)) commits.set(tag, sha);
	}
	return [...commits].flatMap(([tag, commit]) => Option.match(versionOfTag(tagPrefix, tag), {
		onNone: () => [],
		onSome: (version) => [{
			version,
			tag,
			commit
		}]
	})).toSorted(byVersion);
};
const latestOf = (tags) => Option.fromNullishOr(tags.at(-1));
var TagsUnreachableError = class extends Schema.TaggedError()("TagsUnreachableError", {
	remote: Schema.String,
	tagPrefix: Schema.String,
	detail: Schema.String
}) {
	get message() {
		return `cannot list the ${this.tagPrefix}* releases of ${this.remote}: ${this.detail}`;
	}
};
const git = (directory, args, env) => runCommand("git", [
	"-C",
	directory,
	...args
], void 0, env);
const lastLine = (text) => text.trim().split("\n").at(-1) ?? "no output";
/**
* The releases `remote` (a URL, or `.` for the local tags) holds, oldest first, run from
* `directory`. Fails when it cannot be reached.
*/
const listTags = Effect.fn("Release.listTags")(function* (directory, remote, tagPrefix) {
	const output = yield* git(directory, [
		"ls-remote",
		"--tags",
		remote,
		`refs/tags/${tagPrefix}*`
	]).pipe(Effect.mapError((error) => new TagsUnreachableError({
		remote,
		tagPrefix,
		detail: lastLine(error.message)
	})));
	return parseTags(tagPrefix, output);
});
var DirtyCheckoutError = class extends Schema.TaggedError()("DirtyCheckoutError", {
	directory: Schema.String,
	changes: Schema.Array(Schema.String)
}) {
	get message() {
		return `${this.directory} has uncommitted changes: ${this.changes.join(", ")}`;
	}
};
/** Fails while the checkout holds a change, a deleted file or an untracked one. */
const requireClean = Effect.fn("Release.requireClean")(function* (directory) {
	const changes = (yield* git(directory, ["status", "--porcelain"])).split("\n").filter((line) => line.length > 0);
	if (changes.length > 0) return yield* new DirtyCheckoutError({
		directory,
		changes: changes.slice(0, 5).map((line) => line.slice(3))
	});
});
var NotAtOriginMainError = class extends Schema.TaggedError()("NotAtOriginMainError", {
	head: Schema.String,
	origin: Schema.String
}) {
	get message() {
		return `HEAD ${this.head.slice(0, 7)} is not ${ORIGIN}/${MAIN} ${this.origin.slice(0, 7)}: release from the merged commit`;
	}
};
var SourceMovedError = class extends Schema.TaggedError()("SourceMovedError", {
	head: Schema.String,
	now: Schema.String,
	step: Schema.String
}) {
	get message() {
		return `HEAD moved from ${this.head.slice(0, 7)} to ${this.now.slice(0, 7)} during ${this.step}: the release would not be the source it names`;
	}
};
var NotReleaseTagError = class extends Schema.TaggedError()("NotReleaseTagError", {
	tag: Schema.String,
	commit: Schema.String,
	name: Schema.String
}) {
	get message() {
		return `${this.tag} names ${this.commit.slice(0, 7)}, which is not a ${this.name} release commit: rename or delete that tag, or release under another prefix`;
	}
};
var NotRepositoryRootError = class extends Schema.TaggedError()("NotRepositoryRootError", {
	repo: Schema.String,
	root: Schema.String
}) {
	get message() {
		return `${this.repo} is not the top level of its repository ${this.root}: pass the checkout's root as repo`;
	}
};
var SourcePathNotFoundError = class extends Schema.TaggedError()("SourcePathNotFoundError", {
	sourcePath: Schema.String,
	head: Schema.String
}) {
	get message() {
		return `${this.sourcePath} is not in HEAD ${this.head.slice(0, 7)}: sourcePath is relative to the repository root`;
	}
};
var InvalidVersionError = class extends Schema.TaggedError()("InvalidVersionError", { version: Schema.String }) {
	get message() {
		return `${this.version} is not a release version: write major.minor.patch, with no prefix or prerelease`;
	}
};
var VersionNotGreaterError = class extends Schema.TaggedError()("VersionNotGreaterError", {
	version: Schema.String,
	latest: Schema.String
}) {
	get message() {
		return `${this.version} is not greater than the latest release ${this.latest}`;
	}
};
var TagTreeMismatchError = class extends Schema.TaggedError()("TagTreeMismatchError", {
	tag: Schema.String,
	existing: Schema.String,
	built: Schema.String
}) {
	get message() {
		return `${this.tag} already exists with tree ${this.existing.slice(0, 7)}, but this checkout builds ${this.built.slice(0, 7)}; a release tag is never moved, so release the next version`;
	}
};
const SOURCE_LINE = /^Source: (?<sha>[0-9a-f]{40})$/mu;
const parentOf = (parents) => Option.fromNullishOr(parents.trim().split(" ").at(0)).pipe(Option.filter((sha) => sha.length > 0));
/** Fails unless `origin`'s `main` is `head`. */
const requireAtOriginMain = Effect.fnUntraced(function* (repo, head) {
	const origin = (yield* git(repo, [
		"ls-remote",
		ORIGIN,
		`refs/heads/${MAIN}`
	])).split("	").at(0)?.trim();
	if (head !== origin) return yield* new NotAtOriginMainError({
		head,
		origin: origin ?? ""
	});
});
/**
* Fails unless `entry` names a commit this machinery wrote: its message's first line is
* `<name> <version>` and it carries a `Source:` line. Any other tag under the prefix (a tag on a
* main commit, say) would otherwise become the next release's parent and pull main's history in.
*/
const requireReleaseCommit = Effect.fnUntraced(function* (repo, name, entry) {
	const body = yield* git(repo, [
		"log",
		"-1",
		"--format=%B",
		entry.commit
	]);
	if (body.split("\n").at(0) !== `${name} ${entry.version}` || !SOURCE_LINE.test(body)) return yield* new NotReleaseTagError({
		tag: entry.tag,
		commit: entry.commit,
		name
	});
});
/**
* Releases `version`. A dry run builds the tree and writes the release commit, but creates no tag
* and pushes nothing. When the version exists, its tree must equal the built one; the tag is then
* pushed if origin lacks it, and nothing else is created.
*/
const release = Effect.fn("Release.release")(function* (options) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const { repo, version, tagPrefix, dryRun } = options;
	const run = (...args) => git(repo, args);
	const tag = `${tagPrefix}${version}`;
	const root = (yield* run("rev-parse", "--show-toplevel")).trim();
	if ((yield* fs.realPath(repo)) !== (yield* fs.realPath(root))) return yield* new NotRepositoryRootError({
		repo,
		root
	});
	yield* requireClean(repo);
	const head = (yield* run("rev-parse", "HEAD")).trim();
	yield* requireAtOriginMain(repo, head);
	if (Option.isNone(parseVersion(version))) return yield* new InvalidVersionError({ version });
	yield* run("cat-file", "-e", `HEAD:${options.sourcePath}`).pipe(Effect.catchTag("CommandError", () => Effect.fail(new SourcePathNotFoundError({
		sourcePath: options.sourcePath,
		head
	}))));
	/** Fails unless the checkout is still the clean `head` it was when the release began. */
	const requireUnchanged = Effect.fnUntraced(function* (step) {
		yield* requireClean(repo);
		const now = (yield* run("rev-parse", "HEAD")).trim();
		if (now !== head) return yield* new SourceMovedError({
			head,
			now,
			step
		});
	});
	yield* run("fetch", "--quiet", ORIGIN, `refs/tags/${tagPrefix}*:refs/tags/${tagPrefix}*`);
	const published = yield* listTags(repo, ".", tagPrefix);
	yield* Effect.forEach(published, (entry) => requireReleaseCommit(repo, options.name, entry));
	const latest = latestOf(published);
	const existing = published.find((entry) => entry.version === version);
	if (existing === void 0) {
		if (!Option.match(Option.all({
			next: parseVersion(version),
			last: Option.flatMap(latest, (entry) => parseVersion(entry.version))
		}), {
			onNone: () => true,
			onSome: ({ next, last }) => compareVersions(next, last) > 0
		})) return yield* new VersionNotGreaterError({
			version,
			latest: Option.match(latest, {
				onNone: () => "",
				onSome: (entry) => entry.version
			})
		});
		yield* options.verify;
		yield* requireUnchanged("verify");
	}
	const tree = yield* Effect.scoped(Effect.gen(function* () {
		const work = yield* fs.makeTempDirectoryScoped({ prefix: "release-" });
		const built = path.join(work, "package");
		yield* options.build(built, version);
		yield* fs.writeFileString(path.join(built, "README.md"), options.readme(version));
		const env = { GIT_INDEX_FILE: path.join(work, "index") };
		yield* git(repo, [
			"--work-tree",
			built,
			"add",
			"--all",
			"--force"
		], env);
		return (yield* git(repo, ["write-tree"], env)).trim();
	}));
	yield* requireUnchanged("build");
	const files = (yield* run("ls-tree", "-r", "--name-only", tree)).split("\n").filter((file) => file.length > 0);
	const push = requireAtOriginMain(repo, head).pipe(Effect.andThen(run("push", ORIGIN, `refs/tags/${tag}`)));
	if (existing !== void 0) {
		const existingTree = (yield* run("rev-parse", `${tag}^{tree}`)).trim();
		if (existingTree !== tree) return yield* new TagTreeMismatchError({
			tag,
			existing: existingTree,
			built: tree
		});
		const publish = !((yield* run("ls-remote", ORIGIN, `refs/tags/${tag}`)).trim() !== "") && !dryRun;
		if (publish) yield* push;
		return {
			version,
			tag,
			commit: existing.commit,
			tree,
			parent: Option.getOrNull(parentOf(yield* run("log", "-1", "--format=%P", existing.commit))),
			source: head,
			files,
			existing: true,
			dryRun,
			tagged: false,
			pushed: publish
		};
	}
	const parent = Option.map(latest, (entry) => entry.commit);
	const message = yield* releaseMessage(options, head, latest);
	const commit = (yield* run("commit-tree", tree, ...Option.match(parent, {
		onNone: () => [],
		onSome: (sha) => ["-p", sha]
	}), "-m", message)).trim();
	if (!dryRun) {
		yield* requireAtOriginMain(repo, head);
		yield* run("tag", "-a", tag, commit, "-m", message);
		yield* push;
	}
	return {
		version,
		tag,
		commit,
		tree,
		parent: Option.getOrNull(parent),
		source: head,
		files,
		existing: false,
		dryRun,
		tagged: !dryRun,
		pushed: !dryRun
	};
});
/**
* The release commit's message and its tag's annotation: the version, the source commit it was
* built from, and the `sourcePath` commits since the previous release's source.
*/
const releaseMessage = Effect.fn("Release.message")(function* (options, source, previous) {
	const { repo, sourcePath } = options;
	const header = `${options.name} ${options.version}\n\nSource: ${source}\n\n`;
	if (Option.isNone(previous)) return `${header}First release.\n`;
	const since = SOURCE_LINE.exec(yield* git(repo, [
		"log",
		"-1",
		"--format=%B",
		previous.value.commit
	]))?.groups?.sha;
	if (!(since !== void 0 && (yield* git(repo, [
		"merge-base",
		"--is-ancestor",
		since,
		source
	]).pipe(Effect.as(true), Effect.catchTag("CommandError", () => Effect.succeed(false)))))) return `${header}Changes since ${previous.value.tag} are not listed: its source is not in this history.\n`;
	const changes = (yield* git(repo, [
		"log",
		"--format=- %h %s",
		`${since}..${source}`,
		"--",
		sourcePath
	])).trim();
	return changes === "" ? `${header}No changes to ${sourcePath} since ${previous.value.tag}.\n` : `${header}Changes to ${sourcePath} since ${previous.value.tag}:\n${changes}\n`;
});
export { DirtyCheckoutError, InvalidVersionError, NotAtOriginMainError, NotReleaseTagError, NotRepositoryRootError, SourceMovedError, SourcePathNotFoundError, TagTreeMismatchError, TagsUnreachableError, VersionNotGreaterError, compareVersions, latestOf, listTags, parseTags, parseVersion, release, requireClean, versionOfTag };
