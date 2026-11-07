import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { run } from "#wt/process.ts";

export class DirtyCheckoutError extends Schema.TaggedError<DirtyCheckoutError>()(
  "DirtyCheckoutError",
  { directory: Schema.String, changes: Schema.Array(Schema.String) },
) {
  override get message() {
    return `${this.directory} has uncommitted changes: ${this.changes.join(", ")}`;
  }
}

/** Fails while the checkout holds a change, a deleted file or an untracked one. */
export const requireClean = Effect.fn("Checkout.requireClean")(function* (
  directory: string,
) {
  const changes = (yield* run(directory, "git", ["status", "--porcelain"]))
    .split("\n")
    .filter((line) => line.length > 0);
  if (changes.length > 0)
    return yield* new DirtyCheckoutError({
      directory,
      changes: changes.slice(0, 5).map((line) => line.slice(3)),
    });
});
