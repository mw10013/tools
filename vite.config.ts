import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: { printWidth: 80 },
  lint: {
    options: { typeAware: true, typeCheck: true },
  },
});
