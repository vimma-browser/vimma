// docs/specs/tab-line.md: what the tab line says, how it fits a width, and gb's labels.
import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { TABLINE_SETTINGS, TABLINE_WIDTH } from "../src/config/defaults.mjs";
import {
  fitTabLine,
  lineWidth,
  nextTabLineSetting,
  startTabLabels,
  tabCountRefusal,
  tabLabelKey,
  tabLineEntries,
  tabLineShown,
} from "../src/ui/tabline.mjs";
import { textWidth } from "../src/text/textwidth.mjs";
import { parseKey } from "../src/keys/keys.mjs";
import { budget } from "./budget.ts";

import type { TabLineEntry, TabLineFit } from "../src/ui/tabline.mjs";

type Row = {
  tabId: string;
  number: number;
  display: string;
  active: boolean;
  playing: boolean;
};

const row = (n: number, display: string, extra: Partial<Row> = {}): Row => ({
  tabId: `t${n}`,
  number: n,
  display,
  active: false,
  playing: false,
  ...extra,
});

const rows = (count: number, current: number, name = (n: number) => `tab ${n}`) =>
  Array.from({ length: count }, (_, i) => row(i + 1, name(i + 1), { active: i + 1 === current }));

const key = (k: string) => parseKey(k);

/** The line as plain text, for reading the tests: marks and entries as the host draws them. */
function text(fit: TabLineFit) {
  const parts: string[] = [];
  if (fit.before) parts.push(`‹${fit.before}`);
  for (const item of fit.items) {
    const label = item.label ? `${item.label} ` : "";
    const name = item.name ? ` ${item.name}` : "";
    const cur = item.current ? "*" : "";
    parts.push(
      `${cur}${label}${item.number}${item.pane ? "▪" : ""}${name}${item.playing ? " ♪" : ""}`,
    );
  }
  if (fit.after) parts.push(`${fit.after}›`);
  return parts.join("|");
}

describe("settings", () => {
  test("off, always and auto; tabline_width 4 to 60, default 14", () => {
    expect(TABLINE_SETTINGS).toEqual(["off", "always", "auto"]);
    expect(TABLINE_WIDTH).toEqual({ min: 4, max: 60, default: 14 });
  });

  test("tabLineShown: off never, always always, auto with two tabs or more", () => {
    expect(tabLineShown("off", 5)).toBe(false);
    expect(tabLineShown("always", 1)).toBe(true);
    expect(tabLineShown("always", 0)).toBe(true);
    expect(tabLineShown("auto", 1)).toBe(false);
    expect(tabLineShown("auto", 2)).toBe(true);
  });

  test("labels show the line whatever the setting (decision 14)", () => {
    expect(tabLineShown("off", 1, true)).toBe(true);
    expect(tabLineShown("auto", 1, true)).toBe(true);
  });

  test(":tabline flips what is seen (decision 6)", () => {
    expect(nextTabLineSetting(true)).toBe("off");
    expect(nextTabLineSetting(false)).toBe("always");
  });
});

describe("tabLineEntries", () => {
  test("the panel's rows in order, with their number, name, sound and the current tab", () => {
    const entries = tabLineEntries(
      [row(1, "mail"), row(2, "vimma pulls", { active: true }), row(3, "docs", { playing: true })],
      [],
    );
    expect(entries).toEqual([
      { tabId: "t1", number: 1, name: "mail", current: false, playing: false, pane: false },
      { tabId: "t2", number: 2, name: "vimma pulls", current: true, playing: false, pane: false },
      { tabId: "t3", number: 3, name: "docs", current: false, playing: true, pane: false },
    ]);
  });

  test("tabs shown in a pane of the shown split are marked (decision 11)", () => {
    const entries = tabLineEntries([row(1, "a"), row(2, "b"), row(3, "c")], ["t1", "t3"]);
    expect(entries.map((e) => e.pane)).toEqual([true, false, true]);
  });
});

