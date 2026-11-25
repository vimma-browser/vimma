// Choosing which scroll area the scroll keys move (docs/specs/scroll-area.md, issue #1526): the
// frames' replies checked, the areas put in reading order, and the area `gs`, `gS` and a count
// pick.
import { describe, test, expect } from "vitest";
import {
  SCROLL_AREA_MAX_FRAMES,
  SCROLL_AREA_MAX_PER_FRAME,
  currentScrollArea,
  nextScrollArea,
  orderScrollAreas,
  parseScrollAreasReply,
} from "../src/page/scroll-areas.mjs";
import { statusSegments } from "../src/ui/statusbar.mjs";
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs";
import { ACTIONS } from "../src/keys/actions.mjs";

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const viewport = { width: 1000, height: 800 };

describe("parseScrollAreasReply: a content process's reply, checked", () => {
  test("a well-formed reply comes back as a fresh copy", () => {
    const raw = {
      viewport: rect(0, 0, 1000, 800),
      areas: [{ rect: rect(0, 0, 300, 800), current: false, chosen: true }],
      frames: [{ id: 12, rect: rect(300, 0, 700, 800) }],
    };
    const r = parseScrollAreasReply(raw);
    expect(r).toEqual(raw);
    expect(r?.areas[0]).not.toBe(raw.areas[0]);
  });

  test("anything malformed drops the reply", () => {
    for (const bad of [
      null,
      7,
      [],
      { areas: [], frames: [] },
      { viewport: rect(0, 0, Infinity, 1), areas: [], frames: [] },
      { viewport: rect(0, 0, 1, 1), areas: "x", frames: [] },
      { viewport: rect(0, 0, 1, 1), areas: [], frames: {} },
      {
        viewport: rect(0, 0, 1, 1),
        areas: [{ rect: rect(0, 0, NaN, 1), current: false, chosen: false }],
        frames: [],
      },
      {
        viewport: rect(0, 0, 1, 1),
        areas: [{ rect: rect(0, 0, -1, 1), current: false, chosen: false }],
        frames: [],
      },
      {
        viewport: rect(0, 0, 1, 1),
        areas: [{ rect: rect(0, 0, 1, 1), current: "yes", chosen: false }],
        frames: [],
      },
      { viewport: rect(0, 0, 1, 1), areas: [], frames: [{ id: "12", rect: rect(0, 0, 1, 1) }] },
      { viewport: rect(0, 0, 1, 1), areas: [], frames: [{ id: 1.5, rect: rect(0, 0, 1, 1) }] },
    ]) {
      expect(parseScrollAreasReply(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  test("at most a frame's share of areas and subframes is kept", () => {
    const area = { rect: rect(0, 0, 10, 10), current: false, chosen: false };
    const frame = { id: 1, rect: rect(0, 0, 10, 10) };
    const r = parseScrollAreasReply({
      viewport: rect(0, 0, 10, 10),
      areas: Array(SCROLL_AREA_MAX_PER_FRAME + 5).fill(area),
      frames: Array(SCROLL_AREA_MAX_FRAMES + 5).fill(frame),
    });
    expect(r?.areas).toHaveLength(SCROLL_AREA_MAX_PER_FRAME);
    expect(r?.frames).toHaveLength(SCROLL_AREA_MAX_FRAMES);
  });

  test("at most one area of a frame is current and one chosen", () => {
    const r = parseScrollAreasReply({
      viewport: rect(0, 0, 10, 10),
      areas: [
        { rect: rect(0, 0, 10, 10), current: true, chosen: true },
        { rect: rect(0, 0, 10, 10), current: true, chosen: true },
      ],
      frames: [],
    });
    expect(r?.areas.map((a) => [a.current, a.chosen])).toEqual([
      [true, true],
      [false, false],
    ]);
  });
});

describe("orderScrollAreas: the areas that count, in reading order", () => {
  test("a Confluence-like page: the tree on the left comes before the page on the right", () => {
    const content = { rect: rect(300, 56, 700, 744), key: "content" };
    const tree = { rect: rect(0, 56, 300, 744), key: "tree" };
    expect(orderScrollAreas([content, tree], viewport).map((a) => a.key)).toEqual([
      "tree",
      "content",
    ]);
  });

  test("left to right, then top to bottom; a containing area before the ones inside it", () => {
    const page = { rect: rect(0, 0, 1000, 800), key: "page" };
    const top = { rect: rect(0, 0, 400, 300), key: "top-left" };
    const below = { rect: rect(0, 400, 400, 300), key: "bottom-left" };
    const right = { rect: rect(500, 0, 500, 800), key: "right" };
    expect(orderScrollAreas([right, below, page, top], viewport).map((a) => a.key)).toEqual([
      "page",
      "top-left",
      "bottom-left",
      "right",
    ]);
  });

  test("a frame's exact copies of one box count once", () => {
    const a = { rect: rect(300, 40, 700, 760), key: "first" };
    const b = { rect: rect(300.4, 40, 700, 760), key: "copy" };
    const c = { rect: rect(0, 40, 300, 760), key: "tree" };
    expect(orderScrollAreas([a, b, b, c], viewport).map((x) => x.key)).toEqual(["tree", "first"]);
  });

  test("a frame's area with the same box as another frame's is kept", () => {
    // The top document scrolls, and a frame covering the viewport scrolls too.
    const page = { rect: rect(0, 0, 1000, 800), frame: 1, key: "page" };
    const framed = { rect: rect(0, 0, 1000, 800), frame: 2, key: "frame" };
    expect(orderScrollAreas([page, framed], viewport).map((x) => x.key)).toEqual(["page", "frame"]);
  });

  test("an area that shows less than a tenth of the viewport is left out", () => {
    const small = { rect: rect(0, 0, 100, 700), key: "small" }; // 70,000 < 80,000
    const enough = { rect: rect(100, 0, 100, 800), key: "enough" }; // 80,000
    expect(orderScrollAreas([small, enough], viewport).map((a) => a.key)).toEqual(["enough"]);
  });

  test("only the part inside the viewport counts", () => {
    const off = { rect: rect(-950, 0, 1000, 800), key: "mostly-off" }; // 50 wide on screen
    const below = { rect: rect(0, 900, 1000, 800), key: "below" };
    expect(orderScrollAreas([off, below], viewport)).toEqual([]);
  });
});

describe("currentScrollArea: where the scroll keys go now", () => {
  const areas = [
    { frame: 1, current: true, chosen: false },
    { frame: 2, current: false, chosen: false },
    { frame: 2, current: true, chosen: false },
  ];

  test("a chosen area wins", () => {
    const chosen = areas.map((a, i) => (i === 1 ? { ...a, chosen: true } : a));
    expect(currentScrollArea(chosen, [1, 2])).toBe(1);
  });

  test("else the current area of the first frame the scroll keys try", () => {
    expect(currentScrollArea(areas, [2, 1])).toBe(2);
    expect(currentScrollArea(areas, [1])).toBe(0);
  });

  test("-1 when no area is current", () => {
    expect(currentScrollArea([{ frame: 1, current: false, chosen: false }], [1])).toBe(-1);
  });
});

describe("nextScrollArea: gs, gS and a count", () => {
  test("gs goes to the next area and wraps; with two areas it toggles", () => {
    expect(nextScrollArea({ length: 2, current: 0, direction: 1 })).toBe(1);
    expect(nextScrollArea({ length: 2, current: 1, direction: 1 })).toBe(0);
    expect(nextScrollArea({ length: 3, current: 2, direction: 1 })).toBe(0);
  });

  test("gS goes back and wraps", () => {
    expect(nextScrollArea({ length: 3, current: 0, direction: -1 })).toBe(2);
    expect(nextScrollArea({ length: 3, current: 2, direction: -1 })).toBe(1);
  });

  test("with no current area, gs takes the first and gS the last", () => {
    expect(nextScrollArea({ length: 3, current: -1, direction: 1 })).toBe(0);
    expect(nextScrollArea({ length: 3, current: -1, direction: -1 })).toBe(2);
  });

  test("a count picks the Nth area, whichever the direction; past the last, none", () => {
    expect(nextScrollArea({ length: 3, current: 0, direction: 1, count: 2 })).toBe(1);
    expect(nextScrollArea({ length: 3, current: 0, direction: -1, count: 3 })).toBe(2);
    expect(nextScrollArea({ length: 3, current: 0, direction: 1, count: 4 })).toBeNull();
  });

  test("no areas, no pick", () => {
    expect(nextScrollArea({ length: 0, current: -1, direction: 1 })).toBeNull();
  });
});

describe("the keys and the status bar", () => {
  test("gs and gS are bound in normal mode to the two actions", () => {
    const normal = DEFAULT_CONFIG.modal?.normal as Record<string, string>;
    expect(normal["gs"]).toBe("scroll.area_next");
    expect(normal["gS"]).toBe("scroll.area_prev");
    const ids = new Set(ACTIONS.map((a) => a.id));
    expect(ids.has("scroll.area_next")).toBe(true);
    expect(ids.has("scroll.area_prev")).toBe(true);
  });

  test("a chosen area shows `scroll area`, in the accent, and gives way before the title", () => {
    const tab = { index: 1, count: 1, title: "Page", url: "https://example.com/" };
    const segs = statusSegments({ mode: "normal", tab, scrollArea: true });
    const marker = segs.find((s) => s.id === "scroll-area");
    expect(marker?.text).toBe("scroll area");
    expect(marker?.fg).toBe("--vimma-accent");
    const title = segs.find((s) => s.id === "title");
    expect(marker && title && marker.priority > title.priority).toBe(true);
    expect(statusSegments({ mode: "normal", tab }).some((s) => s.id === "scroll-area")).toBe(false);
  });
});
