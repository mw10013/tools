import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

class RefError extends Schema.TaggedError<RefError>()("RefError", {
  message: Schema.String,
}) {}

const Version = Schema.String.check(
  Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u),
);
const Commit = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
const Manifest = Schema.fromJsonString(
  Schema.Struct({
    dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    devDependencies: Schema.optional(
      Schema.Record(Schema.String, Schema.String),
    ),
  }),
);
const Snapshot = Schema.fromJsonString(
  Schema.Struct({
    repository: Schema.Literal("Effect-TS/effect"),
    version: Version,
    commit: Commit,
    fetchedAt: Schema.String,
  }),
  { space: 2 },
);
const decode = <A, I>(schema: Schema.Codec<A, I>, input: I, file: string) =>
  Schema.decodeEffect(schema)(input).pipe(
    Effect.mapError(() => new RefError({ message: `Invalid ${file}` })),
  );

const run = Effect.fn("Project.run")(function* (
  directory: string,
  executable: string,
  args: readonly string[],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const process = yield* spawner.spawn(
    ChildProcess.make(executable, args, {
      cwd: directory,
      stdin: "ignore",
      stderr: "inherit",
      env: { GIT_TERMINAL_PROMPT: "0" },
      extendEnv: true,
    }),
  );
  const text = yield* Stream.mkString(Stream.decodeText(process.stdout));
  const exit = yield* process.exitCode;
  if (exit !== 0)
    return yield* new RefError({
      message: `${executable} ${args[0]} failed (exit ${String(exit)})`,
    });
  return text.trim();
}, Effect.scoped);

const checkout = Effect.fn("Project.checkout")(function* (directory: string) {
  const path = yield* Path.Path;
  const root = yield* run(directory, "git", ["rev-parse", "--show-toplevel"]);
  const common = yield* run(root, "git", [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const main = path.dirname(common);
  return { root, main, linked: root !== main, refs: path.join(main, "refs") };
});

export const version = Effect.fn("Project.version")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(root, "package.json");
  const manifest = yield* decode(
    Manifest,
    yield* fs.readFileString(file),
    file,
  );
  return yield* Schema.decodeUnknownEffect(Version)(
    manifest.dependencies?.effect ?? manifest.devDependencies?.effect,
  ).pipe(
    Effect.mapError(
      () =>
        new RefError({
          message: `${file}: effect must have an exact version pin`,
        }),
    ),
  );
});

const load = Effect.fn("Project.load")(function* (directory: string) {
  const project = yield* checkout(directory);
  return { ...project, version: yield* version(project.root) };
});

const verifyLink = Effect.fn("Project.verifyLink")(function* (project: {
  readonly root: string;
  readonly refs: string;
  readonly linked: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!project.linked) {
    if (
      (yield* fs.exists(project.refs)) &&
      (yield* fs.realPath(project.refs)) !== project.refs
    )
      return yield* new RefError({
        message: `${project.refs} must be a real directory in the main checkout`,
      });
    return;
  }
  const link = path.join(project.root, "refs");
  const target = yield* fs.readLink(link).pipe(
    Effect.mapError(
      () =>
        new RefError({
          message: `${link} must link to ${project.refs}; run refs init`,
        }),
    ),
  );
  if (path.resolve(project.root, target) !== project.refs)
    return yield* new RefError({
      message: `${link} points elsewhere; expected ${project.refs}`,
    });
});

export const init = Effect.fn("Project.init")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const project = yield* checkout(directory);
  yield* version(project.root);
  const ignore = path.join(project.root, ".gitignore");
  const before = (yield* fs.exists(ignore))
    ? yield* fs.readFileString(ignore)
    : "";
  const lines = before.split("\n");
  const after = lines.includes("/refs")
    ? before
    : lines.includes("/refs/")
      ? lines.map((line) => (line === "/refs/" ? "/refs" : line)).join("\n")
      : `${before}${before === "" || before.endsWith("\n") ? "" : "\n"}/refs\n`;
  if (after !== before) yield* fs.writeFileString(ignore, after);
  if (project.linked) {
    const link = path.join(project.root, "refs");
    const entries = yield* fs.readDirectory(project.root);
    if (!entries.includes("refs")) yield* fs.symlink(project.refs, link);
    yield* verifyLink(project);
  } else {
    yield* fs.makeDirectory(project.refs, { recursive: true });
    if ((yield* fs.realPath(project.refs)) !== project.refs)
      return yield* new RefError({
        message: `${project.refs} must be a real directory in the main checkout`,
      });
  }
  return `Initialized Effect references in ${project.root}`;
});

type Project = Effect.Success<ReturnType<typeof load>>;

const readSnapshot = Effect.fn("Project.readSnapshot")(function* (
  project: Project,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(project.refs, "effect", ".ref.json");
  if (!(yield* fs.exists(file))) return Option.none();
  return Option.some(
    yield* decode(Snapshot, yield* fs.readFileString(file), file),
  );
});