describe("fitTabLine", () => {
  test("everything fits: every entry, names whole, no marks", () => {
    const fit = fitTabLine(tabLineEntries(rows(3, 2), []), { width: 80, nameWidth: 14 });
    expect(text(fit)).toBe("1 tab 1|*2 tab 2|3 tab 3");
    expect(fit.before).toBe(0);
    expect(fit.after).toBe(0);
  });

  test("names are cut to nameWidth with an ellipsis, wide characters as two columns", () => {
    const entries = tabLineEntries(
      [row(1, "a very long page title indeed", { active: true }), row(2, "日本語のページです")],
      [],
    );
    const fit = fitTabLine(entries, { width: 200, nameWidth: 8 });
    expect(fit.items.map((i) => i.name)).toEqual(["a very …", "日本語…"]);
    for (const item of fit.items) expect(textWidth(item.name)).toBeLessThanOrEqual(8);
  });

  test("each entry is padded by a column on each side; the line's width adds them up", () => {
    const entries = tabLineEntries([row(1, "ab", { active: true }), row(12, "c", {})], []);
    const fit = fitTabLine(entries, { width: 200, nameWidth: 14 });
    // " 1 ab " + " 12 c "
    expect(lineWidth(fit)).toBe(6 + 6);
  });

  test("overflow keeps the current tab in view, with exact hidden counts", () => {
    for (const current of [1, 15, 30]) {
      const fit = fitTabLine(tabLineEntries(rows(30, current), []), { width: 80, nameWidth: 14 });
      expect(fit.items.some((i) => i.current && i.number === current)).toBe(true);
      expect(fit.before + fit.items.length + fit.after).toBe(30);
      expect(lineWidth(fit)).toBeLessThanOrEqual(80);
      const numbers = fit.items.map((i) => i.number);
      expect(numbers).toEqual(numbers.map((_, i) => (numbers[0] ?? 0) + i));
      expect(fit.before).toBe((numbers[0] ?? 1) - 1);
    }
  });

  test("the current tab sits near the middle when tabs are hidden on both sides", () => {
    const fit = fitTabLine(tabLineEntries(rows(30, 15), []), { width: 80, nameWidth: 14 });
    expect(text(fit)).toMatch(/^‹\d+\|.*\*15 tab 15.*\|\d+›$/);
    const at = fit.items.findIndex((i) => i.current);
    expect(Math.abs(at - (fit.items.length - 1 - at))).toBeLessThanOrEqual(1);
  });

  test("too narrow for one whole entry: the current tab alone, its name cut", () => {
    const fit = fitTabLine(
      tabLineEntries(
        rows(5, 3, () => "a long name"),
        [],
      ),
      {
        width: 12,
        nameWidth: 14,
      },
    );
    expect(fit.items.map((i) => i.number)).toEqual([3]);
    expect(lineWidth(fit)).toBeLessThanOrEqual(12);
  });

  test("no tabs: nothing", () => {
    expect(fitTabLine([], { width: 80, nameWidth: 14 })).toEqual({
      items: [],
      before: 0,
      after: 0,
    });
  });

  test("any names, marks, count and width: the current tab shows, counts add up, it never overflows, and no hidden neighbour would fit", () => {
    fc.assert(
      fc.property(
        fc.array(tabArb, { minLength: 1, maxLength: 150 }),
        fc.integer({ min: 30, max: 300 }),
        fc.integer({ min: 4, max: 60 }),
        fc.nat(),
        (tabs, width, nameWidth, pick) => {
          const count = tabs.length;
          const current = (pick % count) + 1;
          const entries = entriesOf(tabs, current);
          const fit = fitTabLine(entries, { width, nameWidth });
          expect(fit.items.some((i) => i.number === current)).toBe(true);
          expect(fit.before + fit.items.length + fit.after).toBe(count);
          expect(lineWidth(fit)).toBeLessThanOrEqual(width);
          expectMaximal(entries, fit, width, nameWidth, null);
        },
      ),
    );
  });
});

