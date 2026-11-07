import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { build, builtManifest, entriesOf, SOURCE } from "./build.ts";

interface Manifest {
  readonly exports: Readonly<
    Record<string, { types: string; default: string }>
  >;
  readonly bin: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
}

const source = JSON.parse(
  fs.readFileSync(path.join(SOURCE, "package.json"), "utf8"),
) as Record<string, unknown>;

let scratch: string;
let output: string;
let manifest: Manifest;

beforeAll(async () => {
  scratch = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "devkit-build-")),
  );
  output = path.join(scratch, "devkit");
  await Effect.runPromise(
    build(output).pipe(Effect.provide(NodeServices.layer)),
  );
  manifest = JSON.parse(
    fs.readFileSync(path.join(output, "package.json"), "utf8"),
  ) as Manifest;
}, 120_000);

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

const inOutput = (file: string) => path.join(output, file);

const filesUnder = (directory: string): string[] =>
  fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? filesUnder(path.join(directory, entry.name))
        : [path.join(directory, entry.name)],
    );

/**
 * Every module specifier a built file names: `import … from "x"`, `export … from "x"`, `import "x"`
 * and `import("x")`, which in a `.d.mts` is a type. A line-anchored pattern keeps a specifier that
 * only appears inside a string or a comment, like a lint message's example, out of the result.
 */
const specifiersOf = (file: string): string[] => {
  const text = fs.readFileSync(file, "utf8");
  const pattern =
    /^(?:import|export)\s[^;"']*?from\s*["'](?<named>[^"']+)["']|^import\s*["'](?<bare>[^"']+)["']|\bimport\(\s*["'](?<dynamic>[^"']+)["']\s*\)/gmu;
  return [...text.matchAll(pattern)].map(
    ({ groups }) => groups?.named ?? groups?.bare ?? groups?.dynamic ?? "",
  );
};

const isRelative = (specifier: string) => specifier.startsWith(".");

const packageOf = (specifier: string) => {
  const [first = "", second = ""] = specifier.split("/");
  return specifier.startsWith("@") ? `${first}/${second}` : first;
};

/** Every bare specifier in the built graph an entry reaches, following relative imports. */
const bareSpecifiersReachedFrom = (entry: string): Set<string> => {
  const bare = new Set<string>();
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const specifier of specifiersOf(file))
      if (isRelative(specifier))
        visit(path.resolve(path.dirname(file), specifier));
      else bare.add(specifier);
  };
  visit(path.resolve(output, entry));
  return bare;
};

const reachedFrom = (key: string) => {
  const target = manifest.exports[key];
  if (target === undefined) throw new Error(`no export ${key}`);
  return new Set([
    ...bareSpecifiersReachedFrom(target.default),
    ...bareSpecifiersReachedFrom(target.types),
  ]);
};

