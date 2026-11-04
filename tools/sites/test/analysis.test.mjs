import { describe, expect, it } from "vitest";
import { canScroll, chooseHintLink, reactionOf, scrollMovement } from "../analysis.mjs";

/** @param {number} top @param {Array<[string, number]>} [inner] */
const snap = (top, inner = []) => ({
  main: { top, max: 5000 },
  inner: inner.map(([key, t]) => ({ key, top: t, max: 900, area: 1000 })),
});

describe("scrollMovement", () => {
  it("reports the main scroller moving down or up", () => {
    expect(scrollMovement(snap(0), snap(60))).toEqual({ moved: "down", where: "main", by: 60 });
    expect(scrollMovement(snap(60), snap(0))).toEqual({ moved: "up", where: "main", by: -60 });
  });

  it("reports an inner scroller when the main one stayed", () => {
    expect(scrollMovement(snap(0, [["div.feed", 0]]), snap(0, [["div.feed", 120]]))).toEqual({
      moved: "down",
      where: "div.feed",
      by: 120,
    });
  });

  it("none when nothing moved; an inner scroller that appeared later is not a move", () => {
    expect(scrollMovement(snap(10), snap(10))).toEqual({ moved: "none", where: null, by: 0 });
    expect(scrollMovement(snap(0), snap(0, [["div.new", 40]]))).toEqual({
      moved: "none",
      where: null,
      by: 0,
    });
  });

  it("the largest move wins when several moved", () => {
    expect(
      scrollMovement(
        snap(0, [
          ["a", 0],
          ["b", 0],
        ]),
        snap(5, [
          ["a", 300],
          ["b", 10],
        ]),
      ).where,
    ).toBe("a");
  });
});

describe("canScroll", () => {
  it("is true when the main or an inner scroller has room", () => {
    expect(canScroll(snap(0))).toBe(true);
    expect(canScroll({ main: { top: 0, max: 0 }, inner: [] })).toBe(false);
    expect(
      canScroll({ main: { top: 0, max: 0 }, inner: [{ key: "x", top: 0, max: 40, area: 9 }] }),
    ).toBe(true);
  });
});

describe("chooseHintLink", () => {
  const links = [
    { label: "a", href: null },
    { label: "s", href: "https://x.test/page#top", target: "", sameDoc: true, sameOrigin: true },
    { label: "d", href: "https://other.test/", target: "", sameDoc: false, sameOrigin: false },
    { label: "f", href: "https://x.test/new", target: "_blank", sameDoc: false, sameOrigin: true },
    { label: "g", href: "javascript:void(0)", target: "", sameDoc: false, sameOrigin: false },
    { label: "h", href: "https://x.test/next", target: "_self", sameDoc: false, sameOrigin: true },
  ];

  it("prefers a same-origin, same-tab link to another document", () => {
    expect(chooseHintLink(links)?.label).toBe("h");
  });

  it("falls back to a cross-origin same-tab link", () => {
    expect(chooseHintLink(links.filter((l) => l.label !== "h"))?.label).toBe("d");
  });

  it("null when no label is on a followable link", () => {
    expect(chooseHintLink(links.slice(0, 2))).toBe(null);
  });

  // Google's "Google apps" launcher is an <a href> with role="button" and aria-expanded: a click
  // opens a menu and the URL stays (issue #734).
  it.each([
    ["role=button", { role: "button" }],
    ["aria-haspopup", { "aria-haspopup": "true" }],
    ["aria-expanded", { "aria-expanded": "false" }],
    ["aria-pressed", { "aria-pressed": "false" }],
    ["role=menuitem", { role: "menuitem" }],
    ["role=tab", { role: "tab" }],
  ])("skips a link that acts as a button (%s)", (_name, attrs) => {
    const apps = { label: "j", href: "https://x.test/apps", target: "", sameDoc: false };
    const picked = chooseHintLink([{ ...apps, sameOrigin: true, attrs }, ...links]);
    expect(picked?.label).toBe("h");
    expect(chooseHintLink([{ ...apps, sameOrigin: true, attrs }])).toBe(null);
  });

  it("keeps a link whose ARIA attributes say it is a plain link", () => {
    const plain = { label: "k", href: "https://x.test/k", target: "", sameDoc: false };
    const attrs = { role: "link", "aria-haspopup": "false" };
    expect(chooseHintLink([{ ...plain, sameOrigin: true, attrs }])?.label).toBe("k");
  });
});

describe("reactionOf", () => {
  const base = { url: "https://x/", active: "BODY#.", scrollY: 0, dialogs: 0, fullscreen: false };

  it("nothing when nothing changed and nothing was prevented", () => {
    expect(reactionOf(base, base, [])).toBe(null);
  });

  it("names what the site did", () => {
    expect(reactionOf(base, { ...base, active: "INPUT#q." }, [])).toBe("focus");
    expect(reactionOf(base, { ...base, url: "https://x/find" }, [])).toBe("navigate");
    expect(reactionOf(base, { ...base, scrollY: 300 }, [])).toBe("scroll");
    expect(reactionOf(base, { ...base, dialogs: 1 }, [])).toBe("dialog");
    expect(reactionOf(base, { ...base, fullscreen: true }, [])).toBe("fullscreen");
    expect(reactionOf(base, base, ["k"])).toBe("handled");
  });

  it("focus falling back to the body is a blur, not a shortcut", () => {
    expect(reactionOf({ ...base, active: "INPUT#q." }, base, [])).toBe(null);
    expect(reactionOf({ ...base, active: "A#x." }, { ...base, active: "HTML#." }, [])).toBe(null);
  });
});
