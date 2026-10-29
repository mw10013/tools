import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export interface Source {
  readonly name: string;
  readonly repository: string;
  readonly target: string;
  readonly kind: "branch" | "tag";
}

const Configuration = Schema.fromJsonString(
  Schema.Struct({
    shopifyCliVersion: Schema.String.check(
      Schema.isPattern(/^\d+\.\d+\.\d+$/u),
    ),
  }),
);

export const load = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const modulePath = yield* path.fromFileUrl(new URL(import.meta.url));
  const root = path.resolve(path.dirname(modulePath), "../..");
  const config = yield* Schema.decodeEffect(Configuration)(
    yield* fs.readFileString(path.join(root, "references.json")),
  );
  const sources: readonly Source[] = [
    {
      name: "cloudflare-docs",
      repository: "https://github.com/cloudflare/cloudflare-docs.git",
      target: "production",
      kind: "branch",
    },
    {
      name: "shopify-cli",
      repository: "https://github.com/Shopify/cli.git",
      target: config.shopifyCliVersion,
      kind: "tag",
    },
  ];
  return { sources, directory: path.dirname(root) };
});
