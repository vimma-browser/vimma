// The keymap's check on the built-in [modal.*] tables (#1119, mutation testing): two default keys
// written differently for one sequence must name one action. The shipped defaults never trip it,
// so this file compiles the keymap over defaults with extra keys: in normal mode two that name
// one action, then in visual mode (checked after normal) two that name two actions.
import { describe, test, expect, vi } from "vitest";
import { compileKeymap } from "../src/keys/keymap.mjs";

import type * as Defaults from "../src/config/defaults.mjs";

vi.mock("../src/config/defaults.mjs", async (importOriginal) => {
  const real = await importOriginal<typeof Defaults>();
  const modal = real.DEFAULT_CONFIG.modal as unknown as Record<string, Record<string, string>>;
  return {
    ...real,
    DEFAULT_CONFIG: {
      ...real.DEFAULT_CONFIG,
      modal: {
        ...modal,
        normal: { ...modal.normal, "<C-x>": "new_tab", "ctrl+x": "new_tab" },
        visual: { ...modal.visual, "<C-x>": "new_tab", "ctrl+x": "close_tab" },
      },
    },
  };
});

describe("two default keys for one sequence", () => {
  test("naming one action is one binding; naming two is an error at the second", () => {
    // The error names visual mode: normal mode's pair, checked first, is no conflict.
    expect(() => compileKeymap()).toThrow(
      'modal.visual."ctrl+x": "ctrl+x" is already bound to new_tab',
    );
  });
});