describe("the built package", () => {
  it("lists in its manifest exactly the exports and bins the source lists", () => {
    const sourceExports = source.exports as Record<string, string>;
    const sourceBin = source.bin as Record<string, string>;
    expect(Object.keys(manifest.exports)).toEqual(Object.keys(sourceExports));
    expect(Object.keys(manifest.bin)).toEqual(Object.keys(sourceBin));
    expect(entriesOf(source)).toHaveLength(
      Object.keys(sourceExports).length + Object.keys(sourceBin).length,
    );
    expect(builtManifest(source)).toEqual(manifest);
  });

  it("has a script and a declaration file behind every export", () => {
    for (const [key, target] of Object.entries(manifest.exports)) {
      expect(target.default, key).toMatch(/^\.\/dist\/.+\.mjs$/u);
      expect(target.types, key).toMatch(/^\.\/dist\/.+\.d\.mts$/u);
      expect(fs.existsSync(inOutput(target.default)), target.default).toBe(
        true,
      );
      expect(fs.existsSync(inOutput(target.types)), target.types).toBe(true);
    }
  });

  it("has an executable vpx script behind every bin", () => {
    for (const [name, target] of Object.entries(manifest.bin)) {
      const file = inOutput(target);
      expect(fs.existsSync(file), name).toBe(true);
      expect(fs.statSync(file).mode & 0o111, name).not.toBe(0);
      expect(fs.readFileSync(file, "utf8").split("\n")[0], name).toBe(
        "#!/usr/bin/env vpx",
      );
    }
  });

  it("names no .ts file as a module specifier, or builds a URL to one", () => {
    const files = filesUnder(inOutput("dist"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      expect(
        specifiersOf(file).filter((specifier) => /\.m?ts$/u.test(specifier)),
        file,
      ).toEqual([]);
      expect(
        text.match(/new URL\(\s*["'][^"']*\.m?ts["']/gu) ?? [],
        file,
      ).toEqual([]);
    }
  });

  it("imports only Node, Effect and its declared peers, and bundles no dependency", () => {
    const peers = Object.keys(manifest.peerDependencies);
    expect(
      filesUnder(inOutput("dist")).filter((file) =>
        file.includes("node_modules"),
      ),
    ).toEqual([]);
    const undeclared = filesUnder(inOutput("dist")).flatMap((file) =>
      specifiersOf(file)
        .filter(
          (specifier) =>
            !isRelative(specifier) &&
            !specifier.startsWith("node:") &&
            !peers.includes(packageOf(specifier)),
        )
        .map((specifier) => `${path.relative(output, file)}: ${specifier}`),
    );
    expect(undeclared).toEqual([]);
  });

  it("keeps cloudflare/stage to effect modules, as Worker bundles import it", () => {
    const reached = [...reachedFrom("./cloudflare/stage")];
    expect(reached.length).toBeGreaterThan(0);
    expect(
      reached.filter((specifier) => !specifier.startsWith("effect/")),
    ).toEqual([]);
  });

  it("keeps every core export clear of Alchemy and Playwright", () => {
    const core = Object.keys(manifest.exports).filter((key) =>
      key.startsWith("./core/"),
    );
    expect(core.length).toBeGreaterThan(0);
    for (const key of core)
      expect(
        [...reachedFrom(key)].filter((specifier) =>
          /^(?:alchemy(?:\/|$)|@alchemy\.run\/|playwright(?:\/|$))/u.test(
            specifier,
          ),
        ),
        key,
      ).toEqual([]);
  });
});

describe("the package as an app installs it", () => {
  const consumer = () => path.join(scratch, "consumer");

  beforeAll(() => {
    const modules = path.join(consumer(), "node_modules");
    fs.mkdirSync(path.join(modules, "@mw10013"), { recursive: true });
    fs.cpSync(output, path.join(modules, "@mw10013/devkit"), {
      recursive: true,
    });
    fs.symlinkSync(
      fs.realpathSync(path.join(SOURCE, "../../node_modules/effect")),
      path.join(modules, "effect"),
    );
    fs.writeFileSync(
      path.join(consumer(), "package.json"),
      JSON.stringify({ name: "consumer", type: "module", private: true }),
    );
  });

  const importFrom = (specifier: string) => {
    try {
      return {
        stdout: execFileSync(
          "node",
          [
            "--input-type=module",
            "--eval",
            `const module = await import(${JSON.stringify(specifier)}); console.log(Object.keys(module).join(","));`,
          ],
          {
            cwd: consumer(),
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        ),
        stderr: "",
      };
    } catch (error) {
      return {
        stdout: "",
        stderr: String((error as { stderr?: unknown }).stderr),
      };
    }
  };

  it("imports an exported module", () => {
    expect(importFrom("@mw10013/devkit/core/app")).toEqual({
      stdout: "NoAppError,app\n",
      stderr: "",
    });
  });

  it("refuses a module the package does not export", () => {
    for (const internal of [
      "core/orphans",
      "core/cli",
      "core/bosun-port",
      "cloudflare/deployed-stage",
      "cloudflare/logs",
      "core/app.mjs",
      "dist/core/app.mjs",
    ])
      expect(
        importFrom(`@mw10013/devkit/${internal}`).stderr,
        internal,
      ).toContain("ERR_PACKAGE_PATH_NOT_EXPORTED");
  });
});
