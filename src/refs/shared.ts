import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Process from "./process.ts";
import * as ShopifyDocs from "./shopify-docs.ts";

class SharedRefError extends Schema.TaggedError<SharedRefError>()(
  "SharedRefError",
  {
    message: Schema.String,
  },
) {}

/** Shared sources live beside tools, independent of the current project. */
export const directory = Effect.gen(function* () {
  const path = yield* Path.Path;
  const file = yield* path.fromFileUrl(new URL(import.meta.url));
  return path.resolve(path.dirname(file), "../../..");
});

/** Stage archives before replacing disposable reading copies. */
const replace = Effect.fn("Shared.replace")(function* <A, E, R>(
  root: string,
  name: string,
  fill: (contents: string) => Effect.Effect<A, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(root, { recursive: true });
  const destination = path.join(yield* fs.realPath(root), name);
  if ((yield* fs.readDirectory(path.dirname(destination))).includes(name)) {
    if (Option.isSome(yield* fs.readLink(destination).pipe(Effect.option)))
      return yield* new SharedRefError({
        message: `${destination} is a symlink; refusing to replace it`,
      });
    if ((yield* fs.stat(destination)).type !== "Directory")
      return yield* new SharedRefError({
        message: `${destination} is not a directory; refusing to replace it`,
      });
    if ((yield* fs.readDirectory(destination)).includes(".git"))
      return yield* new SharedRefError({
        message: `${destination} is a Git checkout; refusing to replace it`,
      });
  }
  const staging = yield* fs.makeTempDirectoryScoped({
    directory: root,
    prefix: `.${name}-`,
  });
  const contents = path.join(staging, "contents");
  const previous = path.join(staging, "previous");
  yield* fs.makeDirectory(contents);
  yield* fill(contents);
  yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const exists = yield* fs.exists(destination);
      if (exists) yield* fs.rename(destination, previous);
      yield* fs
        .rename(contents, destination)
        .pipe(
          Effect.onError(() =>
            exists
              ? fs.rename(previous, destination).pipe(Effect.orDie)
              : Effect.void,
          ),
        );
    }),
  );
  return destination;
}, Effect.scoped);

const download = (root: string, name: string, url: string) =>
  replace(
    root,
    name,
    Effect.fn("Shared.download")(function* (contents: string) {
      const fs = yield* FileSystem.FileSystem;
      const archive = yield* fs.makeTempFileScoped();
      yield* Process.run(root, "curl", ["-fsSL", url, "-o", archive]);
      yield* Process.run(root, "tar", [
        "-xzf",
        archive,
        "-C",
        contents,
        "--strip-components=1",
      ]);
    }),
  );

export const shopifyDocsStatus = (root: string) =>
  presence(root, "shopify-docs");
export const shopifyDocsSync = (root: string) =>
  replace(root, "shopify-docs", ShopifyDocs.downloadInto).pipe(
    Effect.map(
      (destination) =>
        `shopify-docs: downloaded latest developer docs and Flow manual (${destination})`,
    ),
  );

const presence = Effect.fn("Shared.presence")(function* (
  root: string,
  name: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const destination = path.join(path.resolve(root), name);
  return `${name}: ${(yield* fs.exists(destination)) ? "present" : "missing"} (${destination})`;
});

export const cloudflareStatus = (root: string) =>
  presence(root, "cloudflare-docs");

export const cloudflareCliStatus = (root: string) =>
  presence(root, "cloudflare-cli");

export const cloudflareCliSync = Effect.fn("Shared.cloudflareCliSync")(
  function* (root: string) {
    const output = yield* Process.run(".", "cf", ["--version"]).pipe(
      Effect.mapError(
        () =>
          new SharedRefError({
            message: "Cannot read the installed CF version",
          }),
      ),
    );
    const version = yield* Schema.decodeUnknownEffect(
      Schema.String.check(
        Schema.isPattern(
          /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
        ),
      ),
    )(output).pipe(
      Effect.mapError(
        () =>
          new SharedRefError({
            message: "Could not parse the version reported by `cf --version`",
          }),
      ),
    );
    const destination = yield* download(
      root,
      "cloudflare-cli",
      `https://codeload.github.com/cloudflare/cf/tar.gz/refs/tags/cf@${version}`,
    );
    return `cloudflare-cli: downloaded ${version} (${destination})`;
  },
);

