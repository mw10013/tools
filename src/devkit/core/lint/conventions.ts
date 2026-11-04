import { definePlugin, defineRule } from "vite-plus/lint/plugins";

const isEffectModule = (source: string) =>
  source === "effect" || source.startsWith("effect/");

// `no-restricted-imports` cannot express this: its import-name options also reject the namespace import.
const effectNamespaceImport = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Import an Effect module as a namespace." },
    messages: {
      namespace:
        'Import the Effect module as a namespace and reach `{{name}}` through it: import * as Effect from "effect/Effect".',
    },
  },
  create: (context) => ({
    ImportDeclaration: (node) => {
      if (!isEffectModule(node.source.value)) return;
      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportNamespaceSpecifier") continue;
        context.report({
          node: specifier,
          messageId: "namespace",
          data: { name: specifier.local.name },
        });
      }
    },
  }),
});

export default definePlugin({
  meta: { name: "conventions" },
  rules: { "effect-namespace-import": effectNamespaceImport },
});