/** Pieces of tab names: wide CJK, a ZWJ emoji, a flag, combining and precomposed accents. */
const NAME_PARTS = ["mail", "日本語の", "👩‍💻", "🇫🇮", "e\u0301te\u0301", "Ünïcödé", "ｶﾀｶﾅ", " ", "x"];
const tabArb = fc.record({
  name: fc.array(fc.constantFrom(...NAME_PARTS), { maxLength: 8 }).map((p) => p.join("")),
  pane: fc.boolean(),
  playing: fc.boolean(),
});

/** @param tabs  generated tabs @param current  the current tab's number */
function entriesOf(
  tabs: { name: string; pane: boolean; playing: boolean }[],
  current: number,
): TabLineEntry[] {
  return tabLineEntries(
    tabs.map((t, i) => row(i + 1, t.name, { active: i + 1 === current, playing: t.playing })),
    tabs.flatMap((t, i) => (t.pane ? [`t${i + 1}`] : [])),
  );
}

const mark = (n: number) => (n > 0 ? String(n).length + 2 : 0);

/**
 * The columns the fit counts for an entry: the name at most `w` columns (a cut name may take
 * one less, where a wide character would not fit), the letters still to type.
 */
function counted(e: TabLineEntry, w: number, rest: string | null) {
  const name = textWidth(e.name);
  return (
    2 +
    (rest ? textWidth(rest) + 1 : 0) +
    String(e.number).length +
    (e.pane ? 1 : 0) +
    (e.playing ? 2 : 0) +
    (w > 0 && name > 0 ? Math.min(name, w) + 1 : 0)
  );
}

/**
 * No hidden neighbour of the run would fit beside it: the line is as full as the rule allows.
 * `labels` null: names at `nameWidth`; with labels and tabs hidden, names are gone (w = 0).
 */
function expectMaximal(
  entries: readonly TabLineEntry[],
  fit: TabLineFit,
  width: number,
  nameWidth: number,
  labels: { typed: string; labels: readonly { tabId: string; label: string }[] } | null,
) {
  if (!fit.before && !fit.after) return;
  const listed = labels
    ? entries.filter((e) =>
        labels.labels.some((l) => l.tabId === e.tabId && l.label.startsWith(labels.typed)),
      )
    : entries;
  const restOf = (e: TabLineEntry) => {
    const l = labels?.labels.find((x) => x.tabId === e.tabId)?.label;
    return l === undefined ? null : l.slice(labels?.typed.length ?? 0);
  };
  const w = labels ? 0 : nameWidth;
  const sum = fit.items.reduce(
    (n, i) => n + counted(listed.find((e) => e.tabId === i.tabId) as TabLineEntry, w, restOf(i)),
    0,
  );
  if (fit.before) {
    const left = listed[fit.before - 1] as TabLineEntry;
    expect(
      sum + counted(left, w, restOf(left)) + mark(fit.before - 1) + mark(fit.after),
    ).toBeGreaterThan(width);
  }
  if (fit.after) {
    const right = listed[fit.before + fit.items.length] as TabLineEntry;
    expect(
      sum + counted(right, w, restOf(right)) + mark(fit.before) + mark(fit.after - 1),
    ).toBeGreaterThan(width);
  }
}