export const cloudflareSync = Effect.fn("Shared.cloudflareSync")(function* (
  root: string,
) {
  const destination = yield* download(
    root,
    "cloudflare-docs",
    "https://codeload.github.com/cloudflare/cloudflare-docs/tar.gz/refs/heads/production",
  );
  return `cloudflare-docs: downloaded production (${destination})`;
});

export const shopifyStatus = (root: string) => presence(root, "shopify-cli");

export const shopifySync = Effect.fn("Shared.shopifySync")(function* (
  root: string,
) {
  const output = yield* Process.run(".", "shopify", ["version"]).pipe(
    Effect.mapError(
      () =>
        new SharedRefError({
          message:
            "Cannot read the installed Shopify CLI version; ensure `shopify version` works on your PATH",
        }),
    ),
  );
  const version = yield* Schema.decodeUnknownEffect(
    Schema.String.check(
      Schema.isPattern(
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
      ),
    ),
  )(output).pipe(
    Effect.mapError(
      () =>
        new SharedRefError({
          message: "Could not parse the version reported by `shopify version`",
        }),
    ),
  );
  const destination = yield* download(
    root,
    "shopify-cli",
    `https://codeload.github.com/Shopify/cli/tar.gz/refs/tags/${version}`,
  );
  return `shopify-cli: downloaded ${version} (${destination})`;
});

const Toolchain = Schema.fromJsonString(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    source: Schema.Struct({
      scope: Schema.Literal("global"),
      vitePlusVersion: Schema.String,
    }),
    nodes: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        version: Schema.optional(Schema.String),
      }),
    ),
  }),
);
const TOOLCHAIN_REPOSITORIES = {
  "vite-plus": "voidzero-dev/vite-plus",
  vite: "vitejs/vite",
  vitest: "vitest-dev/vitest",
} as const;
export type Tool = keyof typeof TOOLCHAIN_REPOSITORIES;

export const toolchainStatus = (root: string, tool: Tool) =>
  presence(root, tool);

export const toolchainSync = Effect.fn("Shared.toolchainSync")(function* (
  root: string,
  tool: Tool,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // vpx prepends project binaries; locate vp outside node_modules to reach the global CLI.
  const entries = (yield* Config.String("PATH")).split(
    path.sep === "\\" ? ";" : ":",
  );
  const candidates = yield* Effect.filter(entries, (entry) =>
    entry.split(/[\\/]/u).includes("node_modules")
      ? Effect.succeed(false)
      : fs.exists(path.join(entry, path.sep === "\\" ? "vp.exe" : "vp")),
  );
  const entry = candidates[0];
  if (entry === undefined)
    return yield* new SharedRefError({
      message: "Global vp CLI was not found on PATH",
    });
  const executable = path.join(entry, path.sep === "\\" ? "vp.exe" : "vp");
  const output = yield* Process.run(".", executable, [
    "toolchain",
    "--global",
    "--json",
  ]);
  const toolchain = yield* Schema.decodeUnknownEffect(Toolchain)(output).pipe(
    Effect.mapError(
      () =>
        new SharedRefError({
          message: "Cannot decode `vp toolchain --global --json`",
        }),
    ),
  );
  const candidate =
    tool === "vite-plus"
      ? toolchain.source.vitePlusVersion
      : toolchain.nodes.find((node) => node.id === tool)?.version;
  const version = yield* Schema.decodeUnknownEffect(
    Schema.String.check(
      Schema.isPattern(
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
      ),
    ),
  )(candidate).pipe(
    Effect.mapError(
      () =>
        new SharedRefError({
          message: `Global Vite+ did not report a release version for ${tool}`,
        }),
    ),
  );
  const destination = yield* download(
    root,
    tool,
    `https://codeload.github.com/${TOOLCHAIN_REPOSITORIES[tool]}/tar.gz/refs/tags/v${version}`,
  );
  return `${tool}: downloaded ${version} from global Vite+ toolchain (${destination})`;
});
