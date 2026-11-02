/**
 * The herdr workspace a removed worktree leaves behind. herdr opens one per
 * checkout and keeps it after the directory is gone, so `wt rm` closes it,
 * unless a pane still runs something: closing ends every pane's processes,
 * and wt never ends work it did not start. Without a running herdr there is
 * nothing to close.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { run } from "./process.ts";

const reply = <S extends Schema.Top>(result: S) =>
  Schema.fromJsonString(Schema.Struct({ result }));

const WorkspaceList = reply(
  Schema.Struct({
    workspaces: Schema.Array(
      Schema.Struct({
        workspace_id: Schema.String,
        worktree: Schema.optional(
          Schema.Struct({ checkout_path: Schema.String }),
        ),
      }),
    ),
  }),
);

const PaneList = reply(
  Schema.Struct({
    panes: Schema.Array(Schema.Struct({ pane_id: Schema.String })),
  }),
);

/**
 * herdr leaves out `foreground_process_group_id` until the shell owns its
 * terminal, and `shell_pid` before the shell exists.
 */
const ProcessInfo = reply(
  Schema.Struct({
    process_info: Schema.Struct({
      shell_pid: Schema.optional(Schema.Number),
      foreground_process_group_id: Schema.optional(Schema.Number),
      foreground_processes: Schema.Array(
        Schema.Struct({
          pid: Schema.Number,
          argv: Schema.Array(Schema.String),
        }),
      ),
    }),
  }),
);

const herdr = <S extends Schema.Top & { readonly DecodingServices: never }>(
  directory: string,
  args: ReadonlyArray<string>,
  schema: S,
) =>
  run(directory, "herdr", args).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
  );

/**
 * What a pane runs in front of its shell, or none when it sits at its
 * prompt. A shell still starting counts as busy.
 */
const busyWith = (directory: string, paneId: string) =>
  herdr(
    directory,
    ["pane", "process-info", "--pane", paneId],
    ProcessInfo,
  ).pipe(
    Effect.map(({ result: { process_info: info } }) =>
      info.shell_pid !== undefined &&
      info.foreground_process_group_id === info.shell_pid
        ? Option.none<string>()
        : Option.some(
            info.foreground_processes
              .find((process) => process.pid !== info.shell_pid)
              ?.argv.join(" ") ?? "a shell still starting",
          ),
    ),
  );

/**
 * Closes the herdr workspaces open on `checkout` whose panes are all idle,
 * and says what it did; none when herdr has none open there or is not
 * running. `directory` is where herdr runs, an existing directory.
 */
export const closeWorkspaces = Effect.fn("Herdr.closeWorkspaces")(function* (
  directory: string,
  checkout: string,
) {
  const listed = yield* herdr(
    directory,
    ["workspace", "list"],
    WorkspaceList,
  ).pipe(Effect.option);
  if (Option.isNone(listed)) return [];
  const open = listed.value.result.workspaces.filter(
    (workspace) => workspace.worktree?.checkout_path === checkout,
  );
  return yield* Effect.forEach(open, ({ workspace_id: id }) =>
    Effect.gen(function* () {
      const { panes } = (yield* herdr(
        directory,
        ["pane", "list", "--workspace", id],
        PaneList,
      )).result;
      for (const pane of panes) {
        const busy = yield* busyWith(directory, pane.pane_id);
        if (Option.isSome(busy))
          return `left herdr workspace ${id} open: pane ${pane.pane_id} runs ${busy.value}`;
      }
      yield* run(directory, "herdr", ["workspace", "close", id]);
      return `closed herdr workspace ${id}`;
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(`left herdr workspace ${id} open: ${error.message}`),
      ),
    ),
  );
});
