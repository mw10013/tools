#!/usr/bin/env vpx
/**
 * Picks a free localhost port, publishes it to bosun as the server's endpoint and prints it, for
 * a server that takes its port as an argument and never reports the port it bound: `alchemy dev`
 * serves the app from a proxy whose port stays inside Alchemy. A Vite server publishes itself
 * after it binds, with `bosunEndpoint` from `core/bosun-endpoint.ts`, and needs none of this.
 *
 * The port is free when picked, not reserved. The server must bind it strictly, so a process that
 * takes it first fails the start instead of moving the server off the published port. An app
 * runs this file directly: `port=$(vpx vendor/devkit/core/bosun-port.ts)`.
 *
 * @module
 */
import { createServer } from "node:net";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/** A TCP port the OS assigned on localhost, released again before this returns. */
const freePort = Effect.callback<number>((resume) => {
  const server = createServer();
  server.once("error", (cause) => {
    resume(Effect.die(cause));
  });
  server.listen(0, "localhost", () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      resume(
        Effect.die(
          new Error(`localhost bound no TCP address: ${String(address)}`),
        ),
      );
      return;
    }
    server.close(() => {
      resume(Effect.succeed(address.port));
    });
  });
});

/** Writes `{ port, url }` for a free port to the file `BOSUN_ENDPOINT` names, and returns the port. */
export const publishFreePort = Effect.gen(function* () {
  const endpoint = yield* Config.String("BOSUN_ENDPOINT").pipe(
    Effect.mapError(
      (cause) =>
        new CliError.UserError({
          cause,
          userMessage:
            "BOSUN_ENDPOINT is unset: start the server with bosun start",
        }),
    ),
  );
  const port = yield* freePort;
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(
    endpoint,
    JSON.stringify({ port, url: `http://localhost:${String(port)}/` }),
  );
  return port;
});

// Only when run, so a test can import this module.
if (import.meta.main) {
  Command.make("bosun-port", {}, () =>
    publishFreePort.pipe(Effect.flatMap(Console.log)),
  ).pipe(
    Command.withDescription(
      "Publish a free localhost port to bosun and print it.",
    ),
    Command.run({ version: "1.0.0" }),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
