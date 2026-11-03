/**
 * What berth reads from the Shopify CLI's files: whether a checkout's
 * `shopify app dev` is running on a store. No CLI JSON shape leaves this
 * module.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { type CheckoutPath, type StoreDomain } from "./domain.ts";
import { isAlive } from "./probe.ts";

/** The part of `.shopify/dev/app-dev-*.json` berth reads. */
const DevSession = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.Int,
    details: Schema.Struct({ storeFqdn: Schema.String }),
  }),
);

/**
 * The pid of a live `shopify app dev` in `checkout` on `store`, from the CLI's
 * session files. A file that does not decode is not a session berth knows.
 */
export const liveSession = Effect.fn("Shopify.liveSession")(function* (
  checkout: CheckoutPath,
  store: StoreDomain,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(checkout, ".shopify", "dev");
  if (!(yield* fs.exists(directory))) return Option.none<number>();
  for (const name of yield* fs.readDirectory(directory)) {
    if (!/^app-dev-.*\.json$/u.test(name)) continue;
    const text = yield* fs
      .readFileString(path.join(directory, name))
      .pipe(Effect.option);
    const session = Option.flatMap(text, (text) =>
      Schema.decodeUnknownOption(DevSession)(text),
    );
    if (
      Option.isSome(session) &&
      session.value.details.storeFqdn === store &&
      isAlive(session.value.pid)
    )
      return Option.some(session.value.pid);
  }
  return Option.none<number>();
}, Effect.orDie);
