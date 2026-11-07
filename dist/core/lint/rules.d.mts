/**
 * The house lint rule set: what every app applies to its own code and to the devkit it
 * vendors, and what tools applies to `src/devkit`, so devkit is checked by the rules its
 * consumers enforce. An app spreads {@link lint} into its `vite.config.ts` and adds only its own
 * data: `ignorePatterns`, the website's plugins and rules, and its import boundaries.
 *
 * The `conventions` plugin is named by package specifier. A path built from `import.meta.url`
 * would name a `.ts` file the built package does not contain. Oxlint resolves the specifier from
 * the config that spreads {@link lint}, so that config's package depends on `@mw10013/devkit`:
 * an app and the monorepo root install it, and tools links `src/devkit`.
 *
 * @module
 */
/**
 * The `no-restricted-imports` options every file gets. An override's options replace the
 * base's, so an app's import-boundary override starts from these.
 */
export declare const baseRestrictions: {
  paths: {
    name: string;
    message: string;
  }[];
  patterns: {
    regex: string;
    message: string;
  }[];
};
/** The house rule set, without an app's website plugins and boundaries. */
export declare const lint: {
  plugins: ("eslint" | "oxc" | "typescript" | "unicorn")[];
  categories: {
    correctness: "error";
    suspicious: "error";
    pedantic: "error";
    perf: "error";
    style: "error";
  };
  env: {
    builtin: true;
  };
  rules: {
    "sort-imports": ["error", {
      ignoreDeclarationSort: true;
      ignoreCase: true;
    }];
    "@typescript-eslint/consistent-type-imports": ["error", {
      fixStyle: "inline-type-imports";
    }];
    "no-underscore-dangle": ["error", {
      allow: string[];
    }];
    "no-unused-vars": ["error", {
      argsIgnorePattern: string;
      varsIgnorePattern: string;
    }];
    "@typescript-eslint/ban-ts-comment": ["error", {
      minimumDescriptionLength: number;
    }];
    "@typescript-eslint/restrict-plus-operands": ["error", {
      allowAny: false;
      allowBoolean: false;
      allowNullish: false;
      allowNumberAndString: false;
      allowRegExp: false;
    }];
    "@typescript-eslint/restrict-template-expressions": ["error", {
      allowAny: false;
      allowBoolean: false;
      allowNever: false;
      allowNullish: false;
      allowNumber: false;
      allowRegExp: false;
    }];
    "@typescript-eslint/only-throw-error": ["error", {
      allow: ({
        from: "package";
        package: string;
        name: string[];
      } | {
        package?: undefined;
        from: "lib";
        name: string;
      })[];
    }];
    "@typescript-eslint/return-await": ["error", "error-handling-correctness-only"];
    "no-empty": "error";
    "no-empty-function": "error";
    "no-regex-spaces": "error";
    "no-unused-expressions": "error";
    "@typescript-eslint/no-dynamic-delete": "error";
    "@typescript-eslint/no-empty-object-type": "error";
    "@typescript-eslint/no-explicit-any": "error";
    "@typescript-eslint/no-import-type-side-effects": "error";
    "@typescript-eslint/no-invalid-void-type": "error";
    "@typescript-eslint/no-namespace": "error";
    "@typescript-eslint/no-non-null-asserted-nullish-coalescing": "error";
    "@typescript-eslint/no-non-null-assertion": "error";
    "@typescript-eslint/no-require-imports": "error";
    "@typescript-eslint/non-nullable-type-assertion-style": "error";
    "@typescript-eslint/prefer-literal-enum-member": "error";
    "@typescript-eslint/use-unknown-in-catch-callback-variable": "error";
    "vite-plus/prefer-vite-plus-imports": "error";
    "conventions/effect-namespace-import": "error";
    "no-restricted-imports": ["error", {
      paths: {
        name: string;
        message: string;
      }[];
      patterns: {
        regex: string;
        message: string;
      }[];
    }];
    "unicorn/no-array-method-this-argument": "off";
    "unicorn/no-array-callback-reference": "off";
    "unicorn/consistent-function-scoping": "off";
    "unicorn/max-nested-calls": "off";
    "unicorn/no-useless-undefined": "off";
    "unicorn/catch-error-name": "off";
    "@typescript-eslint/consistent-return": "off";
    "@typescript-eslint/strict-void-return": "off";
    "new-cap": "off";
    "func-names": "off";
    "func-style": "off";
    "require-await": "off";
    "no-ternary": "off";
    "no-nested-ternary": "off";
    "unicorn/no-nested-ternary": "off";
    "unicorn/no-null": "off";
    "unicorn/throw-new-error": "off";
    "unicorn/no-await-expression-member": "off";
    "unicorn/prefer-global-this": "off";
    "unicorn/text-encoding-identifier-case": "off";
    "unicorn/filename-case": "off";
    "@typescript-eslint/strict-boolean-expressions": "off";
    "@typescript-eslint/no-unsafe-type-assertion": "off";
    "typescript/prefer-readonly-parameter-types": "off";
    "sort-keys": "off";
    "no-magic-numbers": "off";
    "no-negated-condition": "off";
    "no-continue": "off";
    "no-shadow": "off";
    "no-inline-comments": "off";
    "no-implicit-coercion": "off";
    "capitalized-comments": "off";
    "arrow-body-style": "off";
    "prefer-destructuring": "off";
    "init-declarations": "off";
    "one-var": "off";
    "id-length": "off";
    "max-params": "off";
    "max-lines": "off";
    "max-lines-per-function": "off";
    "max-classes-per-file": "off";
    "max-statements": "off";
    "jsx-max-depth": "off";
    "jsx-props-no-spreading": "off";
    "no-unescaped-entities": "off";
    "no-await-in-loop": "off";
    "oxc/no-map-spread": "off";
    "jsx-handler-names": "off";
    curly: "off";
    "unicorn/number-literal-case": "off";
    "react-in-jsx-scope": "off";
  };
  jsPlugins: {
    name: string;
    specifier: string;
  }[];
  overrides: {
    files: string[];
    rules: {
      "constructor-super": "off";
      "no-class-assign": "off";
      "no-const-assign": "off";
      "no-dupe-class-members": "off";
      "no-dupe-keys": "off";
      "no-func-assign": "off";
      "no-import-assign": "off";
      "no-new-native-nonconstructor": "off";
      "no-obj-calls": "off";
      "no-redeclare": "off";
      "no-setter-return": "off";
      "no-this-before-super": "off";
      "no-unsafe-negation": "off";
      "no-var": "error";
      "no-with": "off";
      "prefer-const": "error";
      "prefer-rest-params": "error";
      "prefer-spread": "error";
    };
  }[];
  options: {
    typeAware: true;
    typeCheck: true;
    reportUnusedDisableDirectives: "error";
  };
};