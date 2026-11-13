import { describe, test, expect } from "vitest";
import { createDispatcher } from "../src/dispatcher.mjs";
import { compileKeymap } from "../src/keymap.mjs";
import { parseKey } from "../src/keys.mjs";
import { COUNT_MODES, MODES } from "../src/modes.mjs";
import { resolveEscape } from "../src/escape.mjs";
import { getAction } from "../src/actions.mjs";
import { BADGES } from "../src/theme.mjs";

/** @import { Mode } from "../src/modes.mjs" */

/**
 * Feed space-separated chords; return all results.
 * @param {ReturnType<typeof createDispatcher>} d
 * @param {Mode} mode
 * @param {string} keys
 */
function feed(d, mode, keys) {
  return keys.split(" ").map((k) => d.dispatch(mode, parseKey(k)));
}
/**
 * @template T
 * @param {T[]} arr
 */
const last = (arr) => arr[arr.length - 1];
/** @param {string} id */
const act = (id, extra = {}) => ({ kind: "action", action: { id, ...extra } });
/** @param {Parameters<typeof compileKeymap>[0]} [cfg] */
const make = (cfg) => createDispatcher(compileKeymap(cfg));

describe("resize mode (m4-split-panes sub-spec 5, ADR-014)", () => {
  test("resize is a mode, with counts, and has a status-bar badge", () => {
    expect(MODES).toContain("resize");
    expect(COUNT_MODES.has("resize")).toBe(true);
    expect(BADGES).toContain("resize");
  });

  test("ctrl+b r in normal mode enters resize mode", () => {
    expect(last(feed(make(), "normal", "ctrl+b r"))).toEqual(act("pane.resize_mode"));
  });

  test.each([
    ["h", "pane.resize_narrower"],
    ["left", "pane.resize_narrower"],
    ["<", "pane.resize_narrower"],
    ["l", "pane.resize_wider"],
    ["right", "pane.resize_wider"],
    [">", "pane.resize_wider"],
    ["j", "pane.resize_taller"],
    ["down", "pane.resize_taller"],
    ["plus", "pane.resize_taller"],
    ["k", "pane.resize_shorter"],
    ["up", "pane.resize_shorter"],
    ["minus", "pane.resize_shorter"],
    ["esc", "pane.resize_exit"],
    ["enter", "pane.resize_exit"],
    ["q", "pane.resize_exit"],
  ])("in resize mode, %s runs %s", (key, id) => {
    expect(feed(make(), "resize", key)[0]).toEqual(act(id));
  });

  test("a count repeats a step: 3l", () => {
    expect(last(feed(make(), "resize", "3 l"))).toEqual(act("pane.resize_wider", { count: 3 }));
  });

  test("unbound keys pass (the host consumes them: the mode is modal)", () => {
    expect(feed(make(), "resize", "x")[0]).toEqual({ kind: "pass" });
  });

  test("the prefix layer stays global in resize mode", () => {
    expect(last(feed(make(), "resize", "ctrl+b ?"))).toEqual(act("help.show"));
  });

  test("<C-w> <>+- resize directly in normal mode", () => {
    const d = make();
    expect(last(feed(d, "normal", "ctrl+w >"))).toEqual(act("pane.resize_wider"));
    expect(last(feed(d, "normal", "ctrl+w <"))).toEqual(act("pane.resize_narrower"));
    expect(last(feed(d, "normal", "ctrl+w plus"))).toEqual(act("pane.resize_taller"));
    expect(last(feed(d, "normal", "ctrl+w minus"))).toEqual(act("pane.resize_shorter"));
  });

  test("[modal.resize] rebinds a key in resize mode only", () => {
    const d = make({ modal: { resize: { w: "resize_wider" } } });
    expect(feed(d, "resize", "w")[0]).toEqual(act("pane.resize_wider"));
    expect(feed(d, "normal", "w")[0]).toEqual({ kind: "pass" });
  });

  test("Esc leaves resize mode for the mode it was entered from", () => {
    expect(resolveEscape({ mode: "resize", previous: "normal" })).toEqual({
      kind: "action",
      action: { id: "pane.resize_exit" },
      mode: "normal",
    });
    expect(resolveEscape({ mode: "resize", previous: "insert" })).toMatchObject({ mode: "insert" });
  });

  test("resize_exit is an action, in the Panes group", () => {
    expect(getAction("resize_exit")).toMatchObject({ id: "pane.resize_exit", group: "Panes" });
  });

  test("the help table lists resize mode's keys", () => {
    expect(compileKeymap().bindingsFor("resize_wider")).toEqual(
      expect.arrayContaining(["<C-w>>", "l [resize]", "<Right> [resize]", "> [resize]"]),
    );
  });
});
