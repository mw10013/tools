/**
 * Worktree names. A name is a branch and a directory at once, so it is kebab
 * case, which both accept everywhere, and at most {@link NAME_MAX}
 * characters, below the length at which T3 Code hashes a directory name.
 *
 * @module
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const NAME_MAX = 40;

export const WorktreeName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  Schema.isMaxLength(NAME_MAX),
).pipe(Schema.brand("WorktreeName"));
export type WorktreeName = typeof WorktreeName.Type;

/**
 * The name the caller's words spell: lowercase, each run of other characters
 * one hyphen, cut at the last hyphen that fits. `None` when no letter or
 * digit is left.
 */
export const fromWords = (
  words: ReadonlyArray<string>,
): Option.Option<WorktreeName> => {
  const kebab = words
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const head = kebab.slice(0, NAME_MAX + 1);
  const hyphen = head.lastIndexOf("-");
  const cut =
    kebab.length <= NAME_MAX
      ? kebab
      : hyphen > 0
        ? head.slice(0, hyphen)
        : kebab.slice(0, NAME_MAX);
  return Schema.decodeUnknownOption(WorktreeName)(cut.replace(/-+$/u, ""));
};

/**
 * `name` when it is free, else the first free `name-2`, `name-3`, …, each
 * shortened so the suffix fits.
 */
export const firstFree = (
  name: WorktreeName,
  taken: (candidate: string) => boolean,
): WorktreeName => {
  if (!taken(name)) return name;
  for (let n = 2; ; n++) {
    const suffix = `-${String(n)}`;
    const stem = name.slice(0, NAME_MAX - suffix.length).replace(/-+$/u, "");
    const candidate = `${stem}${suffix}`;
    if (!taken(candidate)) return WorktreeName.make(candidate);
  }
};
