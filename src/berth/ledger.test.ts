import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { NodeServices } from "@effect/platform-node";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  CheckoutPath,
  EnvName,
  MachineName,
  ProjectName,
  type State,
  StoreDomain,
} from "./domain.ts";
import { Ledger } from "./ledger.ts";

const machine = MachineName.make("test-mbp");
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

const withLedger = <A, E>(
  body: (ledger: Ledger["Service"], directory: string) => Effect.Effect<A, E>,
) => {
  const directory = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "berth-ledger-")),
    "ledger",
  );
  directories.push(path.dirname(directory));
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* body(yield* Ledger, directory);
    }).pipe(
      Effect.provide(
        Ledger.layer(directory).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );
};

const generations = (directory: string) =>
  fs
    .readdirSync(directory)
    .filter((name) => name.startsWith("g-"))
    .toSorted();

const addLease = (index: number) => (state: State) =>
  Effect.succeed({
    state: {
      ...state,
      leases: [
        ...state.leases,
        {
          key: {
            machine,
            checkout: CheckoutPath.make(`/c${String(index)}`),
            env: EnvName.make("dev"),
          },
          project: ProjectName.make("demo"),
          store: {
            domain: StoreDomain.make(`pool-${String(index)}.myshopify.com`),
            config: "shopify.app.toml",
          },
          acquiredAt: DateTime.makeUnsafe("2026-11-01T09:00:00Z"),
        },
      ],
    },
    value: index,
  });

describe("Ledger", () => {
  it("reads the empty state before the first write", async () => {
    const state = await withLedger((ledger) => ledger.read);
    expect(state.leases).toEqual([]);
  });

  it("commits a change and writes nothing for an equal state", async () => {
    await withLedger((ledger, directory) =>
      Effect.gen(function* () {
        const first = yield* ledger.modify(addLease(0));
        const second = yield* ledger.modify((state) =>
          Effect.succeed({ state, value: 0 }),
        );
        expect([first.wrote, second.wrote]).toEqual([true, false]);
        expect(generations(directory)).toEqual(["g-1.json"]);
        expect((yield* ledger.read).leases).toHaveLength(1);
      }),
    );
  });

  it("serializes concurrent writers without losing a change", async () => {
    const state = await withLedger((ledger) =>
      Effect.gen(function* () {
        yield* Effect.all(
          Array.from({ length: 8 }, (_, index) =>
            ledger.modify(addLease(index)),
          ),
          { concurrency: "unbounded" },
        );
        return yield* ledger.read;
      }),
    );
    expect(state.leases.map((lease) => lease.key.checkout).toSorted()).toEqual(
      Array.from({ length: 8 }, (_, index) => `/c${String(index)}`),
    );
  });

  it("keeps the last 10 generations", async () => {
    const kept = await withLedger((ledger, directory) =>
      Effect.gen(function* () {
        for (let index = 0; index < 12; index++)
          yield* ledger.modify(addLease(index));
        return generations(directory);
      }),
    );
    expect(kept).toHaveLength(10);
    expect(kept).toContain("g-12.json");
    expect(kept).not.toContain("g-2.json");
  });

  it("reads a generation that still holds the store pool, and drops it on the next write", async () => {
    const written = await withLedger((ledger, directory) =>
      Effect.gen(function* () {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(
          path.join(directory, "g-1.json"),
          JSON.stringify({
            leases: [],
            pool: [
              { domain: "mw10013-pool-00.myshopify.com", lastHolder: null },
            ],
            poolSyncedAt: "2026-11-03T13:14:24.871Z",
          }),
        );
        expect((yield* ledger.read).leases).toEqual([]);
        yield* ledger.modify(addLease(0));
        return JSON.parse(
          fs.readFileSync(path.join(directory, "g-2.json"), "utf8"),
        ) as object;
      }),
    );
    expect(Object.keys(written)).toEqual(["leases"]);
  });

  it("refuses to commit a state that breaks an invariant", async () => {
    const exit = await withLedger((ledger) =>
      Effect.exit(
        ledger.modify((state) =>
          addLease(0)(state).pipe(
            Effect.flatMap((once) => addLease(0)(once.state)),
          ),
        ),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });
});
