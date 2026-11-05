import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Yaml from "effect/encoding/Yaml";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as Process from "./process.ts";

class RefError extends Schema.TaggedError<RefError>()("RefError", {
  message: Schema.String,
}) {}

export const sources = {
  astryx: {
    repository: "meta/astryx",
    dependency: "@astryxdesign/core",
    tag: "v",
  },
  effect: {
    repository: "Effect-TS/effect",
    dependency: "effect",
    tag: "effect@",
  },
  "tanstack-start": {
    repository: "TanStack/router",
    dependency: "@tanstack/react-start",
    tag: "@tanstack/react-start@",
  },
  "tanstack-form": {
    repository: "TanStack/form",
    dependency: "@tanstack/react-form",
    tag: "@tanstack/react-form@",
  },
  "better-auth": {
    repository: "better-auth/better-auth",
    dependency: "better-auth",
    tag: "v",
  },
  playwright: {
    repository: "microsoft/playwright",
    dependency: "@playwright/test",
    tag: "v",
  },
  alchemy: {
    repository: "alchemy-run/alchemy",
    dependency: "alchemy",
    tag: "v",
  },
  "shopify-app-js": {
    repository: "Shopify/shopify-app-js",
    dependency: "@shopify/shopify-api",
    tag: "@shopify/shopify-api@",
  },
  graphql: {
    repository: "graphql/graphql-js",
    dependency: "graphql",
    tag: "v",
  },
  "graphql-yoga": {
    repository: "graphql-hive/graphql-yoga",
    dependency: "graphql-yoga",
    tag: "graphql-yoga@",
  },
  stylex: {
    repository: "meta/stylex",
    dependency: "@stylexjs/stylex",
    tag: "",
  },
} as const;
export type Reference = keyof typeof sources;

const WorkspaceCatalogs = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  catalogs: Schema.optional(
    Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
  ),
});

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
const declaredDependency = (
  manifest: typeof Manifest.Type,
  reference: Reference,
) => {
  const dependencies =
    reference === "playwright"
      ? ["@playwright/test", "playwright"]
      : [sources[reference].dependency];
  return dependencies.find(
    (dependency) =>
      manifest.dependencies?.[dependency] !== undefined ||
      manifest.devDependencies?.[dependency] !== undefined,
  );
};

