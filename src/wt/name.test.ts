import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { firstFree, fromWords, NAME_MAX, WorktreeName } from "./name.ts";

describe("fromWords", () => {
  it("spells the words in kebab case", () => {
    expect(fromWords(["PR", "123", "plan labels!"])).toStrictEqual(
      Option.some("pr-123-plan-labels"),
    );
  });

  it("keeps a name that is already kebab case", () => {
    expect(fromWords(["fix-plan-labels"])).toStrictEqual(
      Option.some("fix-plan-labels"),
    );
  });

  it("cuts a long name at a hyphen within the limit", () => {
    const name = Option.getOrThrow(
      fromWords([
        "the quick brown fox jumps over the lazy dog and keeps running",
      ]),
    );
    expect(name).toBe("the-quick-brown-fox-jumps-over-the-lazy");
    expect(name.length).toBeLessThanOrEqual(NAME_MAX);
  });

  it("cuts a single long word at the limit", () => {
    expect(fromWords(["a".repeat(50)])).toStrictEqual(
      Option.some("a".repeat(NAME_MAX)),
    );
  });

  it("is None when no letter or digit is left", () => {
    expect(fromWords(["--", "!!"])).toStrictEqual(Option.none());
  });
});

describe("firstFree", () => {
  const name = WorktreeName.make("fix-labels");

  it("keeps a free name", () => {
    expect(firstFree(name, () => false)).toBe("fix-labels");
  });

  it("adds the first free suffix", () => {
    const taken = new Set(["fix-labels", "fix-labels-2"]);
    expect(firstFree(name, (candidate) => taken.has(candidate))).toBe(
      "fix-labels-3",
    );
  });

  it("shortens a full-length name so the suffix fits", () => {
    const long = WorktreeName.make("a".repeat(NAME_MAX));
    const free = firstFree(long, (candidate) => candidate === long);
    expect(free).toBe(`${"a".repeat(NAME_MAX - 2)}-2`);
  });
});