describe("gb labels", () => {
  test("one label per tab, in tab order, from the hint characters", () => {
    const s = startTabLabels(["t1", "t2", "t3"], "asdf");
    expect(s.labels).toEqual([
      { tabId: "t1", label: "a" },
      { tabId: "t2", label: "s" },
      { tabId: "t3", label: "d" },
    ]);
    expect(s.typed).toBe("");
  });

  test("labels reach every tab: names shrink before any tab is hidden (decision 13)", () => {
    const entries = tabLineEntries(rows(12, 6), []);
    const labels = startTabLabels(
      entries.map((e) => e.tabId),
      "asdfghjkl",
    );
    const plain = fitTabLine(entries, { width: 100, nameWidth: 14 });
    expect(plain.items.length).toBeLessThan(12);
    const fit = fitTabLine(entries, { width: 100, nameWidth: 14, labels });
    expect(fit.items.length).toBe(12);
    expect(fit.items.map((i) => i.label)).toEqual(labels.labels.map((l) => l.label));
    expect(lineWidth(fit)).toBeLessThanOrEqual(100);
  });

  test("after a typed character only the matching tabs are fitted", () => {
    const entries = tabLineEntries(rows(30, 1), []);
    let s = startTabLabels(
      entries.map((e) => e.tabId),
      "asdfghjkl",
    );
    const first = fitTabLine(entries, { width: 60, nameWidth: 14, labels: s });
    expect(first.before + first.items.length + first.after).toBe(30);
    const last = s.labels.at(-1)?.label ?? "";
    expect(last.length).toBe(2);
    ({ state: s } = tabLabelKey(s, key(last[0] ?? "")));
    const fit = fitTabLine(entries, { width: 60, nameWidth: 14, labels: s });
    const left = s.labels.filter((l) => l.label.startsWith(s.typed)).map((l) => l.tabId);
    expect(fit.items.map((i) => i.tabId)).toEqual(left);
    expect(fit.before + fit.after).toBe(0);
  });

  test("a whole label selects its tab", () => {
    const s = startTabLabels(["t1", "t2", "t3"], "asdf");
    expect(tabLabelKey(s, key("s")).result).toEqual({ kind: "select", tabId: "t2" });
  });

  test("a two-character label narrows, then selects", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `t${i + 1}`);
    const s = startTabLabels(ids, "asdfghjkl");
    const target = s.labels.find((l) => l.label.length === 2);
    expect(target).toBeDefined();
    const { label, tabId } = target as { label: string; tabId: string };
    const one = tabLabelKey(s, key(label[0] ?? ""));
    expect(one.result).toEqual({ kind: "narrow" });
    expect(one.state.typed).toBe(label[0]);
    expect(tabLabelKey(one.state, key(label[1] ?? "")).result).toEqual({ kind: "select", tabId });
  });

  test("Esc, a character of no label, a chord, Backspace with nothing typed and a digit cancel", () => {
    const s = startTabLabels(["t1", "t2"], "asdf");
    for (const k of ["esc", "x", "ctrl+a", "alt+s", "backspace", "4", "enter"]) {
      expect(tabLabelKey(s, key(k)).result, k).toEqual({ kind: "cancel" });
    }
  });

  test("a letter typed with Shift or Caps Lock is that letter, as for link hints", () => {
    const s = startTabLabels(["t1", "t2", "t3"], "asdf");
    expect(tabLabelKey(s, key("shift+s")).result).toEqual({ kind: "select", tabId: "t2" });
    const ids = Array.from({ length: 12 }, (_, i) => `t${i + 1}`);
    const many = startTabLabels(ids, "asdfghjkl");
    const two = many.labels.find((l) => l.label.length === 2) as { label: string; tabId: string };
    const first = tabLabelKey(many, key(`shift+${two.label[0]}`));
    expect(first.result).toEqual({ kind: "narrow" });
    expect(tabLabelKey(first.state, key(`shift+${two.label[1]}`)).result).toEqual({
      kind: "select",
      tabId: two.tabId,
    });
  });

  test("Backspace takes back the last letter typed (decision 12)", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `t${i + 1}`);
    const s = startTabLabels(ids, "asdfghjkl");
    const two = s.labels.find((l) => l.label.length === 2) as { label: string; tabId: string };
    const one = tabLabelKey(s, key(two.label[0] ?? ""));
    const back = tabLabelKey(one.state, key("backspace"));
    expect(back.result).toEqual({ kind: "narrow" });
    expect(back.state.typed).toBe("");
    expect(tabLabelKey(back.state, key("backspace")).result).toEqual({ kind: "cancel" });
  });

  test("labels draw the letters still to type", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `t${i + 1}`);
    const entries = tabLineEntries(rows(12, 1), []);
    let s = startTabLabels(ids, "asdfghjkl");
    const two = s.labels.find((l) => l.label.length === 2) as { label: string; tabId: string };
    ({ state: s } = tabLabelKey(s, key(two.label[0] ?? "")));
    const fit = fitTabLine(entries, { width: 200, nameWidth: 14, labels: s });
    for (const i of fit.items) expect(i.rest).toBe(i.label?.slice(1));
  });

  test("a character of the alphabet that starts no remaining label cancels", () => {
    const s = startTabLabels(["t1", "t2"], "asdf");
    expect(tabLabelKey(s, key("f")).result).toEqual({ kind: "cancel" });
  });
});

