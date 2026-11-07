import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { app } from "#devkit/core/app.ts";

import { Event, lineOf, redactUrl } from "./logs.ts";

const event = (fields: Record<string, unknown>) =>
  Schema.decodeUnknownSync(Event)({
    timestamp: Date.UTC(2026, 10, 4, 12, 0, 0),
    source: "hello",
    ...fields,
    $metadata: {
      id: "e1",
      service: `${app().name}-backend-staging`,
      ...(fields.$metadata as object | undefined),
    },
  });

describe("redactUrl", () => {
  it("keeps the path and query, and redacts secret parameters", () => {
    expect(
      redactUrl(
        "https://x.dev/api/auth/magic-link/verify?token=abc&callbackURL=%2Fapp",
      ),
    ).toBe("/api/auth/magic-link/verify?token=redacted&callbackURL=%2Fapp");
    expect(redactUrl("https://x.dev/app?id_token=a&hmac=b&shop=s")).toBe(
      "/app?id_token=redacted&hmac=redacted&shop=s",
    );
  });

  it("returns a string that is not a URL unchanged", () => {
    expect(redactUrl("not a url")).toBe("not a url");
  });
});

describe("lineOf", () => {
  it("names the Worker from the app's deployed Worker names", () => {
    const website = event({
      $metadata: { service: `${app().name}-website-staging` },
    });
    expect(lineOf("staging", event({}))).toContain(" | backend | ");
    expect(lineOf("staging", website)).toContain(" | website | ");
  });

  it("prints a request's method, redacted URL and status", () => {
    const line = lineOf(
      "staging",
      event({
        $metadata: { level: "INFO", requestId: "r1" },
        $workers: {
          outcome: "ok",
          event: {
            request: { method: "GET", url: "https://x.dev/a?token=t" },
            response: { status: 200 },
          },
        },
      }),
    );
    expect(line).toBe(
      "2026-11-04T12:00:00.000Z | backend | info | ok | 200 | GET /a?token=redacted | r1 | hello",
    );
  });

  it("prints an Effect log line's message, annotations and cause", () => {
    const line = lineOf(
      "staging",
      event({
        source: {
          message: "sign-in failed",
          level: "ERROR",
          cause: "Boom",
          annotations: { email: "a@b.c" },
        },
      }),
    );
    expect(line.endsWith(" | sign-in failed email=a@b.c cause: Boom")).toBe(
      true,
    );
    expect(line).toContain(" | error | ");
  });
});
