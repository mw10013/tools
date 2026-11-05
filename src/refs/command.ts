import * as Argument from "effect/cli/Argument";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";

import * as Project from "./project.ts";
import * as Shared from "./shared.ts";

const root = Command.make("refs").pipe(
  Command.withDescription("Manage project and shared reference sources"),
  Command.withSharedFlags({
    directory: Flag.String("directory").pipe(
      Flag.withDescription(
        "Parent directory for shared sources; defaults to tools' parent directory",
      ),
      Flag.optional,
    ),
    project: Flag.Directory("project", { mustExist: true }).pipe(
      Flag.withAlias("p"),
      Flag.withDescription(
        "Project directory; defaults to the current directory",
      ),
      Flag.withDefault("."),
    ),
  }),
);

/** Translate operation failures at the CLI boundary; Effect renders usage errors itself. */
const userError = Effect.mapError(
  (cause: { readonly message: string }) =>
    new CliError.UserError({ cause, userMessage: cause.message }),
);

const init = Command.make(
  "init",
  {},
  Effect.fn("Refs.init")(function* () {
    const { project } = yield* root;
    yield* Project.init(project).pipe(Effect.flatMap(Console.log), userError);
  }),
).pipe(
  Command.withShortDescription("Prepare the refs directory or worktree link"),
  Command.withDescription(
    "Prepare /refs in .gitignore and create the refs directory or worktree symlink. Does not download source or edit AGENTS.md.",
  ),
  Command.withExamples([
    {
      command: "vpx ./refs.ts init",
      description: "Initialize this checkout; safe to repeat",
    },
  ]),
);

const source = {
  reference: Argument.Literals("reference", [
    "astryx",
    "effect",
    "cloudflare-docs",
    "cloudflare-cli",
    "chrome-devtools",
    "t3code",
    "shopify-cli",
    "shopify-docs",
    "m4l-docs",
    "vite-plus",
    "vite",
    "vitest",
    "tanstack-start",
    "tanstack-form",
    "better-auth",
    "alchemy",
    "playwright",
    "shopify-app-js",
    "graphql",
    "graphql-yoga",
    "stylex",
  ]).pipe(
    Argument.withDescription(
      "Reference to inspect or download; omitted selects all declared project dependencies",
    ),
    Argument.optional,
  ),
};
const status = Command.make(
  "status",
  source,
  Effect.fn("Refs.status")(function* ({ reference }) {
    const { project, directory } = yield* root;
    const sharedDirectory = Option.match(directory, {
      onNone: () => Shared.directory,
      onSome: Effect.succeed,
    });
    yield* Match.value(
      Option.getOrElse(reference, () => "project" as const),
    ).pipe(
      Match.when("project", () => Project.statusAll(project)),
      Match.when(
        Match.is(
          "astryx",
          "effect",
          "tanstack-start",
          "tanstack-form",
          "better-auth",
          "alchemy",
          "playwright",
          "shopify-app-js",
          "graphql",
          "graphql-yoga",
          "stylex",
        ),
        (reference) => Project.status(project, reference),
      ),
      Match.when(Match.is("vite-plus", "vite", "vitest"), (tool) =>
        sharedDirectory.pipe(
          Effect.flatMap((directory) =>
            Shared.toolchainStatus(directory, tool),
          ),
        ),
      ),
      Match.when("cloudflare-docs", () =>
        sharedDirectory.pipe(Effect.flatMap(Shared.cloudflareStatus)),
      ),
      Match.when("cloudflare-cli", () =>
        sharedDirectory.pipe(Effect.flatMap(Shared.cloudflareCliStatus)),
      ),
      Match.when("chrome-devtools", () =>
        sharedDirectory.pipe(Effect.flatMap(Shared.chromeDevtoolsStatus)),
      ),
      Match.when("t3code", () =>
        sharedDirectory.pipe(Effect.flatMap(Shared.t3Status)),
      ),
      Match.when("shopify-cli", () =>
        sharedDirectory.pipe(Effect.flatMap(Shared.shopifyStatus)),
      ),
      Match.when("shopify-docs", () =>
        sharedDirectory.pipe(Effect.flatMap(Shared.shopifyDocsStatus)),
      ),
      Match.when("m4l-docs", () =>
        sharedDirectory.pipe(Effect.flatMap(Shared.m4lDocsStatus)),
      ),
      Match.exhaustive,
      Effect.flatMap(Console.log),
      userError,
    );
  }),
).pipe(
  Command.withShortDescription("Inspect local reference sources"),
  Command.withDescription(
    "Without a reference name, inspect all supported dependencies declared in the project. This is read-only and needs no initialization or network access. Project references are compared with their dependency pins; Shared references report directory presence. Remote freshness is not checked.",
  ),
  Command.withExamples([
    {
      command: "vpx ./refs.ts status effect",
      description: "Inspect the project Effect snapshot",
    },
  ]),
);