describe("labels in a narrow line (decision 13)", () => {
  test("a label keeps its number: when names do not fit, entries are label and number", () => {
    const entries = tabLineEntries(rows(30, 15), []);
    const s = startTabLabels(
      entries.map((e) => e.tabId),
      "asdfghjkl",
    );
    const fit = fitTabLine(entries, { width: 60, nameWidth: 14, labels: s });
    expect(fit.items.length).toBeGreaterThan(0);
    for (const i of fit.items) {
      expect(i.name).toBe("");
      expect(i.label).not.toBeNull();
      expect(lineWidth({ items: [i], before: 0, after: 0 })).toBe(
        2 + (i.rest?.length ?? 0) + 1 + String(i.number).length,
      );
    }
    expect(fit.before).toBe(0);
    expect(fit.items[0]?.number).toBe(1);
  });

  test.each([
    [30, 40],
    [30, 60],
    [30, 110],
    [120, 40],
    [120, 60],
    [120, 110],
  ])("%i tabs at %i columns: the tabs one letter away come first", (n, width) => {
    const entries = tabLineEntries(rows(n, Math.ceil(n / 2)), []);
    const start = startTabLabels(
      entries.map((e) => e.tabId),
      "asdfghjkl",
    );
    for (const { tabId, label } of start.labels) {
      let s = start;
      for (const c of label.slice(0, -1)) ({ state: s } = tabLabelKey(s, key(c)));
      const fit = fitTabLine(entries, { width, nameWidth: 14, labels: s });
      const matching = s.labels.filter((l) => l.label.startsWith(s.typed));
      expect(fit.before).toBe(0);
      expect(fit.items[0]?.tabId).toBe(matching[0]?.tabId);
      expect(lineWidth(fit)).toBeLessThanOrEqual(width);
      const shown = fit.items.some((i) => i.tabId === tabId);
      if (width >= 110) {
        // Wide enough for every tab one letter away with its number: each is in view.
        expect(shown, `${label} after "${s.typed}"`).toBe(true);
      } else if (!shown) {
        // Narrower: only tabs one letter away (closer than this one) may take the room.
        expect(
          fit.items.every((i) => i.rest?.length === 1),
          `${label} after "${s.typed}"`,
        ).toBe(true);
      }
    }
  });

  test("any names, count, width and typed prefix: only matching tabs from the first, counts add up, never wider, full", () => {
    fc.assert(
      fc.property(
        fc.array(tabArb, { minLength: 1, maxLength: 300 }),
        fc.integer({ min: 30, max: 300 }),
        fc.integer({ min: 4, max: 60 }),
        fc.nat(),
        fc.nat(),
        (tabs, width, nameWidth, pick, which) => {
          const count = tabs.length;
          const entries = entriesOf(tabs, (pick % count) + 1);
          let s = startTabLabels(
            entries.map((e) => e.tabId),
            "asdfghjkl",
          );
          const target = s.labels[which % count]?.label ?? "";
          for (const c of target.slice(0, which % target.length)) {
            ({ state: s } = tabLabelKey(s, key(c)));
          }
          const left = s.labels.filter((l) => l.label.startsWith(s.typed)).length;
          const fit = fitTabLine(entries, { width, nameWidth, labels: s });
          expect(fit.before + fit.items.length + fit.after).toBe(left);
          expect(fit.items.every((i) => i.label?.startsWith(s.typed))).toBe(true);
          expect(lineWidth(fit)).toBeLessThanOrEqual(width);
          expect(fit.before).toBe(0);
          expectMaximal(entries, fit, width, nameWidth, s);
        },
      ),
    );
  });

  // A complexity check (budget.ts): a fit is linear in the tabs, so 3000 take milliseconds where
  // a quadratic one took seconds.
  test("a fit is linear in the tabs, with labels too", () => {
    const entries = tabLineEntries(
      rows(3000, 1500, (n) => `a page title number ${n}`),
      [],
    );
    const s = startTabLabels(
      entries.map((e) => e.tabId),
      "asdfghjkl",
    );
    const start = performance.now();
    for (let i = 0; i < 5; i++) {
      fitTabLine(entries, { width: 120, nameWidth: 14 });
      fitTabLine(entries, { width: 120, nameWidth: 14, labels: s });
    }
    expect(performance.now() - start).toBeLessThan(budget(1000));
  });
});