const describeSnapshot = (
  project: Project,
  snapshot: Effect.Success<ReturnType<typeof readSnapshot>>,
) =>
  Option.match(snapshot, {
    onNone: () => `effect: missing; want ${project.version}`,
    onSome: (snapshot) =>
      `effect: ${snapshot.version === project.version ? "ok" : "stale"}; have ${snapshot.version}, want ${project.version}; commit ${snapshot.commit}`,
  });

export const status = Effect.fn("Project.status")(function* (
  directory: string,
) {
  const project = yield* load(directory);
  yield* verifyLink(project);
  return describeSnapshot(project, yield* readSnapshot(project));
});

const requireCompatibleWorktrees = Effect.fn(
  "Project.requireCompatibleWorktrees",
)(function* (root: string, expected: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const output = yield* run(root, "git", [
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  yield* Effect.forEach(
    output.split("\0").filter((line) => line.startsWith("worktree ")),
    (line) =>
      Effect.gen(function* () {
        const directory = line.slice("worktree ".length);
        if (!(yield* fs.exists(path.join(directory, "package.json")))) return;
        const manifest = yield* decode(
          Manifest,
          yield* fs.readFileString(path.join(directory, "package.json")),
          "package.json",
        );
        if (
          manifest.dependencies?.effect === undefined &&
          manifest.devDependencies?.effect === undefined
        )
          return;
        const have = yield* version(directory);
        if (have !== expected)
          return yield* new RefError({
            message: `${directory} pins Effect ${have}; refusing to replace shared refs with ${expected}`,
          });
      }),
    { discard: true },
  );
});

const syncEffect = Effect.fn("Project.syncEffect")(function* (
  project: Project,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* requireCompatibleWorktrees(project.root, project.version);
  yield* fs.makeDirectory(project.refs, { recursive: true });
  const destination = path.join(project.refs, "effect");
  const snapshot = yield* readSnapshot(project);
  if (Option.isSome(snapshot)) {
    if (snapshot.value.version === project.version)
      return describeSnapshot(project, snapshot);
  } else if (yield* fs.exists(destination)) {
    return yield* new RefError({
      message: `${destination} is unmanaged; refusing to replace it`,
    });
  }
  const tag = `refs/tags/effect@${project.version}`;
  const commit = yield* run(project.root, "git", [
    "ls-remote",
    "https://github.com/Effect-TS/effect.git",
    tag,
    `${tag}^{}`,
  ]).pipe(
    Effect.flatMap((output) => {
      const lines = output.split("\n");
      const resolved =
        lines.find((line) => line.endsWith(`${tag}^{}`)) ??
        lines.find((line) => line.endsWith(`\t${tag}`));
      return decode(
        Commit,
        resolved?.split("\t")[0] ?? "",
        `upstream tag ${tag}`,
      );
    }),
  );
  yield* Effect.scoped(
    Effect.gen(function* () {
      const staging = yield* fs.makeTempDirectoryScoped({
        directory: project.refs,
        prefix: ".effect-",
      });
      const archive = path.join(staging, "source.tar.gz");
      const contents = path.join(staging, "contents");
      const backup = path.join(staging, "previous");
      yield* fs.makeDirectory(contents);
      yield* run(project.root, "curl", [
        "-fsSL",
        `https://codeload.github.com/Effect-TS/effect/tar.gz/${commit}`,
        "-o",
        archive,
      ]);
      yield* run(project.root, "tar", [
        "-xzf",
        archive,
        "-C",
        contents,
        "--strip-components=1",
      ]);
      yield* fs.writeFileString(
        path.join(contents, ".ref.json"),
        `${yield* Schema.encodeEffect(Snapshot)({
          repository: "Effect-TS/effect",
          version: project.version,
          commit,
          fetchedAt: DateTime.formatIso(yield* DateTime.now),
        })}\n`,
      );
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const previous = yield* fs.exists(destination);
          if (previous) yield* fs.rename(destination, backup);
          yield* fs
            .rename(contents, destination)
            .pipe(
              Effect.onError(() =>
                previous
                  ? fs.rename(backup, destination).pipe(Effect.orDie)
                  : Effect.void,
              ),
            );
        }),
      );
    }),
  );
  return describeSnapshot(project, yield* readSnapshot(project));
});

/** Serialize writers across worktrees sharing the same snapshot directory. */
export const sync = Effect.fn("Project.sync")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const project = yield* load(directory);
  yield* verifyLink(project);
  yield* fs.makeDirectory(project.refs, { recursive: true });
  const lock = path.join(project.refs, ".sync-lock");
  return yield* Effect.acquireUseRelease(
    fs.makeDirectory(lock).pipe(
      Effect.mapError(
        () =>
          new RefError({
            message: `Cannot acquire ${lock}; another sync may be running. If a previous process crashed, remove this directory before retrying.`,
          }),
      ),
    ),
    () => syncEffect(project),
    () => fs.remove(lock, { recursive: true }).pipe(Effect.orDie),
  );
});
