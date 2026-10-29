import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Argument from "effect/cli/Argument";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as Checkouts from "./checkouts.ts";
import * as Sources from "./sources.ts";

const options = {
  name: Argument.Literals("name", [
    "cloudflare-docs",
    "shopify-cli",
    "all",
  ]).pipe(Argument.withDefault("all")),
  directory: Flag.String("directory").pipe(
    Flag.withDescription(
      "Parent directory for reference checkouts; defaults to tools' parent directory",
    ),
    Flag.optional,
  ),
};

const handler =
  (operation: typeof Checkouts.status) =>
  (args: {
    readonly name: string;
    readonly directory: Option.Option<string>;
  }) =>
    runOperation(operation, args).pipe(
      Effect.mapError(
        (cause) =>
          new CliError.UserError({
            cause,
            userMessage: cause instanceof Error ? cause.message : String(cause),
          }),
      ),
    );

const runOperation = Effect.fn("References.run")(function* (
  operation: typeof Checkouts.status,
  args: { readonly name: string; readonly directory: Option.Option<string> },
) {
  const config = yield* Sources.load;
  const path = yield* Path.Path;
  const root = path.resolve(
    Option.getOrElse(args.directory, () => config.directory),
  );
  for (const source of config.sources.filter(
    (source) => args.name === "all" || source.name === args.name,
  )) {
    yield* Console.log(yield* operation(root, source));
  }
});

const references = Command.make("references").pipe(
  Command.withDescription("Set up and maintain shared reference sources."),
  Command.withSubcommands([
    Command.make("status", options, handler(Checkouts.status)).pipe(
      Command.withDescription(
        "Inspect local checkouts without network access; remote freshness is not checked.",
      ),
    ),
    Command.make("sync", options, handler(Checkouts.sync)).pipe(
      Command.withDescription(
        "Clone missing sources or update existing checkouts safely.",
      ),
    ),
  ]),
);

NodeRuntime.runMain(
  references.pipe(
    Command.run({ version: "0.1.0" }),
    Effect.provide(NodeServices.layer),
  ),
);
