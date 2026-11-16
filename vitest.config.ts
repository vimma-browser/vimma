import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/test/**/*.test.mjs",
      "tools/**/test/**/*.test.mjs",
      // TypeScript tools and vimma-core's tests (ADR-025)
      "packages/vimma-core/test/**/*.test.ts",
      "tools/**/test/**/*.test.ts",
    ],
    // A temp dir per run, removed after it; the run fails if a test left anything in it (#207).
    globalSetup: ["tools/test/tmp-guard.mjs"],
    // Same tags as packages/vimma-core/vitest.config.mjs, which says what each is for.
    tags: [
      { name: "timing", description: "Asserts a speed budget of the real, uninstrumented code" },
    ],
    coverage: {
      provider: "v8",
      include: ["packages/vimma-core/src/**/*.mjs"],
      // Third-party code we do not write: its coverage would move our gate on every upstream
      // update. toml-conformance.test.ts still exercises it.
      exclude: ["packages/vimma-core/src/vendor/**"],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
