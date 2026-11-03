import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import {
  bosunOutput,
  runningOf,
  tunnelErrorMessage,
  tunnelServes,
} from "./server.ts";
describe("tunnelServes", () => {
  it("reads Cloudflare's 530 as a tunnel whose cloudflared is gone", () => {
    assert.isFalse(tunnelServes(530));
  });

  it("reads any other status, a redirect or an error included, as the server answering", () => {
    for (const status of [200, 302, 404, 500, 502])
      assert.isTrue(tunnelServes(status));
  });
});

describe("tunnelErrorMessage", () => {
  const url = "https://a-b-c.trycloudflare.com";

  it("names public DNS when the lookup half failed", () => {
    assert.strictEqual(
      tunnelErrorMessage({
        phase: "resolve",
        url,
        lastSeen: "ENOTFOUND",
        waited: Duration.millis(90_400),
      }),
      `the tunnel ${url} does not resolve on public DNS after 90s (last: ENOTFOUND)`,
    );
  });

  it("names the answer through the tunnel when the fetch half failed", () => {
    assert.strictEqual(
      tunnelErrorMessage({
        phase: "answer",
        url,
        lastSeen: "HTTP 530",
        waited: Duration.seconds(61),
      }),
      `the tunnel ${url} resolves but / does not answer through it after 61s (last: HTTP 530)`,
    );
  });
});

const status = (fields: Record<string, unknown>) =>
  JSON.stringify({
    bosun: 1,
    name: "e2e",
    state: "running",
    run: "9df4baf3",
    pid: 43_986,
    group: 44_007,
    startedAt: "2026-11-03T14:56:35.734Z",
    port: 50_713,
    url: "https://example.trycloudflare.com",
    log: ".bosun/e2e/log/current",
    ...fields,
  });

const running = (stdout: string) =>
  runningOf(Result.getOrThrow(bosunOutput(["status", "e2e"], stdout)));

describe("bosun status", () => {
  it("reads a running server's port, tunnel and start", () => {
    assert.deepStrictEqual(
      running(status({})),
      Option.some({
        port: 50_713,
        url: Option.some("https://example.trycloudflare.com"),
        startedAt: Option.some(new Date("2026-11-03T14:56:35.734Z")),
        log: ".bosun/e2e/log/current",
      }),
    );
  });

  it("reads an empty url as no tunnel", () => {
    assert.deepStrictEqual(
      Option.map(running(status({ url: "" })), (server) => server.url),
      Option.some(Option.none()),
    );
  });

  it("has no running server while it starts or once it stopped", () => {
    assert.isTrue(Option.isNone(running(status({ state: "starting" }))));
    assert.isTrue(
      Option.isNone(
        running(
          status({
            state: "stopped",
            run: null,
            pid: null,
            group: null,
            startedAt: null,
            port: null,
            url: null,
          }),
        ),
      ),
    );
  });

  it("fails with bosun's message, or names the command when the output is not bosun's", () => {
    const refused = bosunOutput(
      ["start", "e2e"],
      JSON.stringify({
        bosun: 1,
        error: { _tag: "ServerExitedError", message: "it exited" },
      }),
    );
    assert.isTrue(Result.isFailure(refused));
    if (Result.isFailure(refused))
      assert.strictEqual(refused.failure.message, "it exited");
    const garbled = bosunOutput(["status", "e2e"], "USAGE\n");
    assert.isTrue(Result.isFailure(garbled));
    if (Result.isFailure(garbled))
      assert.strictEqual(
        garbled.failure.message,
        "bosun status e2e printed no status; its stderr says why",
      );
  });
});
