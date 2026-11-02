import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Convex functions are tested in the edge-runtime environment that the
    // Convex backend actually uses, so Web Crypto, Headers, etc. behave the same.
    environment: "edge-runtime",
    include: ["convex/**/*.test.ts"],
    server: { deps: { inline: ["convex-test"] } },
  },
});
