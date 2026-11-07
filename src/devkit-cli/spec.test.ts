import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  compareVersions,
  parseVersion,
  pinOf,
  specOf,
  versionOfTag,
} from "./spec.ts";

describe("pinOf", () => {
  it("accepts exactly the spec specOf writes", () => {
    expect(specOf("0.12.3")).toBe("github:mw10013/tools#devkit-v0.12.3");
    expect(pinOf(specOf("0.12.3"))).toEqual({
      _tag: "Pinned",
      version: "0.12.3",
    });
  });

  it.each([
    ["file:../tools/dist/devkit", "file"],
    ["file:/tmp/devkit-ab12.tgz", "file"],
    ["link:../tools/src/devkit", "link"],
    ["github:mw10013/tools", "branch"],
    ["github:mw10013/tools#main", "branch"],
    ["github:mw10013/tools#devkit-v0.1", "branch"],
    ["github:mw10013/tools#4b75272", "sha"],
    ["github:mw10013/tools#4b752728e1c0f3e4f2e3a7a0a4d0f2b1c3d4e5f6", "sha"],
    ["github:mw10013/tools#devkit-v0.2.0-rc.1", "prerelease"],
    ["github:someone/else#devkit-v0.1.0", "other"],
    ["catalog:", "other"],
    ["^0.1.0", "other"],
  ])("refuses %s as %s", (spec, kind) => {
    expect(pinOf(spec)).toEqual({ _tag: "Unpinned", kind });
  });
});

describe("versions", () => {
  it("parses release versions only", () => {
    expect(Option.isSome(parseVersion("0.1.0"))).toBe(true);
    for (const bad of ["v0.1.0", "0.1", "0.1.0-rc.1", "01.a.0", ""])
      expect(Option.isNone(parseVersion(bad)), bad).toBe(true);
    expect(Option.getOrNull(versionOfTag("devkit-v1.2.3"))).toBe("1.2.3");
    expect(Option.isNone(versionOfTag("devkit-v1.2.3-rc.1"))).toBe(true);
    expect(Option.isNone(versionOfTag("v1.2.3"))).toBe(true);
  });

  it("orders numerically, not as text", () => {
    const version = (text: string) => Option.getOrThrow(parseVersion(text));
    expect(compareVersions(version("0.9.0"), version("0.10.0"))).toBeLessThan(
      0,
    );
    expect(
      compareVersions(version("1.0.0"), version("0.10.0")),
    ).toBeGreaterThan(0);
    expect(compareVersions(version("0.10.0"), version("0.10.0"))).toBe(0);
  });
});
