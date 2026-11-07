/**
 * The house lint rule set: what every app applies to its own code and to the devkit it
 * vendors, and what tools applies to `src/devkit`, so devkit is checked by the rules its
 * consumers enforce. An app spreads {@link lint} into its `vite.config.ts` and adds only its own
 * data: `ignorePatterns`, the website's plugins and rules, and its import boundaries.
 *
 * @module
 */

import { fileURLToPath } from "node:url";

import type { OxlintConfig } from "vite-plus/lint";

/**
 * Effect is consumed one module at a time: `import * as Effect from "effect/Effect"`. The root
 * barrel drags all 160 modules through Vite dev and the Worker bundle.
 */
const effectBarrel = {
  name: "effect",
  message:
    'Import Effect modules by path: import * as Effect from "effect/Effect".',
};

/** A subpackage's index (`effect/rpc`) is a barrel too; its modules have paths: `effect/rpc/RpcClient`. */
const effectSubpackageBarrel = {
  regex: "^effect/[a-z]+$",
  message:
    'Import Effect subpackage modules by path: import * as RpcClient from "effect/rpc/RpcClient".',
};

/**
 * A path that climbs out of its folder names its target by the `package.json` `imports` entry
 * instead: `#backend/auth.ts`, not `../../backend/auth.ts`. The entry says which area the
 * import enters, and it stays valid when the importing file moves.
 */
const parentPath = {
  regex: String.raw`(^|/)\.\.(/|$)`,
  message:
    "Import across folders through a `#` subpath: #backend/…, #domain/…, #test/….",
};

const aliasPath = {
  regex: "^@/",
  message:
    "Import across folders through a `#` subpath: #backend/…, #domain/…, #test/….",
};

/** `#root/*` is for the files that must sit at the repository root; an area's file has its own entry. */
const rootIntoArea = {
  regex: "^#root/(src|test|scripts)/",
  message:
    "Reach an area's file through its own entry: #backend/…, #test/…, #scripts/….",
};

/**
 * The `no-restricted-imports` options every file gets. An override's options replace the
 * base's, so an app's import-boundary override starts from these.
 */
export const baseRestrictions = {
  paths: [effectBarrel],
  patterns: [effectSubpackageBarrel, parentPath, aliasPath, rootIntoArea],
};

