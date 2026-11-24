// Hovering an element with a hint (docs/specs/hover.md): the pure half.
import { describe, test, expect } from "vitest";
import { resolveEscape } from "../src/keys/escape.mjs";
import {
  HINT_ACTIONS,
  HOVER_KINDS,
  hoverStatusText,
  innermostHover,
  parseHintReply,
  parseHoverReply,
  startHints,
} from "../src/page/hints.mjs";
import { getAction, resolveActionName } from "../src/keys/actions.mjs";
import { compileKeymap } from "../src/keys/keymap.mjs";
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs";
import { statusAnnouncement, statusSegments, fitStatus } from "../src/ui/statusbar.mjs";

const rect = { x: 1, y: 2, width: 30, height: 10 };
const reply = (targets: unknown[]) => ({ targets, frames: [], ms: 1 });

describe("hint.hover and hover.release", () => {
  test("hint.hover is a hint action that startHints accepts", () => {
    expect(HINT_ACTIONS).toContain("hint.hover");
    const s = startHints([{ rect }], { action: "hint.hover" });
    expect(s.action).toBe("hint.hover");
  });

  test("both are actions in Hints, under their config names", () => {
    expect(getAction("hover_element")).toMatchObject({ id: "hint.hover", group: "Hints" });
    expect(getAction("hover_release")).toMatchObject({ id: "hover.release", group: "Hints" });
    expect(resolveActionName("hint.hover")?.name).toBe("hover_element");
  });

  test("gh hovers in normal mode, and hover.release is unbound (decision 14)", () => {
    const keymap = compileKeymap();
    expect(keymap.bindingsFor("hover_element")).toEqual(["gh"]);
    expect(keymap.bindingsFor("hover_release")).toEqual([]);
    // gh collides with no other default: it is the only binding on that sequence.
    const normal = (DEFAULT_CONFIG.modal as unknown as { normal: Record<string, string> }).normal;
    const onGh = Object.entries(normal).filter(([k]) => k === "gh" || k === "g");
    expect(onGh).toEqual([["gh", "hint.hover"]]);
  });
});

describe("resolveEscape while a hover is held (decision 5)", () => {
  test("normal mode: Esc releases the hover after the page, and still blurs", () => {
    expect(resolveEscape({ mode: "normal", hovering: true })).toEqual({
      kind: "action",
      action: { id: "hover.release" },
      mode: "normal",
      afterPage: true,
      blur: true,
    });
  });

  test("without a hover, Esc stops the page as before", () => {
    expect(resolveEscape({ mode: "normal", hovering: false })).toMatchObject({
      action: { id: "page.stop" },
    });
  });

  test("a pending key is cancelled first; other modes leave as before", () => {
    expect(resolveEscape({ mode: "normal", pending: true, hovering: true })).toEqual({
      kind: "cancel",
      mode: "normal",
    });
    expect(resolveEscape({ mode: "insert", hovering: true })).toMatchObject({
      action: { id: "mode.normal" },
    });
    expect(resolveEscape({ mode: "hint", hovering: true })).toMatchObject({
      action: { id: "hint.cancel" },
    });
  });
});

describe("parseHintReply for a hover collection (decision 4)", () => {
  test("takes kind hover with each sub-kind", () => {
    for (const hoverKind of HOVER_KINDS) {
      const r = parseHintReply(reply([{ id: 0, rect, kind: "hover", hoverKind }]), {
        hover: true,
      });
      expect(r?.targets).toEqual([{ id: 0, rect, kind: "hover", hoverKind }]);
    }
    expect(HOVER_KINDS).toEqual(["link", "click", "input", "listener", "block"]);
  });

  test("refuses an unknown or missing sub-kind, another kind, and extra fields", () => {
    const bad = [
      { id: 0, rect, kind: "hover", hoverKind: "menu" },
      { id: 0, rect, kind: "hover" },
      { id: 0, rect, kind: "click" },
      { id: 0, rect, kind: "hover", hoverKind: "link", href: "https://example.com/" },
      { id: 0, rect, kind: "hover", hoverKind: "block", blockKind: "paragraph", box: rect },
    ];
    for (const t of bad) expect(parseHintReply(reply([t]), { hover: true })).toBeNull();
  });

  test("a hover target is refused in every other collection", () => {
    const t = { id: 0, rect, kind: "hover", hoverKind: "click" };
    expect(parseHintReply(reply([t]))).toBeNull();
    expect(parseHintReply(reply([t]), { blocks: true })).toBeNull();
    expect(parseHintReply(reply([t]), { texts: true })).toBeNull();
  });
});

