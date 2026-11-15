import bodyRequired, { ignoreCommit } from "./tools/commitlint/body-required.ts";

export default {
  extends: ["@commitlint/config-conventional"],
  plugins: [bodyRequired],
  // The defaults skip every `Revert "…"`; ours lint body-less reverts (tools/commitlint).
  defaultIgnores: false,
  ignores: [ignoreCommit],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "perf",
        "refactor",
        "test",
        "docs",
        "chore",
        "deps",
        "upstream",
        "ci",
        "build",
        "revert",
      ],
    ],
    // The subject is the changelog line; the body explains why (CONTRIBUTING.md). feat, fix and
    // reverts must have a body.
    // Footers (`Closes #3`, `BREAKING CHANGE:`) and trailers do not count as a body.
    "body-required-for-types": [2, "always", ["feat", "fix", "revert"]],
  },
};
