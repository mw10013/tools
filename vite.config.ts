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
    fmt: { printWidth: 80 },
    test: { include: ["src/**/*.test.ts"] },
    lint: {
      options: { typeAware: true, typeCheck: true },
    },
  };
});