describe("innermostHover: overlapping hover targets (decision 4)", () => {
  // Each candidate names the nearest candidate around it (-1: none).
  test("a block or a listener element holding another target gets no label", () => {
    const keep = innermostHover([
      { kind: "block", parent: -1 }, // a paragraph
      { kind: "link", parent: 0 }, // a link in it
      { kind: "listener", parent: -1 }, // a row with a mouseenter listener
      { kind: "block", parent: 2 }, // the row's text
      { kind: "block", parent: -1 }, // a paragraph with nothing inside
    ]);
    expect(keep).toEqual([false, true, false, true, true]);
  });

  test("f's own targets keep their labels when they hold another target", () => {
    const keep = innermostHover([
      { kind: "click", parent: -1 }, // a button
      { kind: "block", parent: 0 }, // text in it
      { kind: "input", parent: -1 },
    ]);
    expect(keep).toEqual([true, true, true]);
  });

  test("the rule reaches through levels: a block yields to a target two levels down", () => {
    const keep = innermostHover([
      { kind: "block", parent: -1 },
      { kind: "listener", parent: 0 },
      { kind: "link", parent: 1 },
    ]);
    expect(keep).toEqual([false, false, true]);
  });

  test("a parent index that points nowhere valid is ignored", () => {
    expect(innermostHover([{ kind: "block", parent: 7 }])).toEqual([true]);
    expect(innermostHover([{ kind: "block", parent: 0 }])).toEqual([true]);
  });
});

describe("parseHoverReply: the child's answer to a hover", () => {
  test("a hovered element's text, cleaned and cut at 40 columns", () => {
    expect(parseHoverReply({ hovered: true, text: "  Settings\u0007 gear\n" })).toEqual({
      hovered: true,
      text: "Settings gear",
    });
    const long = "x".repeat(100);
    expect(parseHoverReply({ hovered: true, text: long })?.text).toBe(`${"x".repeat(39)}…`);
  });

  test("refuses anything else", () => {
    for (const v of [null, 1, "x", [], { hovered: "yes", text: "" }, { hovered: true }]) {
      expect(parseHoverReply(v)).toBeNull();
    }
    expect(parseHoverReply({ hovered: false })).toEqual({ hovered: false, text: "" });
  });

  test("hoverStatusText drops control and format characters", () => {
    expect(hoverStatusText("a‮b\u0000c​d")).toBe("abcd");
  });
});

describe("the status bar's hover segment (decision 8)", () => {
  const tab = {
    index: 1,
    count: 1,
    title: "A page with rows",
    url: "https://example.com/rows",
  };

  test("hover · text for the user's hover, agent hover · text for an agent's", () => {
    const user = statusSegments({ mode: "normal", hover: { text: "Row one", agent: false } });
    expect(user.find((s) => s.id === "hover")?.text).toBe("hover · Row one");
    const agent = statusSegments({ mode: "normal", hover: { text: "Row one", agent: true } });
    expect(agent.find((s) => s.id === "hover")?.text).toBe("agent hover · Row one");
    expect(statusSegments({ mode: "normal" }).some((s) => s.id === "hover")).toBe(false);
  });

  test("gives way before the title and the URL", () => {
    const segs = statusSegments({ mode: "normal", tab, hover: { text: "Row one", agent: false } });
    const ids = (width: number) => fitStatus(segs, width).map((s) => s.id);
    expect(ids(200)).toEqual(expect.arrayContaining(["hover", "title", "url"]));
    for (let width = 0; width < 200; width++) {
      const shown = ids(width);
      if (shown.includes("hover")) expect(shown).toEqual(expect.arrayContaining(["title", "url"]));
    }
    const widths = [...Array(200).keys()];
    expect(widths.some((w) => ids(w).includes("title") && !ids(w).includes("hover"))).toBe(true);
  });

  test("the live region says hovering <text> once per hover, and nothing on release", () => {
    const quiet = { mode: "normal" as const, notFound: null };
    const hover = { text: "Row one", agent: false, seq: 1 };
    const first = statusAnnouncement(quiet, { mode: "normal", hover });
    expect(first.text).toBe("hovering Row one");
    expect(statusAnnouncement(first.last, { mode: "normal", hover }).text).toBeNull();
    const next = { ...hover, seq: 2 };
    expect(statusAnnouncement(first.last, { mode: "normal", hover: next }).text).toBe(
      "hovering Row one",
    );
    expect(statusAnnouncement(first.last, { mode: "normal", hover: null }).text).toBeNull();
  });
});