const Snapshot = Schema.fromJsonString(
  Schema.Struct({
    repository: Schema.String,
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

const checkout = Effect.fn("Project.checkout")(function* (directory: string) {
  const path = yield* Path.Path;
  const root = yield* Process.run(directory, "git", [
    "rev-parse",
    "--show-toplevel",
  ]);
  const common = yield* Process.run(root, "git", [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const main = path.dirname(common);
  return { root, main, linked: root !== main, refs: path.join(main, "refs") };
});

export const version = Effect.fn("Project.version")(function* (
  root: string,
  reference: Reference = "effect",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(root, "package.json");
  const manifest = yield* decode(
    Manifest,
    yield* fs.readFileString(file),
    file,
  );
  const dependency =
    declaredDependency(manifest, reference) ?? sources[reference].dependency;
  let pin =
    manifest.dependencies?.[dependency] ??
    manifest.devDependencies?.[dependency];
  if (pin === undefined)
    return yield* new RefError({
      message: `${file}: ${dependency} is not declared`,
    });
  if (pin.startsWith("catalog:")) {
    let current = root;
    while (!(yield* fs.exists(path.join(current, "pnpm-workspace.yaml")))) {
      const parent = path.dirname(current);
      if (parent === current)
        return yield* new RefError({
          message: `${dependency}: no pnpm-workspace.yaml found for ${pin}`,
        });
      current = parent;
    }
    const workspaceFile = path.join(current, "pnpm-workspace.yaml");
    const yaml = yield* fs.readFileString(workspaceFile);
    const workspace = yield* Effect.try({
      try: () => Yaml.parse(yaml),
      catch: () => new RefError({ message: `Invalid ${workspaceFile}` }),
    }).pipe(
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(WorkspaceCatalogs)(value),
      ),
      Effect.mapError(
        () => new RefError({ message: `Invalid ${workspaceFile}` }),
      ),
    );
    const catalog = pin.slice("catalog:".length);
    pin = (
      catalog === ""
        ? (workspace.catalog ?? workspace.catalogs?.default)
        : workspace.catalogs?.[catalog]
    )?.[dependency];
  }
  return yield* Schema.decodeUnknownEffect(Version)(pin).pipe(
    Effect.mapError(
      () =>
        new RefError({
          message: `${file}: ${dependency} must have an exact version pin`,
        }),
    ),
  );
});

const load = Effect.fn("Project.load")(function* (
  directory: string,
  reference: Reference,
) {
  const project = yield* checkout(directory);
  return {
    ...project,
    reference,
    ...sources[reference],
    version: yield* version(project.root, reference),
  };
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
  yield* fs.makeDirectory(project.refs, { recursive: true });
  if ((yield* fs.realPath(project.refs)) !== project.refs)
    return yield* new RefError({
      message: `${project.refs} must be a real directory in the main checkout`,
    });
  if (project.linked) {
    const link = path.join(project.root, "refs");
    const entries = yield* fs.readDirectory(project.root);
    if (!entries.includes("refs")) yield* fs.symlink(project.refs, link);
    yield* verifyLink(project);
  }
  return `Initialized project references in ${project.root}`;
});

type Project = Effect.Success<ReturnType<typeof load>>;

const readSnapshot = Effect.fn("Project.readSnapshot")(function* (
  project: Project,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(project.refs, project.reference, ".ref.json");
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
    onNone: () => `${project.reference}: missing; want ${project.version}`,
    onSome: (snapshot) =>
      `${project.reference}: ${snapshot.repository === project.repository && snapshot.version === project.version ? "ok" : "stale"}; have ${snapshot.version}, want ${project.version}; commit ${snapshot.commit}`,
  });

export const status = Effect.fn("Project.status")(function* (
  directory: string,
  reference: Reference = "effect",
) {
  const project = yield* load(directory, reference);
  return describeSnapshot(project, yield* readSnapshot(project));
});

const requireCompatibleWorktrees = Effect.fn(
  "Project.requireCompatibleWorktrees",
)(function* (root: string, expected: string, reference: Reference) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const output = yield* Process.run(root, "git", [
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
        if (declaredDependency(manifest, reference) === undefined) return;
        const have = yield* version(directory, reference);
        if (have !== expected)
          return yield* new RefError({
            message: `${directory} pins ${reference} ${have}; refusing to replace shared refs with ${expected}`,
          });
      }),
    { discard: true },
  );
});

const syncReference = Effect.fn("Project.syncReference")(function* (
  project: Project,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* requireCompatibleWorktrees(
    project.root,
    project.version,
    project.reference,
  );
  yield* fs.makeDirectory(project.refs, { recursive: true });
  const destination = path.join(project.refs, project.reference);
  const snapshot = yield* readSnapshot(project);
  if (Option.isSome(snapshot)) {
    if (
      snapshot.value.repository === project.repository &&
      snapshot.value.version === project.version
    )
      return describeSnapshot(project, snapshot);
  } else if (yield* fs.exists(destination)) {
    return yield* new RefError({
      message: `${destination} is unmanaged; refusing to replace it`,
    });
  }
  const tag = `refs/tags/${project.tag}${project.version}`;
  const commit = yield* Process.run(project.root, "git", [
    "ls-remote",
    `https://github.com/${project.repository}.git`,
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
        prefix: `.${project.reference}-`,
      });
      const archive = path.join(staging, "source.tar.gz");
      const contents = path.join(staging, "contents");
      const backup = path.join(staging, "previous");
      yield* fs.makeDirectory(contents);
      yield* Process.run(project.root, "curl", [
        "-fsSL",
        `https://codeload.github.com/${project.repository}/tar.gz/${commit}`,
        "-o",
        archive,
      ]);
      yield* Process.run(project.root, "tar", [
        "-xzf",
        archive,
        "-C",
        contents,
        "--strip-components=1",
      ]);
      yield* fs.writeFileString(
        path.join(contents, ".ref.json"),
        `${yield* Schema.encodeEffect(Snapshot)({
          repository: project.repository,
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
export const sync = Effect.fn("Project.sync")(function* (
  directory: string,
  reference: Reference = "effect",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const project = yield* load(directory, reference);
  yield* init(directory);
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
    () => syncReference(project),
    () => fs.remove(lock, { recursive: true }).pipe(Effect.orDie),
  );
});

const matching = Effect.fn("Project.matching")(function* (directory: string) {
  const project = yield* checkout(directory);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(project.root, "package.json");
  const manifest = yield* decode(
    Manifest,
    yield* fs.readFileString(file),
    file,
  );
  return (Object.keys(sources) as Reference[]).filter(
    (reference) => declaredDependency(manifest, reference) !== undefined,
  );
});

export const statusAll = Effect.fn("Project.statusAll")(function* (
  directory: string,
) {
  const references = yield* matching(directory);
  if (references.length === 0)
    return "No supported project dependencies declared";
  return (yield* Effect.forEach(references, (reference) =>
    status(directory, reference),
  )).join("\n");
});

export const syncAll = Effect.fn("Project.syncAll")(function* (
  directory: string,
) {
  const references = yield* matching(directory);
  // Validate all declared pins before downloading any dependency.
  const project = yield* checkout(directory);
  yield* Effect.forEach(
    references,
    (reference) => version(project.root, reference),
    { discard: true },
  );
  yield* init(directory);
  if (references.length === 0)
    return "No supported project dependencies declared; refs initialized";
  return (yield* Effect.forEach(references, (reference) =>
    sync(directory, reference),
  )).join("\n");
});
