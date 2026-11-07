#!/usr/bin/env vpx
/**
 * `vp run logs`: a {@link Deployed} stage's Worker logs from Workers
 * Observability, one line per event, for both of the app's Workers
 * ({@link workerNameOf}). An app runs this file directly:
 * `"logs": "vpx vendor/devkit/cloudflare/logs.ts"`.
 *
 * @module
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Argument from "effect/cli/Argument";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { Deployed, workerNameOf } from "#devkit/cloudflare/stage.ts";
import { APP_NAME } from "#devkit/core/app.ts";
import { runCommand } from "#devkit/core/command.ts";

class LogsError extends Schema.TaggedError<LogsError>()("LogsError", {
  message: Schema.String,
}) {}

/**
 * How far behind a poll the logs are complete. Cloudflare showed a request's event 15 to 22 s
 * after it was sent (three probes on staging, 2026-10-25), so 60 s leaves room for a slow
 * ingest. Each poll re-reads this window and drops events it already printed.
 */
const INGEST_LAG = Duration.seconds(60);
const POLL = Duration.seconds(15);
const LIMIT = 500;

export const Event = Schema.Struct({
  timestamp: Schema.DateTimeUtcFromMillis,
  source: Schema.Unknown,
  $metadata: Schema.Struct({
    id: Schema.String,
    service: Schema.String,
    level: Schema.optionalKey(Schema.String),
    requestId: Schema.optionalKey(Schema.String),
  }),
  $workers: Schema.optionalKey(
    Schema.Struct({
      outcome: Schema.optionalKey(Schema.String),
      eventType: Schema.optionalKey(Schema.String),
      event: Schema.optionalKey(
        Schema.Struct({
          request: Schema.optionalKey(
            Schema.Struct({ method: Schema.String, url: Schema.String }),
          ),
          response: Schema.optionalKey(
            Schema.Struct({ status: Schema.Number }),
          ),
          webSocketEventType: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
});
export type Event = typeof Event.Type;

const decodeResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      events: Schema.optionalKey(
        Schema.Struct({ events: Schema.Array(Event) }),
      ),
    }),
  ),
);

const Message = Schema.Struct({
  message: Schema.String,
  level: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.String),
  annotations: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
const decodeMessage = Schema.decodeUnknownOption(Message);

const textOf = ({ message, cause, annotations = {} }: typeof Message.Type) => {
  const extra = Object.entries(annotations)
    .filter(([key]) => !message.includes(`${key}=`))
    .map(
      ([key, value]) =>
        `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
    );
  return [
    message,
    ...extra,
    ...(cause === undefined ? [] : [`cause: ${cause}`]),
  ].join(" ");
};

/**
 * Query parameters whose values never print: Shopify's `id_token`, `hmac` and
 * `session`, a magic link's `token`, OAuth's `code`, a signed URL's `signature`.
 */
const SECRET_PARAM = /token|hmac|session|signature|code/iu;

/** A request URL as its path and query, with secret parameters' values redacted. */
export const redactUrl = (raw: string) => {
  const url = URL.parse(raw);
  if (url === null) return raw;
  const secrets = [...url.searchParams.keys()].filter((key) =>
    SECRET_PARAM.test(key),
  );
  for (const key of secrets) url.searchParams.set(key, "redacted");
  return `${url.pathname}${url.search}`;
};

/** One event as a `|`-separated line: time, Worker, level, outcome, status, request, request id, message. */
export const lineOf = (stage: Deployed, event: Event) => {
  const workers = event.$workers;
  const request = workers?.event?.request;
  const structured = decodeMessage(event.source);
  const message = Option.match(structured, {
    onSome: textOf,
    onNone: () =>
      typeof event.source === "string"
        ? event.source
        : JSON.stringify(event.source ?? ""),
  });
  const level =
    event.$metadata.level ??
    Option.getOrUndefined(
      Option.flatMapNullishOr(structured, (line) => line.level),
    );
  return [
    DateTime.formatIso(event.timestamp),
    event.$metadata.service === workerNameOf(APP_NAME, stage, "backend")
      ? "backend"
      : "website",
    (level ?? "").toLowerCase(),
    workers?.outcome ?? "",
    String(workers?.event?.response?.status ?? ""),
    request === undefined
      ? (workers?.event?.webSocketEventType ?? workers?.eventType ?? "")
      : `${request.method} ${redactUrl(request.url)}`,
    event.$metadata.requestId ?? "",
    message.slice(0, 600),
  ].join(" | ");
};

const query = Effect.fn("Logs.query")(function* (
  stage: Deployed,
  from: DateTime.Utc,
  to: DateTime.Utc,
) {
  const service = (worker: "website" | "backend") => ({
    key: "$metadata.service",
    operation: "eq",
    type: "string",
    value: workerNameOf(APP_NAME, stage, worker),
  });
  const body = {
    queryId: "adhoc",
    view: "events",
    limit: LIMIT,
    timeframe: {
      from: DateTime.toEpochMillis(from),
      to: DateTime.toEpochMillis(to),
    },
    parameters: {
      datasets: ["cloudflare-workers"],
      filters: [
        {
          kind: "group",
          filterCombination: "or",
          filters: [service("website"), service("backend")],
        },
      ],
    },
  };
  const stdout = yield* runCommand("cf", [
    "o11y",
    "telemetry",
    "query",
    "--body",
    JSON.stringify(body),
  ]);
  const result = yield* decodeResult(stdout).pipe(
    Effect.mapError(
      (error) =>
        new LogsError({
          message: `cf o11y returned an unexpected shape: ${error.message}`,
        }),
    ),
  );
  const events = (result.events?.events ?? []).toSorted((a, b) =>
    DateTime.Order(a.timestamp, b.timestamp),
  );
  if (events.length === LIMIT) {
    yield* Console.error(
      `logs: ${String(LIMIT)} events in one window; some may be missing`,
    );
  }
  return events;
});

const stageArgument = Argument.Literals("stage", Deployed.literals).pipe(
  Argument.withDescription("staging or production"),
);

const sinceFlag = Flag.String("since").pipe(
  Flag.withSchema(Schema.DurationFromString),
  Flag.withDescription('How far back to start, such as "10 minutes"'),
  Flag.withDefault(Duration.minutes(10)),
);

const outFlag = Flag.String("out").pipe(
  Flag.withDescription("The log file; its watermark is <out>.watermark"),
);

const watermarkOf = (out: string) => `${out}.watermark`;

const toUserError = (error: { readonly message: string }) =>
  new CliError.UserError({ cause: error, userMessage: error.message });

const show = Command.make(
  "show",
  { stage: stageArgument, since: sinceFlag },
  Effect.fn("Logs.show")(function* ({ stage, since }) {
    const to = yield* DateTime.now;
    const events = yield* query(
      stage,
      DateTime.subtractDuration(to, since),
      to,
    );
    for (const event of events) yield* Console.log(lineOf(stage, event));
  }, Effect.mapError(toUserError)),
).pipe(
  Command.withDescription("Print the stage's events since --since, then exit."),
);

const follow = Command.make(
  "follow",
  { stage: stageArgument, since: sinceFlag, out: outFlag },
  Effect.fn("Logs.follow")(function* ({ stage, since, out }) {
    const fs = yield* FileSystem.FileSystem;
    const seen = new Map<string, DateTime.Utc>();
    let from = DateTime.subtractDuration(yield* DateTime.now, since);
    // `vp run` does not pass its kill on to this process, so the stop step needs this pid.
    yield* fs.writeFileString(`${out}.pid`, String(process.pid));
    yield* Console.log(
      `Following ${stage} into ${out}; stop it with kill $(cat ${out}.pid)`,
    );
    const poll = Effect.gen(function* () {
      const to = yield* DateTime.now;
      const floor = DateTime.subtractDuration(from, INGEST_LAG);
      const events = yield* query(stage, floor, to);
      const fresh = events.filter((event) => !seen.has(event.$metadata.id));
      for (const event of fresh) seen.set(event.$metadata.id, event.timestamp);
      for (const [id, timestamp] of seen)
        if (DateTime.isLessThan(timestamp, floor)) seen.delete(id);
      if (fresh.length > 0) {
        yield* fs.writeFileString(
          out,
          fresh.map((e) => `${lineOf(stage, e)}\n`).join(""),
          {
            flag: "a",
          },
        );
      }
      yield* fs.writeFileString(
        watermarkOf(out),
        DateTime.formatIso(DateTime.subtractDuration(to, INGEST_LAG)),
      );
      from = to;
    }).pipe(
      Effect.catch((error) =>
        Effect.flatMap(DateTime.now, (now) =>
          fs.writeFileString(
            out,
            `${DateTime.formatIso(now)} | logs: poll failed: ${error.message.slice(0, 300)}\n`,
            { flag: "a" },
          ),
        ),
      ),
    );
    yield* poll.pipe(Effect.repeat(Schedule.spaced(POLL)));
  }, Effect.mapError(toUserError)),
).pipe(
  Command.withDescription(
    "Append the stage's events to --out every 15 s until stopped, with a watermark.",
  ),
);

const wait = Command.make(
  "wait",
  {
    time: Argument.String("time").pipe(
      Argument.withSchema(Schema.DateTimeUtcFromString),
      Argument.withDescription(
        "An ISO time, such as the time of the action to check",
      ),
    ),
    out: outFlag,
  },
  Effect.fn("Logs.wait")(function* ({ time, out }) {
    const fs = yield* FileSystem.FileSystem;
    const stale = Duration.times(POLL, 3);
    const started = yield* DateTime.now;
    const check = Effect.gen(function* () {
      const file = watermarkOf(out);
      const info = yield* fs.stat(file).pipe(Effect.option);
      const mtime = Option.flatMap(info, (stat) => stat.mtime);
      const now = yield* DateTime.now;
      if (
        Option.isNone(mtime) &&
        Duration.isLessThanOrEqualTo(DateTime.distance(started, now), stale)
      )
        return false;
      if (
        Option.isNone(mtime) ||
        Duration.isGreaterThan(
          DateTime.distance(DateTime.fromDateUnsafe(mtime.value), now),
          stale,
        )
      ) {
        return yield* new LogsError({
          message: `${file} is missing or older than ${String(Duration.toSeconds(stale))} s. Is vp run logs follow --out ${out} running?`,
        });
      }
      return Option.exists(
        DateTime.make(yield* fs.readFileString(file)),
        (watermark) => DateTime.isGreaterThanOrEqualTo(watermark, time),
      );
    });
    yield* check.pipe(
      Effect.repeat({
        until: (done) => done,
        schedule: Schedule.spaced("1 second"),
      }),
      Effect.timeoutOrElse({
        duration: "5 minutes",
        orElse: () =>
          Effect.fail(
            new LogsError({
              message: "The watermark did not pass in 5 minutes.",
            }),
          ),
      }),
    );
    yield* Console.log(`${out} holds every event up to ${time.toString()}`);
  }, Effect.mapError(toUserError)),
).pipe(
  Command.withDescription(
    "Return once a running follow's --out holds every event up to <time>; about a minute after it.",
  ),
);

// Only when run, so a test can import this module.
if (import.meta.main) {
  Command.make("logs").pipe(
    Command.withDescription(
      "Read staging's or production's Worker logs (website and backend).",
    ),
    Command.withSubcommands([show, follow, wait]),
    Command.run({ version: "1.0.0" }),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
