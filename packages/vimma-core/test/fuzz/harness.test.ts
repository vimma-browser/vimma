// The fuzz harness's own failure report (harness.ts). Spec: docs/specs/m7-fuzzing.md.
import { describe, expect, test } from "vitest";
import { replayCommand, within } from "./harness.ts";

describe("fuzz harness", () => {
  // Regression (issue #134): the printed replay filtered with `-t "config-no-throw"`, the failure
  // file's name, which matches no test title, so replaying it ran nothing and passed.
  test("the replay command selects the failing test by its own title", () => {
    const cmd = replayCommand(-1807618252, "18687", "a (b) never throws, on any text");
    expect(cmd).toBe(
      "VIMMA_FUZZ_SEED=-1807618252 VIMMA_FUZZ_PATH=18687 npx vitest run " +
        "packages/vimma-core/test/fuzz -t 'a \\(b\\) never throws, on any text'",
    );
  });

  // The shell gets it in single quotes, so `$` and backslashes reach vitest as written.
  test("the title is passed to -t as a pattern matching only itself", () => {
    const title = "x (y) [z] a.b * c? $d ^e |f {g} \\h it's";
    const quoted = /-t '(.*)'$/.exec(replayCommand(1, "2", title))?.[1] ?? "";
    const pattern = quoted.replaceAll("'\\''", "'");
    expect(new RegExp(pattern).test(title)).toBe(true);
    expect(new RegExp(pattern).test(title.replace(".", "X"))).toBe(false);
  });

  // Issue #196: "took 5046 ms, budget 5000 ms" did not say which of sixteen inputs was slow.
  test("an over-budget case names its input", () => {
    const slow = () => {
      const end = performance.now() + 5;
      while (performance.now() < end);
      return 1;
    };
    expect(() => within(0, slow, "a long unknown key")).toThrow(
      /^a long unknown key: took \d+ ms, budget 0 ms$/,
    );
    expect(within(1000, () => 2, "fast")).toBe(2);
  });
});
