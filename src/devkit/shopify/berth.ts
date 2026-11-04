import { spawnSync } from "node:child_process";

/**
 * This checkout's leases from berth, the machine-wide tool that hands each checkout and
 * environment its own Shopify dev store (`berth.json` declares what each needs). A lease is the
 * one source of a server's store and app config: nothing else assigns them. Ports are the
 * server's own ({@link "./server.ts"}). `berth acquire` is idempotent, so every reader asks for the
 * lease again rather than passing it around.
 *
 * @see ~/projects/tools/docs/berth.md, the contract decoded here.
 * @module
 */
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Stream from "effect/Stream";

import { ROOT } from "#devkit/core/app.ts";

import type { WebEnvironment } from "./web.ts";

export class LeaseNotGrantedError extends Schema.TaggedError<LeaseNotGrantedError>()(
  "LeaseNotGrantedError",
  {
    environment: Schema.String,
    reason: Schema.String,
    message: Schema.String,
  },
) {}

export interface Lease {
  /** The store's handle, such as `mw10013-pool-00`, which `--store` and admin URLs take. */
  readonly store: string;
  /** The app config file the server's `shopify app dev` runs with. */
  readonly config: string;
}

const MYSHOPIFY = ".myshopify.com";

const StoreHandle = Schema.String.check(
  Schema.isPattern(/^[a-z0-9-]+\.myshopify\.com$/u),
).pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (domain) => domain.slice(0, -MYSHOPIFY.length),
      encode: (handle) => `${handle}${MYSHOPIFY}`,
    }),
  ),
);

const LeaseJson = Schema.Struct({
  store: Schema.Struct({ domain: StoreHandle, config: Schema.String }),
});

const ErrorJson = Schema.Struct({
  error: Schema.Struct({
    _tag: Schema.String,
    message: Schema.String,
  }),
});

const AcquireOutput = Schema.fromJsonString(
  Schema.Union([LeaseJson, ErrorJson]),
);

const toLease = (json: typeof LeaseJson.Type): Lease => ({
  store: json.store.domain,
  config: json.store.config,
});

const notGranted = (
  environment: WebEnvironment,
  error: typeof ErrorJson.Type.error,
) =>
  new LeaseNotGrantedError({
    environment,
    reason: error._tag,
    message: error.message,
  });

export const leaseOf = (
  environment: WebEnvironment,
  stdout: string,
): Result.Result<Lease, LeaseNotGrantedError> => {
  const output = Schema.decodeUnknownResult(AcquireOutput)(stdout);
  if (Result.isFailure(output))
    return Result.fail(
      new LeaseNotGrantedError({
        environment,
        reason: "UnreadableOutput",
        message: `berth acquire ${environment} printed no lease; its stderr says why`,
      }),
    );
  const value = output.success;
  if ("error" in value)
    return Result.fail(notGranted(environment, value.error));
  return Result.succeed(toLease(value));
};

const notFound = (environment: WebEnvironment) =>
  new LeaseNotGrantedError({
    environment,
    reason: "BerthNotFound",
    message:
      "berth did not run: install its shim, ~/.local/bin/berth running `vpx ~/projects/tools/berth.ts`",
  });

export const acquire = Effect.fn("Berth.acquire")(function* (
  environment: WebEnvironment,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner
    .spawn(
      ChildProcess.make("berth", ["acquire", environment], {
        cwd: ROOT,
        stdin: "ignore",
        stderr: "inherit",
      }),
    )
    .pipe(Effect.mapError(() => notFound(environment)));
  const stdout = yield* Stream.mkString(Stream.decodeText(handle.stdout)).pipe(
    Effect.mapError(() => notFound(environment)),
  );
  yield* handle.exitCode.pipe(Effect.mapError(() => notFound(environment)));
  return yield* Effect.fromResult(leaseOf(environment, stdout));
}, Effect.scoped);

/** {@link acquire} for configs that cannot run an effect (Playwright's); throws its failure's message. */
export const acquireSync = (environment: WebEnvironment): Lease => {
  const run = spawnSync("berth", ["acquire", environment], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (run.error !== undefined) throw new Error(notFound(environment).message);
  return Result.getOrThrowWith(
    leaseOf(environment, run.stdout),
    (error) => new Error(error.message),
  );
};
