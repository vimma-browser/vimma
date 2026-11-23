// `vimma_keys` over a key that is both a binding and the start of a longer one (#1119, mutation
// testing; docs/specs/mcp-drive.md D9, D10; security.md M16). Vimma's defaults bind no such key in
// normal mode, so this file compiles the agent's keymap over defaults with two extra: `g` alone
// (scroll.top, whitelisted) beside `gg` and the other g keys, and `y` alone (page.reload, refused)
// beside `yy`. The dispatcher then runs the shorter binding when the next key does not continue
// it, and a sequence the keys end on resolves as it would after the timeout.
import { describe, expect, test, vi } from "vitest";
import { parseAgentKeys } from "../src/agent/agent-keys.mjs";

import type * as Defaults from "../src/config/defaults.mjs";

vi.mock("../src/config/defaults.mjs", async (importOriginal) => {
  const real = await importOriginal<typeof Defaults>();
  const modal = real.DEFAULT_CONFIG.modal as unknown as Record<string, Record<string, string>>;
  return {
    ...real,
    DEFAULT_CONFIG: {
      ...real.DEFAULT_CONFIG,
      modal: { ...modal, normal: { ...modal.normal, g: "scroll.top", y: "page.reload" } },
    },
  };
});

describe("a key that is a binding and the start of a longer one (M16)", () => {
  test("the next key that does not continue it runs it, and is a key of its own", () => {
    expect(parseAgentKeys("gj")).toStrictEqual({
      ok: true,
      steps: [
        { keys: "g", action: "scroll.top" },
        { keys: "j", action: "scroll.down" },
      ],
    });
  });

  test("the longer binding still wins when the keys continue it", () => {
    expect(parseAgentKeys("ggj")).toStrictEqual({
      ok: true,
      steps: [
        { keys: "gg", action: "scroll.top" },
        { keys: "j", action: "scroll.down" },
      ],
    });
  });

  test("a refused shorter binding refuses the keys, and nothing after it runs", () => {
    expect(parseAgentKeys("yj")).toStrictEqual({
      ok: false,
      error: 'key "y" (page.reload) is refused: a reload can send a form again',
    });
  });

  test("keys that end on it run it", () => {
    expect(parseAgentKeys("j g")).toStrictEqual({
      ok: true,
      steps: [
        { keys: "j", action: "scroll.down" },
        { keys: "g", action: "scroll.top" },
      ],
    });
  });

  test("keys that end on a refused one are refused", () => {
    expect(parseAgentKeys("j y")).toStrictEqual({
      ok: false,
      error: 'key "y" (page.reload) is refused: a reload can send a form again',
    });
  });
});