const sync = Command.make(
  "sync",
  source,
  Effect.fn("Refs.sync")(function* ({ reference }) {
    const { project, directory } = yield* root;
    const sharedDirectory = Option.match(directory, {
      onNone: () => Shared.directory,
      onSome: Effect.succeed,
    });
    yield* Match.value(
      Option.getOrElse(reference, () => "project" as const),
    ).pipe(
      Match.when("project", () => Project.syncAll(project)),
      Match.when(
        Match.is(
          "astryx",
          "effect",
          "tanstack-start",
          "tanstack-form",
          "better-auth",
          "alchemy",
          "playwright",
          "shopify-app-js",
          "graphql",
          "graphql-yoga",
          "stylex",
        ),
        (reference) => Project.sync(project, reference),
      ),
      Match.when(Match.is("vite-plus", "vite", "vitest"), (tool) =>
        sharedDirectory.pipe(
          Effect.flatMap((directory) => Shared.toolchainSync(directory, tool)),
        ),
      ),
      Match.when("cloudflare-docs", () =>
        sharedDirectory.pipe(Effect.flatMap(Shared.cloudflareSync)),
      ),
      Match.when("cloudflare-cli", () =>
        sharedDirectory.pipe(Effect.flatMap(Shared.cloudflareCliSync)),
      ),
      Match.when("chrome-devtools", () =>
        sharedDirectory.pipe(Effect.flatMap(Shared.chromeDevtoolsSync)),
      ),
      Match.when("t3code", () =>
        sharedDirectory.pipe(Effect.flatMap(Shared.t3Sync)),
      ),
      Match.when("shopify-cli", () =>
        sharedDirectory.pipe(Effect.flatMap(Shared.shopifySync)),
      ),
      Match.when("shopify-docs", () =>
        sharedDirectory.pipe(Effect.flatMap(Shared.shopifyDocsSync)),
      ),
      Match.when("m4l-docs", () =>
        sharedDirectory.pipe(Effect.flatMap(Shared.m4lDocsSync)),
      ),
      Match.exhaustive,
      Effect.flatMap(Console.log),
      userError,
    );
  }),
).pipe(
  Command.withShortDescription("Download or synchronize reference sources"),
  Command.withDescription(
    "Without a reference name, initialize refs and sync all supported dependencies declared in the project. Named project sync also initializes refs automatically. Unchanged pins reuse existing snapshots. Astryx, Effect, TanStack Start/Form, Better Auth, Alchemy, Playwright, Shopify App JS, GraphQL.js, GraphQL Yoga, and StyleX follow project dependency pins. Vite+, Vite, and Vitest follow the global Vite+ toolchain. Cloudflare docs downloads a fresh production archive to the shared directory on every sync. Cloudflare CLI, Chrome DevTools, Shopify CLI, and T3 Code follow their installed versions. T3 Code reads the macOS nightly app version. Shopify docs refreshes latest developer docs and the Flow manual with local images and Polaris runtime code. M4L docs refreshes the Max for Live guide, Live Object Model, and v8 and Node for Max APIs with local images.",
  ),
  Command.withExamples([
    {
      command: "vpx ./refs.ts sync",
      description: "Set up refs and sync every supported project dependency",
    },
    {
      command: "vpx ./refs.ts sync effect",
      description: "Download the pinned release, or reuse a matching snapshot",
    },
    {
      command: "vpx ./refs.ts sync cloudflare-docs",
      description: "Replace shared docs with a fresh production snapshot",
    },
    {
      command: "vpx ./refs.ts sync shopify-cli",
      description: "Download source matching the installed Shopify CLI",
    },
    {
      command: "vpx ./refs.ts sync shopify-docs",
      description:
        "Refresh developer docs, Flow manual, images, and Polaris code",
    },
    {
      command: "vpx ./refs.ts sync vite-plus",
      description:
        "Download source matching global Vite+; vite and vitest use its bundled versions",
    },
    {
      command: "vpx ./refs.ts -p /path/to/project sync tanstack-start",
      description: "Download source matching the project's TanStack Start pin",
    },
  ]),
);

export const command = root.pipe(
  Command.withSubcommands([init, status, sync]),
  Command.withExamples([
    {
      command: "vpx ./refs.ts init",
      description: "Prepare this project's reference folder",
    },
    {
      command: "vpx ./refs.ts sync effect",
      description: "Fetch source matching the project's Effect pin",
    },
    {
      command: "vpx ./refs.ts status",
      description: "Check the local snapshot without fetching",
    },
    {
      command: "vpx /path/to/tools/refs.ts -p /path/to/project init",
      description: "Prepare another project",
    },
  ]),
);
