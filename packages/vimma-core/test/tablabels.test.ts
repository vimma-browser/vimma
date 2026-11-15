import { describe, test, expect } from "vitest";
import fc from "fast-check";
import {
  MAX_TAB_LABEL,
  clearTabLabel,
  displayLabel,
  normalizeTabLabel,
  pruneTabLabels,
  readTabLabels,
  setTabLabel,
  tabLabel,
  writeTabLabels,
} from "../src/workspaces/tablabels.mjs";

describe("tab labels", () => {
  test("setTabLabel normalises whitespace and control characters", () => {
    const l = setTabLabel({}, "t1", "  my\n\t mail\u0007 ");
    expect(l).toEqual({ t1: "my mail" });
    expect(Object.isFrozen(l)).toBe(true);
    expect(tabLabel(l, "t1")).toBe("my mail");
    expect(tabLabel(l, "t2")).toBeUndefined();
  });

  test("an empty label clears the rename; the same label is a no-op", () => {
    const l = setTabLabel({}, "t1", "mail");
    expect(setTabLabel(l, "t1", "   ")).toEqual({});
    expect(setTabLabel(l, "t1", " mail ")).toBe(l);
    expect(setTabLabel(l, "t2", "")).toBe(l);
    expect(clearTabLabel(l, "t1")).toEqual({});
    expect(clearTabLabel(l, "t9")).toBe(l);
  });

  test("labels are cut to MAX_TAB_LABEL graphemes, never inside one", () => {
    expect(MAX_TAB_LABEL).toBe(100);
    expect([...normalizeTabLabel("é".repeat(150))].length).toBe(100);
    expect([...normalizeTabLabel("😀".repeat(150))].length).toBe(100);
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    expect(normalizeTabLabel(family.repeat(150))).toBe(family.repeat(100));
    const combining = "e\u0301";
    expect(normalizeTabLabel(combining.repeat(150))).toBe(combining.repeat(100));
  });

  test("format and bidi characters are stripped; emoji sequences survive", () => {
    expect(normalizeTabLabel("\u202Eevil\u200Bname\u2066x\u2069\uFEFF")).toBe("evilnamex");
    expect(normalizeTabLabel("a\u200Fb\u061Cc")).toBe("abc");
    expect(normalizeTabLabel("\u200B")).toBe("");
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    expect(normalizeTabLabel(`hi ${family} \u{1F1EB}\u{1F1EE}`)).toBe(
      `hi ${family} \u{1F1EB}\u{1F1EE}`,
    );
    const scotland = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}";
    expect(normalizeTabLabel(scotland)).toBe(scotland);
    expect(normalizeTabLabel("a\u{E0067}b")).toBe("ab");
  });

  test("pruneTabLabels keeps live tabs only", () => {
    const l = { t1: "a", t2: "b" };
    expect(pruneTabLabels(l, ["t1"])).toEqual({ t1: "a" });
    expect(pruneTabLabels(l, new Set(["t1", "t2", "t3"]))).toBe(l);
  });

  test("display label precedence: rename > title > URL > New Tab", () => {
    expect(displayLabel({ label: "mail", title: "Inbox", url: "https://x.org" })).toBe("mail");
    expect(displayLabel({ title: "Inbox", url: "https://x.org" })).toBe("Inbox");
    expect(displayLabel({ label: null, title: "  ", url: "https://x.org" })).toBe("https://x.org");
    expect(displayLabel({ label: "", title: "", url: "" })).toBe("New Tab");
    expect(displayLabel({})).toBe("New Tab");
  });

  test("writeTabLabels: undefined when empty, keys sorted", () => {
    expect(writeTabLabels({})).toBeUndefined();
    expect(
      Object.keys(/** @type {object} */ (writeTabLabels({ t2: "b", t10: "c", t1: "a" }))),
    ).toEqual(["t1", "t10", "t2"]);
  });

  test("readTabLabels is lenient: drops stale or invalid entries with warnings, never throws", () => {
    const ids = new Set(["t1", "t2"]);
    expect(readTabLabels(undefined, ids)).toEqual({ labels: {}, warnings: [] });
    expect(readTabLabels({ t1: "mail" }, ids)).toEqual({ labels: { t1: "mail" }, warnings: [] });
    for (const raw of [[], null, "x", 3]) {
      const r = readTabLabels(raw, ids);
      expect(r.labels).toEqual({});
      expect(r.warnings.map((w) => w.path)).toEqual(["tabLabels"]);
    }
    const r = readTabLabels({ t9: "stale", t1: 3, t2: " padded\u202E ", ["__proto__"]: "x" }, ids);
    expect(r.labels).toEqual({ t2: "padded" });
    expect(Object.isFrozen(r.labels)).toBe(true);
    expect(r.warnings.map((w) => w.path)).toEqual([
      'tabLabels["t9"]',
      'tabLabels["t1"]',
      'tabLabels["t2"]',
      'tabLabels["__proto__"]',
    ]);
    expect(readTabLabels({ t1: "  " }, ids)).toMatchObject({
      labels: {},
      warnings: [{ path: 'tabLabels["t1"]' }],
    });
  });

  test("property: readTabLabels never throws", () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        const r = readTabLabels(raw, new Set(["t1"]));
        for (const v of Object.values(r.labels)) expect(normalizeTabLabel(v)).toBe(v);
      }),
    );
  });

  test("property: normalizeTabLabel is idempotent and labels round-trip", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 200 }), (s) => {
        const n = normalizeTabLabel(s);
        expect(normalizeTabLabel(n)).toBe(n);
      }),
    );
    fc.assert(
      fc.property(fc.dictionary(fc.constantFrom("t1", "t2", "t3"), fc.string()), (raw) => {
        let l = {};
        for (const [k, v] of Object.entries(raw)) l = setTabLabel(l, k, v);
        expect(readTabLabels(writeTabLabels(l), new Set(["t1", "t2", "t3"]))).toEqual({
          labels: l,
          warnings: [],
        });
      }),
    );
  });
});
