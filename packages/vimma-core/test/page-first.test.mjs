import { describe, test, expect } from "vitest";
import { PAGE_FIRST_MAX, PageFirstQueue } from "../src/page-first.mjs";

/** A queue with one deferred binding per key, its result named after the key and mode. */
function queue(...keys) {
  const q = new PageFirstQueue();
  for (const [key, mode = "normal"] of keys) q.defer(key, `${key}@${mode}`, mode);
  return q;
}

describe("PageFirstQueue (docs/specs/firefox-keys.md decision 6)", () => {
  test("Given a key sent to a remote page, when its reply comes, then it settles that press", () => {
    const q = queue(["meta+l"]);
    expect(q.press("meta+l", 10, true)).toBe(true);
    expect(q.reply("meta+l", 10)).toMatchObject({ result: "meta+l@normal", mode: "normal" });
    expect(q.size).toBe(0);
  });

  test("Given a press the page took (no reply comes), when a later press of the key replies, then the reply settles the later press", () => {
    const q = queue(["meta+left", "normal"]);
    q.press("meta+left", 10, true);
    q.keydown();
    q.defer("meta+left", "meta+left@insert", "insert");
    q.press("meta+left", 20, true);
    expect(q.reply("meta+left", 20)).toMatchObject({ result: "meta+left@insert", mode: "insert" });
    expect(q.reply("meta+left", 10)).toMatchObject({ mode: "normal" });
  });

  test("Given two presses of a key waiting, when their replies come out of order, then each settles its own", () => {
    const q = queue(["meta+2"]);
    q.press("meta+2", 10, true);
    q.keydown();
    q.defer("meta+2", "second", "insert");
    q.press("meta+2", 20, true);
    expect(q.reply("meta+2", 20)).toMatchObject({ result: "second" });
    expect(q.reply("meta+2", 10)).toMatchObject({ result: "meta+2@normal" });
  });

  test("Given a reply no press asked for, then it settles nothing", () => {
    const q = queue(["meta+l"]);
    q.press("meta+l", 10, true);
    expect(q.reply("meta+l", 11)).toBeNull();
    expect(q.reply("meta+k", 10)).toBeNull();
    expect(q.size).toBe(1);
  });

  test("Given a keypress Firefox's shortcut listener held back, when its reply comes, then it settles the unpressed binding", () => {
    // GlobalKeyListener asks for the reply itself: the keypress never reached `press`.
    const q = queue(["ctrl+shift+z"]);
    expect(q.reply("ctrl+shift+z", 10)).toMatchObject({ result: "ctrl+shift+z@normal" });
  });

  test("Given a page whose process is still starting, when the keypress comes back to the browser, then the press settles here", () => {
    const q = queue(["meta+l"]);
    q.press("meta+l", 10, true);
    // EventStateManager::PostHandleKeyboardEvent dispatches the same keypress again.
    expect(q.press("meta+l", 10, true)).toBe(false);
    expect(q.settle("meta+l")).toMatchObject({ result: "meta+l@normal" });
    expect(q.reply("meta+l", 10)).toBeNull();
  });

  test("Given a keypress that stayed in this process, then it settles after the page and waits for no reply", () => {
    const q = queue(["meta+l"]);
    expect(q.press("meta+l", 10, false)).toBe(false);
    expect(q.settle("meta+l")).toMatchObject({ result: "meta+l@normal" });
    expect(q.size).toBe(0);
  });

  test("Given a binding whose keypress never came, when the next keydown comes, then it is dropped, and one waiting for a reply is kept", () => {
    const q = queue(["meta+l"], ["meta+2"]);
    q.press("meta+2", 10, true);
    q.keydown();
    expect(q.size).toBe(1);
    expect(q.reply("meta+2", 10)).toMatchObject({ result: "meta+2@normal" });
  });

  test(`Given more than ${PAGE_FIRST_MAX} presses waiting, then the oldest is dropped`, () => {
    const q = new PageFirstQueue();
    for (let i = 0; i <= PAGE_FIRST_MAX; i++) {
      q.defer("meta+l", i, "normal");
      q.press("meta+l", i, true);
      q.keydown();
    }
    expect(q.size).toBe(PAGE_FIRST_MAX);
    expect(q.reply("meta+l", 0)).toBeNull();
    expect(q.reply("meta+l", PAGE_FIRST_MAX)).toMatchObject({ result: PAGE_FIRST_MAX });
  });
});