/** The house rule set, without an app's website plugins and boundaries. */
export const lint = {
  plugins: ["eslint", "typescript", "unicorn", "oxc"],
  categories: {
    correctness: "error",
    suspicious: "error",
    pedantic: "error",
    perf: "error",
    style: "error",
  },
  env: { builtin: true },
  rules: {
    // Options on enabled rules, and opt-ins beyond the categories.
    // The formatter orders import statements; this orders the names inside one.
    "sort-imports": [
      "error",
      { ignoreDeclarationSort: true, ignoreCase: true },
    ],
    // The default fix splits a mixed import in two, which `no-duplicate-imports` rejects.
    "@typescript-eslint/consistent-type-imports": [
      "error",
      { fixStyle: "inline-type-imports" },
    ],
    "no-underscore-dangle": ["error", { allow: ["_tag"] }],
    "no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
    "@typescript-eslint/ban-ts-comment": [
      "error",
      { minimumDescriptionLength: 10 },
    ],
    "@typescript-eslint/restrict-plus-operands": [
      "error",
      {
        allowAny: false,
        allowBoolean: false,
        allowNullish: false,
        allowNumberAndString: false,
        allowRegExp: false,
      },
    ],
    "@typescript-eslint/restrict-template-expressions": [
      "error",
      {
        allowAny: false,
        allowBoolean: false,
        allowNever: false,
        allowNullish: false,
        allowNumber: false,
        allowRegExp: false,
      },
    ],
    "@typescript-eslint/only-throw-error": [
      "error",
      {
        allow: [
          {
            from: "package",
            package: "@tanstack/router-core",
            name: ["Redirect", "NotFoundError"],
          },
          { from: "lib", name: "Response" },
        ],
      },
    ],
    "@typescript-eslint/return-await": [
      "error",
      "error-handling-correctness-only",
    ],
    "no-empty": "error",
    "no-empty-function": "error",
    "no-regex-spaces": "error",
    "no-unused-expressions": "error",
    "@typescript-eslint/no-dynamic-delete": "error",
    "@typescript-eslint/no-empty-object-type": "error",
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-import-type-side-effects": "error",
    "@typescript-eslint/no-invalid-void-type": "error",
    "@typescript-eslint/no-namespace": "error",
    "@typescript-eslint/no-non-null-asserted-nullish-coalescing": "error",
    "@typescript-eslint/no-non-null-assertion": "error",
    "@typescript-eslint/no-require-imports": "error",
    "@typescript-eslint/non-nullable-type-assertion-style": "error",
    "@typescript-eslint/prefer-literal-enum-member": "error",
    "@typescript-eslint/use-unknown-in-catch-callback-variable": "error",
    "vite-plus/prefer-vite-plus-imports": "error",
    "conventions/effect-namespace-import": "error",
    "no-restricted-imports": ["error", baseRestrictions],

    // Off: misreads Effect (pipeable data-last calls, `Effect.gen` and `Effect.fn` bodies,
    // capitalized constructors such as `Schema.Struct`, `Effect.succeed(undefined)`).
    "unicorn/no-array-method-this-argument": "off",
    "unicorn/no-array-callback-reference": "off",
    "unicorn/consistent-function-scoping": "off",
    "unicorn/max-nested-calls": "off",
    "unicorn/no-useless-undefined": "off",
    "unicorn/catch-error-name": "off",
    "@typescript-eslint/consistent-return": "off",
    "@typescript-eslint/strict-void-return": "off",
    "new-cap": "off",
    "func-names": "off",
    "func-style": "off",
    "require-await": "off",

    // Off: contradicts house style.
    "no-ternary": "off",
    "no-nested-ternary": "off",
    "unicorn/no-nested-ternary": "off",
    "unicorn/no-null": "off",
    "unicorn/throw-new-error": "off",
    "unicorn/no-await-expression-member": "off",
    "unicorn/prefer-global-this": "off",
    "unicorn/text-encoding-identifier-case": "off",
    "unicorn/filename-case": "off",
    "@typescript-eslint/strict-boolean-expressions": "off",
    "@typescript-eslint/no-unsafe-type-assertion": "off",
    "typescript/prefer-readonly-parameter-types": "off",
    "sort-keys": "off",
    "no-magic-numbers": "off",
    "no-negated-condition": "off",
    "no-continue": "off",
    "no-shadow": "off",
    "no-inline-comments": "off",
    "no-implicit-coercion": "off",
    "capitalized-comments": "off",
    "arrow-body-style": "off",
    "prefer-destructuring": "off",
    "init-declarations": "off",
    "one-var": "off",
    "id-length": "off",
    "max-params": "off",
    "max-lines": "off",
    "max-lines-per-function": "off",
    "max-classes-per-file": "off",
    "max-statements": "off",
    "jsx-max-depth": "off",
    "jsx-props-no-spreading": "off",
    "no-unescaped-entities": "off",
    "no-await-in-loop": "off",
    "oxc/no-map-spread": "off",
    "jsx-handler-names": "off",

    // Off: the formatter or the JSX transform owns it.
    curly: "off",
    "unicorn/number-literal-case": "off",
    "react-in-jsx-scope": "off",
  },
  jsPlugins: [
    { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
    fileURLToPath(new URL("conventions.ts", import.meta.url)),
  ],
  overrides: [
    {
      // The core rules TypeScript already checks, as `typescript-eslint`'s `eslint-recommended` sets them.
      files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
      rules: {
        "constructor-super": "off",
        "no-class-assign": "off",
        "no-const-assign": "off",
        "no-dupe-class-members": "off",
        "no-dupe-keys": "off",
        "no-func-assign": "off",
        "no-import-assign": "off",
        "no-new-native-nonconstructor": "off",
        "no-obj-calls": "off",
        "no-redeclare": "off",
        "no-setter-return": "off",
        "no-this-before-super": "off",
        "no-unsafe-negation": "off",
        "no-var": "error",
        "no-with": "off",
        "prefer-const": "error",
        "prefer-rest-params": "error",
        "prefer-spread": "error",
      },
    },
  ],
  options: {
    typeAware: true,
    typeCheck: true,
    reportUnusedDisableDirectives: "error",
  },
} satisfies OxlintConfig;
