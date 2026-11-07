import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
/**
 * The CLI. Each command prints one JSON document on stdout, `{ wt: 1, ... }`,
 * success or failure; human lines go to stderr. A typed failure exits 1, a
 * usage error 2. Version 1 only grows.
 *
 * @module
 */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Worktree from "./worktree.ts";

const printJson = (value: unknown) =>
  Console.log(JSON.stringify({ wt: 1, ...(value as object) }, null, 2));

const run = <
  A,
  E extends { readonly _tag: string; readonly message: string },
  R,
>(
  body: Effect.Effect<A, E, R>,
  print: (value: A) => Effect.Effect<void>,
) =>
  body.pipe(
    Effect.matchEffect({
      onSuccess: print,
      onFailure: (error) =>
        Effect.gen(function* () {
          yield* printJson({
            error: {
              ...Object.fromEntries(Object.entries(error)),
              _tag: error._tag,
              message: error.message,
            },
          });
          yield* Console.error(`wt: ${error.message}`);
          yield* Effect.sync(() => {
            process.exitCode = 1;
          });
        }),
    }),
  );

const branchJson = (branch: Option.Option<string>) => Option.getOrNull(branch);

const create = Command.make(
  "new",
  {
    words: Argument.String("name").pipe(
      Argument.atLeast(1),
      Argument.withDescription(
        "The worktree's name, as words: pr 123 plan labels gives pr-123-plan-labels",
      ),
    ),
    from: Flag.String("from").pipe(
      Flag.optional,
      Flag.withDescription(
        "The branch, tag or commit to start from; default origin's default branch",
      ),
    ),
    exact: Flag.Boolean("exact").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Fail when the name is taken instead of adding -2, -3, ...",
      ),
    ),
  },
  ({ words, from, exact }) =>
    run(Worktree.create(".", words, { from, exact }), (created) =>
      printJson({
        ...created,
        t3_thread_launch: {
          workspaceStrategy: {
            type: "existing_worktree",
            worktreePath: created.path,
          },
        },
      }),
    ),
).pipe(
  Command.withShortDescription(
    "Make a worktree and branch for a task, with shared files and installed packages",
  ),
  Command.withExamples([
    {
      command: "wt new fix plan labels",
      description: "~/.t3/worktrees/<repo>/fix-plan-labels on a new branch",
    },
    {
      command: "wt new pr 123 --from origin/feature",
      description: "Start from another branch",
    },
  ]),
);

const remove = Command.make(
  "rm",
  {
    target: Argument.String("worktree").pipe(
      Argument.optional,
      Argument.withDescription(
        "A path, directory name or branch; default the worktree you are in",
      ),
    ),
    force: Flag.Boolean("force").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Remove a branch whose work has not landed; uncommitted changes still refuse",
      ),
    ),
  },
  ({ target, force }) =>
    run(Worktree.remove(".", target, { force }), (removed) =>
      printJson({ ...removed, branch: branchJson(removed.branch) }),
    ),
).pipe(
  Command.withShortDescription(
    "Remove a worktree and its branch once its work has landed",
  ),
);

const init = Command.make(
  "init",
  {
    target: Argument.String("worktree").pipe(
      Argument.optional,
      Argument.withDescription(
        "A path, directory name or branch; default the worktree you are in",
      ),
    ),
  },
  ({ target }) =>
    run(Worktree.init(".", target), (initialized) => printJson(initialized)),
).pipe(
  Command.withShortDescription(
    "Share again: link the main checkout's untracked .env, .env.* and refs at any depth",
  ),
);

const toTable = (rows: readonly (readonly string[])[]): string => {
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => row[column].length)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
};

const list = Command.make(
  "list",
  {
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("Print JSON instead of a table"),
      Flag.withDefault(false),
    ),
  },
  ({ json }) =>
    run(Worktree.list("."), (worktrees) =>
      json
        ? printJson({
            worktrees: worktrees.map((worktree) => ({
              ...worktree,
              branch: branchJson(worktree.branch),
            })),
          })
        : Console.log(
            toTable([
              ["PATH", "BRANCH", "STATE"],
              ...worktrees.map((worktree) => [
                worktree.path,
                Option.getOrElse(worktree.branch, () => "(detached)"),
                [worktree.main ? "main" : "", worktree.dirty ? "dirty" : ""]
                  .filter((word) => word.length > 0)
                  .join(" "),
              ]),
            ]),
          ),
    ),
).pipe(Command.withShortDescription("List this repository's worktrees"));

export const command = Command.make("wt").pipe(
  Command.withDescription(
    "Make and remove git worktrees for tasks, in any repository.",
  ),
  Command.withSubcommands([create, init, remove, list]),
);
