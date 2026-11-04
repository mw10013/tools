import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { type CheckoutPath, type StoreDomain } from "./domain.ts";

// EPERM: the process exists but belongs to another user.
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const DevSession = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.Int,
    details: Schema.Struct({ storeFqdn: Schema.String }),
  }),
);

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
