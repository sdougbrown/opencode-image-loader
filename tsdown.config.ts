import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  sourcemap: true,
  format: ["esm"],
  target: "esnext",
  dts: true,
  clean: true,
  platform: "node",
  external: [
    "@opencode-ai/plugin",
    "@opencode-ai/plugin/tool",
  ],
});
