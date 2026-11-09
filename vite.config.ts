import { lint } from "@mw10013/rigging/core/lint/rules";
import { defineConfig } from "vite-plus";

export default defineConfig(({ command, isPreview }) => {
  if (
    command === "serve" &&
    isPreview === false &&
    process.env.VITEST !== "true" &&
    process.env.VP_RUN !== "1"
  ) {
    throw new Error("Use `vp run dev` to start the project dev server.");
  }

  return {
    // Evidence is kept as captured.
    fmt: {
      printWidth: 80,
      sortImports: true,
      ignorePatterns: ["docs/evidence/**"],
    },
    test: { include: ["src/**/*.test.ts"] },
    lint,
  };
});
