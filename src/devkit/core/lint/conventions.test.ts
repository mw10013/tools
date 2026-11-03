import { describe, it } from "vite-plus/test";
import { RuleTester } from "vite-plus/lint/plugins-dev";

import conventions from "./conventions.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: { sourceType: "module", parserOptions: { lang: "ts" } },
});

tester.run(
  "effect-namespace-import",
  conventions.rules["effect-namespace-import"],
  {
    valid: [
      'import * as Effect from "effect/Effect";',
      'import type * as Schema from "effect/Schema";',
      'import * as RpcClient from "effect/unstable/rpc/RpcClient";',
      'import { describe } from "@effect/vitest";',
    ],
    invalid: [
      { code: 'import { constVoid } from "effect/Function";', errors: 1 },
      { code: 'import type { X } from "effect/Schema";', errors: 1 },
      { code: 'import { type X, pipe } from "effect/Function";', errors: 2 },
      { code: 'import Effect from "effect";', errors: 1 },
    ],
  },
);