// Ten tabs and more: two- and three-digit numbers, and labels of two letters.
describe("many tabs", () => {
  test.each([[30], [120]])("%i tabs: numbers past 9 counted in full, the current in view", (n) => {
    for (const current of [1, 12, Math.ceil(n / 2), n]) {
      const fit = fitTabLine(tabLineEntries(rows(n, current), []), { width: 100, nameWidth: 14 });
      expect(fit.items.some((i) => i.current && i.number === current)).toBe(true);
      expect(fit.before + fit.items.length + fit.after).toBe(n);
      expect(lineWidth(fit)).toBeLessThanOrEqual(100);
    }
    // " 120 tab 120 " is 13 columns: three digits, a space, the name, and the padding.
    const [only] = fitTabLine(tabLineEntries([row(120, "tab 120", { active: true })], []), {
      width: 100,
      nameWidth: 14,
    }).items;
    expect(only && lineWidth({ items: [only], before: 0, after: 0 })).toBe(13);
  });

  test.each([[30], [120]])(
    "%i tabs: every tab has a label, and typing it reaches that tab, hidden or not",
    (n) => {
      const entries = tabLineEntries(rows(n, 1), []);
      const start = startTabLabels(
        entries.map((e) => e.tabId),
        "asdfghjkl",
      );
      expect(new Set(start.labels.map((l) => l.label)).size).toBe(n);
      // Prefix-free labels as link hints have them: two letters for 30, three for 120 (9 letters).
      const longest = Math.max(...start.labels.map((l) => l.label.length));
      expect(longest).toBe(n > 81 ? 3 : 2);
      const first = fitTabLine(entries, { width: 80, nameWidth: 14, labels: start });
      expect(first.before + first.items.length + first.after).toBe(n);
      // Every seventh tab and the last, so each first letter and the hidden end are covered.
      const sample = start.labels.filter((_, i) => i % 7 === 0 || i === n - 1);
      for (const { tabId, label } of sample) {
        let s = start;
        let result: ReturnType<typeof tabLabelKey>["result"] = { kind: "narrow" };
        for (const c of label) {
          ({ state: s, result } = tabLabelKey(s, key(c)));
          if (result.kind !== "select") {
            // After each character the line holds only the tabs still matching, scrolled in.
            const fit = fitTabLine(entries, { width: 80, nameWidth: 14, labels: s });
            const left = s.labels.filter((l) => l.label.startsWith(s.typed)).length;
            expect(fit.before + fit.items.length + fit.after).toBe(left);
            expect(fit.items.every((i) => i.label?.startsWith(s.typed))).toBe(true);
          }
        }
        expect(result).toEqual({ kind: "select", tabId });
      }
    },
  );
});

describe("{N}gb", () => {
  test("a number within the workspace's tabs is fine, 12 of 120 too", () => {
    expect(tabCountRefusal(1, 3)).toBeNull();
    expect(tabCountRefusal(12, 120)).toBeNull();
    expect(tabCountRefusal(120, 120)).toBeNull();
  });

  test("past the last tab: a notice that says how many there are", () => {
    expect(tabCountRefusal(12, 5)).toBe("no tab 12: this workspace has 5 tabs");
    expect(tabCountRefusal(2, 1)).toBe("no tab 2: this workspace has 1 tab");
  });
});

describe("types", () => {
  test("entries are plain data", () => {
    const e: TabLineEntry = tabLineEntries([row(1, "x", { active: true })], [])[0] as TabLineEntry;
    expect(Object.isFrozen(e)).toBe(true);
  });
});
