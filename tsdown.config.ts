import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/main.ts"],

  format: ["esm"],
  target: "es2022",
  platform: "node",

  sourcemap: true,
  clean: true,
  removeNodeProtocol: false,

  // Keep gpt-tokenizer external since it uses dynamic imports for encodings
  external: ["gpt-tokenizer", "bun:sqlite"],

  env: {
    NODE_ENV: "production",
  },
})
