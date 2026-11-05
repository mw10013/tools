import * as fs from "node:fs";
import { createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { publishFreePort } from "./bosun-port.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bosun-port-"));
const endpoint = path.join(scratch, "endpoint.json");

const environment = (env: Record<string, string>) =>
  Layer.merge(
    NodeServices.layer,
    ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
  );

const bindable = (port: number) =>
  new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "localhost", () => server.close(() => resolve(true)));
  });

describe("publishFreePort", () => {
  it.effect(
    "publishes the port it returns, with its URL, and leaves the port free",
    () =>
      Effect.gen(function* () {
        const port = yield* publishFreePort;
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(endpoint, "utf8")), {
          port,
          url: `http://localhost:${String(port)}/`,
        });
        assert.isTrue(yield* Effect.promise(() => bindable(port)));
      }).pipe(Effect.provide(environment({ BOSUN_ENDPOINT: endpoint }))),
  );

  it.effect("fails outside bosun", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(publishFreePort);
      assert.strictEqual(error._tag, "UserError");
    }).pipe(Effect.provide(environment({}))),
  );
});
