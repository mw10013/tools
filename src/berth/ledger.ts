/**
 * The machine-wide ledger: berth's one piece of persistent state, safe under
 * concurrent writers and crashes, with no lock to go stale.
 *
 * Each committed {@link State} is an immutable `g-<n>.json` in the ledger
 * directory, and the highest `n` is current. A write goes to a synced temp
 * file and commits with `link(temp, g-<n+1>)`, which fails with AlreadyExists
 * when another writer won; the loser re-reads and re-runs its transition. A
 * crash before the link changes nothing, and a crash after it has committed a
 * whole file. `link` behaves this way on APFS, ext4 and NTFS.
 *
 * @module
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";

import { checkState, EMPTY_STATE, type Policy, State } from "./domain.ts";

/** Committed generations kept on disk after a write. */
const KEPT_GENERATIONS = 10;
/** Lost compare-and-swaps retried before {@link LedgerContendedError}. */
const COMMIT_ATTEMPTS = 50;
/** A temp file older than this is a crashed writer's debris. */
const TEMP_FILE_LIFETIME = Duration.minutes(1);

const GENERATION = /^g-(\d+)\.json$/u;
const StateJson = Schema.fromJsonString(State);

/** Every retry lost the race: something is writing the ledger in a loop. */
export class LedgerContendedError extends Schema.TaggedError<LedgerContendedError>()(
  "LedgerContendedError",
  { attempts: Schema.Int },
) {
  override get message() {
    return `the ledger changed under every one of ${String(this.attempts)} attempts to commit`;
  }
}

/** The outcome of one {@link Ledger} `modify`. */
export interface Committed<A> {
  readonly state: State;
  readonly value: A;
  /** False when the transition returned an equal state and nothing was written. */
  readonly wrote: boolean;
}

export class Ledger extends Context.Service<
  Ledger,
  {
    /** The current state; the empty state before the first write. */
    readonly read: Effect.Effect<State>;
    /**
     * Runs `transition` on the current state and commits its output as the
     * next generation. On a lost race it re-reads and re-runs `transition`, so
     * a transition may only read and probe. An equal output writes nothing. A
     * transition failure aborts without writing.
     */
    readonly modify: <A, E, R>(
      transition: (
        state: State,
      ) => Effect.Effect<{ readonly state: State; readonly value: A }, E, R>,
    ) => Effect.Effect<Committed<A>, E | LedgerContendedError, R>;
  }
>()("app/Ledger") {
  /** Over `directory`; `policy` checks every state read and written. */
  static readonly layer = (directory: string, policy: Policy) =>
    Layer.effect(
      Ledger,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fileOf = (generation: number) =>
          path.join(directory, `g-${String(generation)}.json`);
        const encode = (state: State) => Schema.encodeSync(StateJson)(state);

        const generations = Effect.gen(function* () {
          if (!(yield* fs.exists(directory))) return [];
          const names = yield* fs.readDirectory(directory);
          return names
            .flatMap((name) => {
              const match = GENERATION.exec(name);
              return match === null ? [] : [Number(match[1])];
            })
            .toSorted((a, b) => a - b);
        });

        const check = (state: State, file: string) =>
          Option.match(checkState(state, policy), {
            onNone: () => Effect.succeed(state),
            onSome: (violation) =>
              Effect.die(
                `berth ledger ${file} breaks an invariant: ${violation}`,
              ),
          });

        /** The highest generation and its state; a file pruned mid-read re-lists. */
        const current: Effect.Effect<{
          readonly generation: number;
          readonly state: State;
          readonly text: string;
        }> = Effect.gen(function* () {
          const generation = (yield* generations).at(-1);
          if (generation === undefined)
            return {
              generation: 0,
              state: EMPTY_STATE,
              text: encode(EMPTY_STATE),
            };
          const file = fileOf(generation);
          const text = yield* fs.readFileString(file).pipe(
            Effect.map(Option.some),
            Effect.catchReason(
              "PlatformError",
              "NotFound",
              () => Effect.succeedNone,
            ),
          );
          if (Option.isNone(text)) return yield* current;
          const state = yield* Schema.decodeUnknownEffect(StateJson)(
            text.value,
          ).pipe(
            Effect.mapError(
              (issue) =>
                `berth ledger ${file} does not decode: ${issue.message}`,
            ),
          );
          return {
            generation,
            state: yield* check(state, file),
            text: encode(state),
          };
        }).pipe(Effect.orDie);

        const prune = Effect.fn("Ledger.prune")(function* (latest: number) {
          const now = yield* Clock.currentTimeMillis;
          for (const name of yield* fs.readDirectory(directory)) {
            const file = path.join(directory, name);
            const match = GENERATION.exec(name);
            if (match !== null && Number(match[1]) <= latest - KEPT_GENERATIONS)
              yield* fs.remove(file).pipe(Effect.ignore);
            if (name.startsWith("tmp-")) {
              const info = yield* fs.stat(file).pipe(Effect.option);
              const modified = Option.flatMap(info, (info) => info.mtime);
              if (
                Option.exists(
                  modified,
                  (mtime) =>
                    now - mtime.getTime() >
                    Duration.toMillis(TEMP_FILE_LIFETIME),
                )
              )
                yield* fs.remove(file).pipe(Effect.ignore);
            }
          }
        }, Effect.orDie);

        /** Writes `text` as generation `next`; false when another writer took it. */
        const commit = Effect.fn("Ledger.commit")(function* (
          next: number,
          text: string,
        ) {
          yield* fs.makeDirectory(directory, { recursive: true });
          const nonce = yield* Random.nextIntBetween(0, 2 ** 31);
          const temp = path.join(
            directory,
            `tmp-${String(process.pid)}-${String(nonce)}.json`,
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const file = yield* fs.open(temp, { flag: "wx" });
              yield* file.writeAll(new TextEncoder().encode(text));
              yield* file.sync;
            }),
          );
          return yield* fs.link(temp, fileOf(next)).pipe(
            Effect.as(true),
            Effect.catchReason("PlatformError", "AlreadyExists", () =>
              Effect.succeed(false),
            ),
            Effect.ensuring(fs.remove(temp).pipe(Effect.ignore)),
          );
        }, Effect.orDie);

        const modify = <A, E, R>(
          transition: (
            state: State,
          ) => Effect.Effect<
            { readonly state: State; readonly value: A },
            E,
            R
          >,
        ): Effect.Effect<Committed<A>, E | LedgerContendedError, R> =>
          Effect.gen(function* () {
            for (let attempt = 1; attempt <= COMMIT_ATTEMPTS; attempt++) {
              const read = yield* current;
              const { state, value } = yield* transition(read.state);
              const text = encode(state);
              if (text === read.text)
                return { state: read.state, value, wrote: false };
              yield* check(state, "write");
              if (yield* commit(read.generation + 1, text)) {
                yield* prune(read.generation + 1);
                return { state, value, wrote: true };
              }
              yield* Effect.sleep(
                Duration.millis(yield* Random.nextIntBetween(1, 20)),
              );
            }
            return yield* new LedgerContendedError({
              attempts: COMMIT_ATTEMPTS,
            });
          });

        return Ledger.of({
          read: Effect.map(current, (read) => read.state),
          modify,
        });
      }),
    );
}
