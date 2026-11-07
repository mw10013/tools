/**
 * `devkit upgrade [x.y.z]`, run in an app checkout on a task branch. It moves the app's one
 * declaration of devkit to the release, the latest by default, runs the install, and returns the
 * releases' annotations between the old version and the new, which is how a caller learns a release
 * needs a change in the app. It does not commit, test or open a pull request.
 *
 * @module
 */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { stream } from "#wt/process.ts";

import { requireClean } from "./checkout.ts";
import * as Consumer from "./consumer.ts";
import * as Spec from "./spec.ts";
import * as Tags from "./tags.ts";

export class NotAConsumerError extends Schema.TaggedError<NotAConsumerError>()(
  "NotAConsumerError",
  { directory: Schema.String },
) {
  override get message() {
    return `${this.directory} does not declare ${Spec.PACKAGE}, so there is no spec to upgrade`;
  }
}

export class UnknownReleaseError extends Schema.TaggedError<UnknownReleaseError>()(
  "UnknownReleaseError",
  { version: Schema.String, latest: Schema.String },
) {
  override get message() {
    return `${Spec.tagOf(this.version)} is not a published release${this.latest === "" ? "" : `; the latest is ${this.latest}`}`;
  }
}

export class NoReleasesError extends Schema.TaggedError<NoReleasesError>()(
  "NoReleasesError",
  { remote: Schema.String },
) {
  override get message() {
    return `${this.remote} has no ${Spec.TAG_PREFIX}* release to upgrade to`;
  }
}

/** Runs the app's install. The default is `vp install` in the app. */
export const installIn = (app: string) => stream(app, "vp", ["install"]);

export const upgrade = Effect.fn("Upgrade.upgrade")(function* <E, R>(
  app: string,
  remote: string,
  requested: Option.Option<string>,
  install: Effect.Effect<void, E, R>,
) {
  yield* requireClean(app);
  const declaration = yield* Consumer.declarationOf(app);
  if (Option.isNone(declaration))
    return yield* new NotAConsumerError({ directory: app });
  const published = yield* Tags.listTags(app, remote);
  const latest = Tags.latestOf(published);
  const target = yield* Option.match(requested, {
    onNone: () =>
      Option.match(latest, {
        onNone: () => Effect.fail(new NoReleasesError({ remote })),
        onSome: (entry) => Effect.succeed(entry),
      }),
    onSome: (version) =>
      Option.match(
        Option.fromNullishOr(
          published.find((entry) => entry.version === version),
        ),
        {
          onNone: () =>
            Effect.fail(
              new UnknownReleaseError({
                version,
                latest: Option.match(latest, {
                  onNone: () => "",
                  onSome: (entry) => entry.version,
                }),
              }),
            ),
          onSome: (entry) => Effect.succeed(entry),
        },
      ),
  });
  const from = Option.flatMap(
    Option.some(Spec.pinOf(declaration.value.spec)),
    (pin) =>
      pin._tag === "Pinned" ? Option.some(pin.version) : Option.none<string>(),
  );
  const spec = Spec.specOf(target.version);
  yield* Consumer.setSpec(declaration.value, spec);
  yield* Console.error(
    `devkit: ${declaration.value.file}#${declaration.value.field} is now ${spec}`,
  );
  yield* install;
  const messages = yield* Tags.annotations(remote).pipe(
    Effect.catchTag("CommandFailedError", (error) =>
      Console.error(`devkit: no release log: ${error.message}`).pipe(
        Effect.as(new Map<string, string>()),
      ),
    ),
  );
  const log = Tags.releaseLog(messages, from, target.version).filter(
    (entry) => Option.isSome(from) || entry.tag === target.tag,
  );
  return {
    declaredIn: `${declaration.value.file}#${declaration.value.field}`,
    from: Option.getOrNull(from),
    previousSpec: declaration.value.spec,
    to: target.version,
    spec,
    log,
  };
});
