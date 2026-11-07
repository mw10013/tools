import { definePlugin, defineRule } from "vite-plus/lint/plugins";
// core/lint/conventions.ts
const isEffectModule = (source) => source === "effect" || source.startsWith("effect/");
const effectNamespaceImport = defineRule({
	meta: {
		type: "problem",
		docs: { description: "Import an Effect module as a namespace." },
		messages: { namespace: "Import the Effect module as a namespace and reach `{{name}}` through it: import * as Effect from \"effect/Effect\"." }
	},
	create: (context) => ({ ImportDeclaration: (node) => {
		if (!isEffectModule(node.source.value)) return;
		for (const specifier of node.specifiers) {
			if (specifier.type === "ImportNamespaceSpecifier") continue;
			context.report({
				node: specifier,
				messageId: "namespace",
				data: { name: specifier.local.name }
			});
		}
	} })
});
var conventions_default = definePlugin({
	meta: { name: "conventions" },
	rules: { "effect-namespace-import": effectNamespaceImport }
});
export { conventions_default as default };
