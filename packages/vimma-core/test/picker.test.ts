import { describe, test, expect } from "vitest";
import fc from "fast-check";
import {
  TIER,
  filterItems,
  itemId,
  markerWords,
  matchItem,
  openPicker,
  pickerItems,
  pickerKey,
  pickerSelection,
  scoreField,
  sectionOf,
  typedChar,
  setPickerItems,
  matchWork,
  unitsBuilt,
  workspaceItems,
} from "../src/ui/picker.mjs";
import { downloadSections } from "../src/ui/downloads.mjs";
import { createSplits, newSplit, splitPickerItems } from "../src/panes/splits.mjs";
import { budget } from "./budget.mjs";

import type { AnyItem, Field, PickerState, PickerItem } from "../src/ui/picker.mjs";
import type { Workspaces } from "../src/workspaces/workspaces.mjs";
import type { DownloadRecord } from "../src/ui/downloads.mjs";

/**
 * A workspaces model from what the pickers read of each workspace: its id, name, tabs and active
 * tab. The container and panes, which they do not read, are filled in.
 */
const fixture = ({
  active,
  workspaces,
}: {
  active: string;
  workspaces: { id: string; name: string; tabs: string[]; activeTab: string | null }[];
}): Workspaces => ({
  active,
  next: workspaces.length + 1,
  workspaces: workspaces.map((w) => ({ ...w, container: w.id, panes: null })),
});

const tabIdOf = (item: AnyItem | undefined) => (item && "tabId" in item ? item.tabId : undefined);
const splitIdOf = (item: AnyItem | undefined) =>
  item && "splitId" in item ? item.splitId : undefined;
const workspaceIdOf = (item: AnyItem | undefined) =>
  item && "workspaceId" in item ? item.workspaceId : undefined;

const workspaces = fixture({
  active: "w1",
  workspaces: [
    { id: "w1", name: "work", tabs: ["t1", "t2"], activeTab: "t2" },
    { id: "w2", name: "personal", tabs: ["t3", "t4"], activeTab: "t3" },
  ],
});
const info: Record<string, { title: string; url: string }> = {
  t1: { title: "GitHub", url: "https://github.com/" },
  t2: { title: "Mail", url: "https://mail.example.com/" },
  t3: { title: "Recipes", url: "https://recipes.org/" },
  t4: { title: "Bank", url: "https://bank.fi/" },
};
const items = pickerItems(workspaces, (id) => info[id], { t3: "cook" });

function press(s: PickerState, keys: string[]) {
  let effect: ReturnType<typeof pickerKey>["effect"] = null;
  for (const k of keys) ({ state: s, effect } = pickerKey(s, k));
  return { state: s, effect };
}

const selectedTab = (s: PickerState) => tabIdOf(pickerSelection(s)?.item);

describe("scoring", () => {
  test("tiers", () => {
    expect(scoreField("GitHub", "github")?.tier).toBe(TIER.exact);
    expect(scoreField("GitHub", "git")?.tier).toBe(TIER.prefix);
    expect(scoreField("my-github", "git")?.tier).toBe(TIER.word);
    expect(scoreField("GitHub", "hub")?.tier).toBe(TIER.word);
    expect(scoreField("GitHub", "thub")?.tier).toBe(TIER.substring);
    expect(scoreField("GitHub", "ghb")).toMatchObject({
      tier: TIER.subsequence,
      ranges: [
        [0, 1],
        [3, 4],
        [5, 6],
      ],
    });
    expect(scoreField("GitHub", "xyz")).toBeNull();
    expect(scoreField("GitHub", "")).toBeNull();
  });

  test("case folds per character, so one special letter does not disable the rest", () => {
    expect(scoreField("İstanbul GitHub", "git")).toMatchObject({
      tier: TIER.word,
      ranges: [[9, 12]],
    });
    expect(scoreField("İstanbul", "i̇stanbul")?.tier).toBe(TIER.exact);
    expect(scoreField("GROSSE Straße", "straße")).toMatchObject({
      tier: TIER.word,
      ranges: [[7, 13]],
    });
    expect(scoreField("Straße", "STRAẞE")?.tier).toBe(TIER.exact);
  });

  test("text and query are compared in NFC, with ranges in the original text", () => {
    const nfd = "Ka\u0308ytta\u0308ja\u0308t";
    expect(scoreField(nfd, "kä")).toMatchObject({ tier: TIER.prefix, ranges: [[0, 3]] });
    expect(scoreField("Käyttäjät", "ka\u0308")).toMatchObject({
      tier: TIER.prefix,
      ranges: [[0, 2]],
    });
  });

  test("diacritics: exact letters first, a folded match ranks below every exact tier", () => {
    expect(scoreField("Käyttäjät", "ka")).toMatchObject({ tier: TIER.folded, ranges: [[0, 2]] });
    expect(scoreField("Käyttäjät", "kayttajat")?.tier).toBe(TIER.folded);
    const exact = scoreField("Käyttäjät", "kä") as { score: number };
    const folded = scoreField("Käyttäjät", "ka") as { score: number };
    expect(exact.score).toBeGreaterThan(folded.score);
    // a folded match in the best field still loses to an exact subsequence in the worst one
    const sub = scoreField("x-k-y-a", "ka", "workspace") as { score: number };
    expect(sub.score).toBeGreaterThan(folded.score);
    expect(scoreField("Käyttäjät", "kö")).toBeNull();
  });

  test("tiers beat fields: a URL prefix match outranks a title word match", () => {
    const url = scoreField("github.com/x", "git", "url") as { score: number };
    const title = scoreField("My github", "git", "title") as { score: number };
    expect(url.score).toBeGreaterThan(title.score);
  });

  test("subsequence prefers the tightest alignment", () => {
    expect(scoreField("a-x-b ab", "ab")?.tier).toBe(TIER.word);
    expect(scoreField("axxb ayb", "ab")?.ranges).toEqual([
      [5, 6],
      [7, 8],
    ]);
  });

  test("items list every tab in workspace order, with display labels", () => {
    expect(
      items.map((i) => [i.tabId, i.workspaceName, i.workspaceIndex, i.tabIndex, i.display]),
    ).toEqual([
      ["t1", "work", 1, 1, "GitHub"],
      ["t2", "work", 1, 2, "Mail"],
      ["t3", "personal", 2, 1, "cook"],
      ["t4", "personal", 2, 2, "Bank"],
    ]);
    expect(items.filter((i) => i.active).map((i) => i.tabId)).toEqual(["t2"]);
    const bare = pickerItems(workspaces, () => undefined, {});
    expect(bare[0]).toMatchObject({ title: "", url: "", label: null, display: "New Tab" });
  });

  test("matches rename, title, URL and workspace", () => {
    const cook = filterItems(items, "cook");
    expect(cook.map((m) => tabIdOf(m.item))).toEqual(["t3"]);
    expect(cook[0]?.highlights.display).toEqual([[0, 4]]);
    expect(tabIdOf(filterItems(items, "recipes")[0]?.item)).toBe("t3");
    expect(filterItems(items, "recipes")[0]?.highlights.title).toEqual([[0, 7]]);
    expect(filterItems(items, "personal").map((m) => tabIdOf(m.item))).toEqual(["t3", "t4"]);
    expect(filterItems(items, "  work   mail ").map((m) => tabIdOf(m.item))).toEqual(["t2"]);
    expect(filterItems(items, "github.com")[0]?.highlights.url).toEqual([[8, 18]]);
    expect(matchItem(items[0] as PickerItem, "zzz")).toBeNull();
  });

  test("a blank query lists everything in order; ties keep input order", () => {
    expect(filterItems(items, " ").map((m) => [tabIdOf(m.item), m.score])).toEqual([
      ["t1", 0],
      ["t2", 0],
      ["t3", 0],
      ["t4", 0],
    ]);
    const twins = pickerItems(
      fixture({
        active: "w1",
        workspaces: [{ id: "w1", name: "a", tabs: ["x", "y", "z"], activeTab: "x" }],
      }),
      () => ({ title: "Docs", url: "https://docs.rs/" }),
      {},
    );
    expect(filterItems(twins, "doc").map((m) => tabIdOf(m.item))).toEqual(["x", "y", "z"]);
  });
});

describe("picker state machine", () => {
  test("opens in browse mode on the active tab; j/k/arrows/ctrl-n/p move and clamp", () => {
    const s = openPicker(items, { activeId: "t2" });
    expect(s.mode).toBe("browse");
    expect(s.query).toBe("");
    expect(selectedTab(s)).toBe("t2");
    expect(selectedTab(press(s, ["j"]).state)).toBe("t3");
    expect(selectedTab(press(s, ["j", "down", "ctrl+n"]).state)).toBe("t4");
    expect(selectedTab(press(s, ["k", "up"]).state)).toBe("t1");
    const top = press(s, ["ctrl+p"]).state;
    expect(selectedTab(top)).toBe("t1");
    expect(pickerKey(top, "ctrl+p").state).toBe(top);
    expect(selectedTab(openPicker(items, {}))).toBe("t1");
  });

  test("left/right jump between workspace sections", () => {
    const s = openPicker(items, { activeId: "t1" });
    const r = press(s, ["right"]).state;
    expect(selectedTab(r)).toBe("t3");
    expect(pickerKey(r, "right").state).toBe(r);
    expect(selectedTab(press(r, ["left"]).state)).toBe("t1");
    expect(selectedTab(press(r, ["j", "left"]).state)).toBe("t3");
    expect(pickerKey(s, "left").state).toBe(s);
    const filtered = press(s, ["/", "a", "esc"]).state;
    expect(pickerKey(filtered, "right").state).toBe(filtered);
  });

  test("/ searches; typing filters; editing keys; esc backs out then closes", () => {
    const s = openPicker(items, { activeId: "t1" });
    let r = press(s, ["/", "g", "i", "t"]).state;
    expect(r.mode).toBe("search");
    expect(r.query).toBe("git");
    expect(r.matches.map((m) => tabIdOf(m.item))).toEqual(["t1"]);
    r = press(r, ["backspace"]).state;
    expect(r.query).toBe("gi");
    r = press(r, ["ctrl+w"]).state;
    expect(r.query).toBe("");
    r = press(r, ["w", "o", "r", "k", "space", "shift+m", "a", "i", "l"]).state;
    expect(r.query).toBe("work Mail");
    expect(selectedTab(r)).toBe("t2");
    expect(press(r, ["ctrl+w"]).state.query).toBe("work ");
    expect(press(r, ["ctrl+u"]).state.query).toBe("");
    const back = press(r, ["esc"]);
    expect(back.effect).toBeNull();
    expect(back.state.mode).toBe("browse");
    expect(back.state.query).toBe("work Mail");
    expect(press(back.state, ["esc"]).effect).toEqual({ type: "close" });
    expect(press(s, ["q"]).effect).toEqual({ type: "close" });
  });

  test("ctrl-w deletes the last word in linear time (CodeQL js/polynomial-redos)", () => {
    const search = press(openPicker(items, {}), ["/"]).state;
    const long = { ...search, query: `${" ".repeat(200_000)}x` };
    const start = performance.now();
    const r = press(long, ["ctrl+w"]).state;
    expect(performance.now() - start).toBeLessThan(budget(1000));
    expect(r.query).toBe(" ".repeat(200_000));
  });

  test("in search, j and k type; arrows and ctrl-n/p move", () => {
    const s = press(openPicker(items, {}), ["/", "j", "k"]).state;
    expect(s.query).toBe("jk");
    const t = press(openPicker(items, {}), ["/", "a", "down"]).state;
    expect(t.selected).toBe(1);
    expect(press(t, ["ctrl+p"]).state.selected).toBe(0);
  });

  test("enter selects; nothing to select is a no-op; unknown keys are ignored", () => {
    const s = openPicker(items, { activeId: "t1" });
    expect(press(s, ["j", "enter"]).effect).toEqual({ type: "select", id: "t2" });
    expect(press(s, ["/", "c", "o", "o", "k", "enter"]).effect).toEqual({
      type: "select",
      id: "t3",
    });
    const none = press(s, ["/", "z", "z", "z"]).state;
    expect(none.matches).toEqual([]);
    expect(pickerSelection(none)).toBeUndefined();
    expect(pickerKey(none, "enter")).toEqual({ state: none, effect: null });
    expect(pickerKey(none, "down").state).toBe(none);
    expect(pickerKey(s, "x").state).toBe(s);
    expect(pickerKey(s, "ctrl+x").state).toBe(s);
    const searching = press(s, ["/"]).state;
    expect(pickerKey(searching, "ctrl+x").state).toBe(searching);
    expect(pickerKey(searching, "backspace").state).toBe(searching);
    expect(pickerKey(searching, "f5").state).toBe(searching);
  });

  test("setPickerItems keeps the selected tab, or clamps", () => {
    const s = openPicker(items, { activeId: "t3" });
    const without1 = setPickerItems(
      s,
      items.filter((i) => i.tabId !== "t1"),
    );
    expect(selectedTab(without1)).toBe("t3");
    const last = openPicker(items, { activeId: "t4" });
    expect(selectedTab(setPickerItems(last, items.slice(0, 2)))).toBe("t2");
    expect(setPickerItems(last, []).selected).toBe(0);
  });
});

describe("properties", () => {
  const text = fc.string({ minLength: 1, maxLength: 24 });
  const field = fc.constantFrom("display", "title", "url", "workspace");

  const isSubsequence = (q: string, s: string) => {
    let i = 0;
    for (const ch of s.toLowerCase()) if (ch === q.toLowerCase()[i]) i++;
    return i === q.length;
  };

  const wellFormed = (ranges: [number, number][], s: string) => {
    for (let i = 0; i < ranges.length; i++) {
      const [a, b] = ranges[i] as [number, number];
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(s.length);
      expect(a).toBeLessThan(b);
      if (i > 0) expect(a).toBeGreaterThan((ranges[i - 1] as [number, number])[1]);
    }
  };

  test("a substring always matches with tier ≥ substring, and its range spells it", () => {
    fc.assert(
      fc.property(text, fc.nat(), fc.nat(), field, (s, x, y, f) => {
        const i = x % s.length;
        const j = i + 1 + (y % (s.length - i));
        const q = s.slice(i, j);
        fc.pre(!/\s/.test(q));
        const m = scoreField(s, q, f);
        expect(m).not.toBeNull();
        expect(m?.tier).toBeGreaterThanOrEqual(TIER.substring);
        expect(m?.ranges.length).toBe(1);
        const [a, b] = (m && m.ranges[0]) as [number, number];
        expect(s.slice(a, b).toLowerCase()).toBe(q.toLowerCase());
      }),
    );
  });

  test("matches iff the term is a subsequence; ranges are well formed and spell the term", () => {
    fc.assert(
      fc.property(text, fc.string({ minLength: 1, maxLength: 4 }), (s, q) => {
        fc.pre(!/\s/.test(q));
        const m = scoreField(s, q);
        expect(m !== null).toBe(isSubsequence(q, s));
        if (m) {
          wellFormed(m.ranges, s);
          const spelled = m.ranges.map(([a, b]) => s.slice(a, b)).join("");
          expect(spelled.toLowerCase()).toBe(q.toLowerCase());
        }
      }),
    );
  });

  test("a better tier always scores higher, whatever the field; exact beats everything", () => {
    const pair = fc
      .tuple(text, fc.array(fc.nat(), { minLength: 1, maxLength: 5 }), field)
      .map(([s, picks, f]) => {
        const idx = [...new Set(picks.map((p) => p % s.length))].sort((a, b) => a - b);
        return { s, q: idx.map((i) => s[i]).join(""), f };
      })
      .filter(({ q }) => !/\s/.test(q));
    fc.assert(
      fc.property(pair, pair, (a, b) => {
        const ma = scoreField(a.s, a.q, a.f);
        const mb = scoreField(b.s, b.q, b.f);
        if (!ma || !mb) return;
        if (ma.tier > mb.tier) expect(ma.score).toBeGreaterThan(mb.score);
        expect(Math.floor(ma.score / 1000)).toBe(ma.tier);
        fc.pre(!/\s/.test(a.s));
        const exact = scoreField(a.s, a.s, a.f) as { score: number };
        if (a.q.toLowerCase() !== a.s.toLowerCase()) expect(exact.score).toBeGreaterThan(ma.score);
      }),
    );
  });

  test("filterItems is sorted by score, ties in input order", () => {
    const alpha = fc.string({ unit: fc.constantFrom(..."abc "), maxLength: 8 });
    fc.assert(
      fc.property(
        fc.array(fc.record({ title: alpha, url: alpha }), { maxLength: 8 }),
        fc.string({ unit: fc.constantFrom(..."abc "), maxLength: 4 }),
        (rows, query) => {
          const ws = fixture({
            active: "w1",
            workspaces: [
              { id: "w1", name: "ws", tabs: rows.map((_, i) => `t${i}`), activeTab: null },
            ],
          });
          const list = pickerItems(ws, (id) => rows[Number(id.slice(1))], {});
          const out = filterItems(list, query);
          for (let i = 1; i < out.length; i++) {
            const p = out[i - 1];
            const c = out[i];
            if (!p || !c) throw new Error("a hole in the matches");
            expect(p.score).toBeGreaterThanOrEqual(c.score);
            if (p.score === c.score)
              expect(list.findIndex((x) => x === p.item)).toBeLessThan(
                list.findIndex((x) => x === c.item),
              );
          }
          const fields: readonly Field[] = ["display", "title", "url", "workspace", "markers"];
          for (const m of out) {
            const item = list.find((x) => x === m.item);
            if (!item) throw new Error("a match of an item not in the list");
            for (const [k, r] of Object.entries(m.highlights)) {
              expect(fields).toContain(k);
              expect(r).toBeDefined();
              const field = fields.find((f) => f === k);
              if (!field || !r) throw new Error(`a highlight of ${k} without ranges`);
              wellFormed(r, (field === "workspace" ? item.workspaceName : item[field]) ?? "");
            }
          }
        },
      ),
    );
  });
});

describe("workspace picker (m3-workspaces 5)", () => {
  const model = fixture({
    active: "w2",
    workspaces: [
      { id: "w1", name: "work", tabs: ["t1", "t2"], activeTab: "t2" },
      { id: "w2", name: "personal", tabs: ["t3"], activeTab: "t3" },
      { id: "w3", name: "admin", tabs: [], activeTab: null },
    ],
  });
  const ws = workspaceItems(model, (id) => id === "t1");
  const selectedWs = (s: PickerState) => workspaceIdOf(pickerSelection(s)?.item);

  test("one item per workspace in order, with its tab and foreign counts; the active marked", () => {
    expect(ws).toEqual([
      {
        kind: "workspace",
        workspaceId: "w1",
        workspaceName: "work",
        workspaceIndex: 1,
        tabCount: 2,
        foreignCount: 1,
        display: "work",
        active: false,
      },
      expect.objectContaining({ workspaceId: "w2", tabCount: 1, foreignCount: 0, active: true }),
      expect.objectContaining({ workspaceId: "w3", workspaceIndex: 3, tabCount: 0 }),
    ]);
    expect(Object.isFrozen(ws[0])).toBe(true);
    expect(workspaceItems(model)[0]?.foreignCount).toBe(0);
  });

  test("filters by name only, with highlights", () => {
    const m = filterItems(ws, "ad");
    expect(m.map((x) => workspaceIdOf(x.item))).toEqual(["w3"]);
    expect(m[0]?.highlights).toEqual({ display: [[0, 2]] });
    expect(filterItems(ws, "github")).toEqual([]);
  });

  test("opens on the active workspace; enter switches; m moves; m types in search", () => {
    const s = openPicker(ws, { activeId: "w2" });
    expect(selectedWs(s)).toBe("w2");
    expect(press(s, ["k", "enter"]).effect).toEqual({ type: "select", id: "w1" });
    expect(press(s, ["j", "m"]).effect).toEqual({ type: "move", id: "w3" });
    const typed = press(s, ["/", "m"]);
    expect(typed.effect).toBeNull();
    expect(typed.state.query).toBe("m");
    expect(press(s, ["/", "w", "o", "enter"]).effect).toEqual({ type: "select", id: "w1" });
    expect(press(s, ["esc"]).effect).toEqual({ type: "close" });
  });

  test("m in the goto picker does nothing", () => {
    const s = openPicker(items, { activeId: "t1" });
    expect(pickerKey(s, "m")).toEqual({ state: s, effect: null });
  });

  test("setPickerItems keeps the selected workspace", () => {
    const s = openPicker(ws, { activeId: "w3" });
    const [a, b, c] = model.workspaces;
    if (!a || !b || !c) throw new Error("the model has three workspaces");
    const reordered = workspaceItems({ ...model, workspaces: [c, a, b].map((w) => ({ ...w })) });
    expect(selectedWs(setPickerItems(s, reordered))).toBe("w3");
  });
});

describe("tab search (docs/specs/tab-search.md)", () => {
  const model = fixture({
    active: "w2",
    workspaces: [
      { id: "w1", name: "work", tabs: ["t1", "t2"], activeTab: "t2" },
      { id: "wa", name: "agent", tabs: ["a1"], activeTab: "a1" },
      { id: "w2", name: "personal", tabs: ["t3", "t4"], activeTab: "t3" },
    ],
  });
  const tabInfo: Record<
    string,
    { title: string; url: string; playing?: boolean; muted?: boolean; pinned?: boolean }
  > = {
    t1: { title: "Jira 412", url: "https://jira.example.com/412", playing: true },
    t2: { title: "Docs", url: "https://docs.example.com/" },
    a1: { title: "Docs", url: "https://docs.example.com/agent" },
    t3: { title: "Radio", url: "https://radio.fi/", muted: true },
    t4: { title: "Pinned mail", url: "https://mail.fi/", pinned: true },
  };
  const tabs = pickerItems(model, (id) => tabInfo[id], {}, { agentId: "wa" });
  const closed = {
    ...tabs[0],
    tabId: "closed:7",
    title: "Old docs",
    url: "https://docs.example.com/old",
    display: "Old docs",
    closed: true,
    tabIndex: 0,
    active: false,
    markers: "closed",
    playing: undefined,
  } as unknown as PickerItem;
  const list = [...tabs, closed];

  test("the current workspace comes first, the agent workspace last, rows marked", () => {
    expect(tabs.map((i) => [i.tabId, i.workspaceName, i.tabIndex])).toEqual([
      ["t3", "personal", 1],
      ["t4", "personal", 2],
      ["t1", "work", 1],
      ["t2", "work", 2],
      ["a1", "agent", 1],
    ]);
    expect(tabs.filter((i) => i.agent).map((i) => i.tabId)).toEqual(["a1"]);
    expect(tabs.find((i) => i.tabId === "t1")).toMatchObject({ playing: true, markers: "playing" });
    expect(tabs.find((i) => i.tabId === "t3")).toMatchObject({ muted: true, markers: "muted" });
    expect(tabs.find((i) => i.tabId === "t4")).toMatchObject({ pinned: true, markers: "pinned" });
    expect(tabs.find((i) => i.tabId === "a1")?.markers).toBe("agent");
    // Another window keeps its own order (only the agent moves last) and carries its number.
    const other = pickerItems(model, (id) => tabInfo[id], {}, { agentId: "wa", window: 2 });
    expect(other.map((i) => i.tabId)).toEqual(["t1", "t2", "t3", "t4", "a1"]);
    expect(other.every((i) => i.window === 2)).toBe(true);
    expect(tabs.some((i) => "window" in i)).toBe(false);
  });

  test("marker words are a searchable field; a tie never ranks an agent row first", () => {
    expect(filterItems(list, "playing").map((m) => tabIdOf(m.item))).toEqual(["t1"]);
    expect(filterItems(list, "muted").map((m) => tabIdOf(m.item))).toEqual(["t3"]);
    expect(filterItems(list, "closed").map((m) => tabIdOf(m.item))).toEqual(["closed:7"]);
    expect(filterItems(list, "old").map((m) => tabIdOf(m.item))).toEqual(["closed:7"]);
    expect(filterItems(list, "docs.example.com/old")[0]?.highlights.url).toEqual([[8, 28]]);
    const agentFirst = [tabs[4] as PickerItem, tabs[3] as PickerItem];
    const docs = filterItems(agentFirst, "docs").map((m) => tabIdOf(m.item));
    expect(docs).toEqual(["t2", "a1"]);
  });

  test("Enter on a closed row reopens it; no key manages tabs from the list", () => {
    const s = openPicker(list, { activeId: "closed:7" });
    expect(press(s, ["enter"]).effect).toEqual({ type: "reopen", id: "closed:7" });
    expect(press(openPicker(list, { activeId: "t1" }), ["enter"]).effect).toEqual({
      type: "select",
      id: "t1",
    });
    // The side panel manages tabs; the list only finds them (docs/specs/tab-search.md, 7).
    for (const key of ["x", "u", "m", "d"]) {
      expect(pickerKey(s, key), key).toEqual({ state: s, effect: null });
    }
  });

  test("type-first: every letter types, Esc closes, ctrl+n/p and arrows move", () => {
    const s = openPicker(list, { activeId: "t3", typeFirst: true });
    expect(s.mode).toBe("search");
    expect(selectedTab(s)).toBe("t3");
    const typed = press(s, ["j", "k", "x", "u", "m", "q", "/"]);
    expect(typed.effect).toBeNull();
    expect(typed.state.query).toBe("jkxumq/");
    expect(press(s, ["esc"]).effect).toEqual({ type: "close" });
    expect(press(s, ["r", "esc"]).effect).toEqual({ type: "close" });
    expect(selectedTab(press(s, ["ctrl+n"]).state)).toBe("t4");
    expect(selectedTab(press(s, ["down", "up", "ctrl+p"]).state)).toBe("t3");
    expect(press(s, ["d", "o", "c", "s", "backspace"]).state.query).toBe("doc");
  });

  test("tab and shift+tab jump sections, with a query and in search mode too", () => {
    const s = openPicker(list, { activeId: "t3" });
    const ids = (x: PickerState) => selectedTab(x);
    expect(ids(press(s, ["tab"]).state)).toBe("t1");
    expect(ids(press(s, ["tab", "tab"]).state)).toBe("a1");
    expect(ids(press(s, ["tab", "tab", "tab"]).state)).toBe("closed:7");
    expect(ids(press(s, ["tab", "tab", "tab", "tab"]).state)).toBe("closed:7");
    expect(ids(press(s, ["tab", "tab", "shift+tab"]).state)).toBe("t1");
    expect(ids(press(s, ["j", "shift+tab"]).state)).toBe("t3");
    // With a query, the next section's best match; search mode stays.
    const q = press(s, ["/", "d", "o", "c", "s"]).state;
    expect(q.matches.map((m) => tabIdOf(m.item))).toEqual(["t2", "a1", "closed:7"]);
    const next = press(q, ["tab"]).state;
    expect(ids(next)).toBe("a1");
    expect(next.mode).toBe("search");
    expect(next.query).toBe("docs");
    expect(ids(press(next, ["tab"]).state)).toBe("closed:7");
    expect(ids(press(next, ["shift+tab"]).state)).toBe("t2");
    // The add-on and workspace pickers have one section: nothing to jump to.
    const one = openPicker(tabs.slice(0, 2), {});
    expect(pickerKey(one, "tab").state).toBe(one);
  });

  test("openPicker can start type-first with a query already typed (:tabsearch text)", () => {
    const s = openPicker(list, { activeId: "t1", typeFirst: true, query: "radio" });
    expect(s.mode).toBe("search");
    expect(s.query).toBe("radio");
    expect(s.matches.map((m) => tabIdOf(m.item))).toEqual(["t3"]);
    expect(openPicker(list, { typeFirst: true }).query).toBe("");
    expect(openPicker(list, {}).mode).toBe("browse");
  });

  /** 500 open and 25 closed items with the picker in search, and the keys of a typical search. */
  const bigSearch = () => {
    const words = ["jira", "docs", "mail", "calendar", "bank", "news", "radio", "wiki", "git"];
    const big = Array.from({ length: 525 }, (_, n) => ({
      ...(tabs[0] as PickerItem),
      tabId: `b${n}`,
      title: `${words[n % words.length]} ${n} – ${words[(n * 7) % words.length]} board`,
      display: `${words[n % words.length]} ${n} – ${words[(n * 7) % words.length]} board`,
      url: `https://${words[(n * 3) % words.length]}.example.com/item/${n}`,
      workspaceName: `ws${n % 5}`,
      ...(n >= 500 ? { closed: true as const, markers: "closed" } : {}),
    }));
    const start = press(openPicker(big, {}), ["/"]).state;
    const keys = [..."abc", "space", ..."def", "ctrl+w", ..."jira", "ctrl+u", ..."docs"];
    keys.push("space", ..."wiki", "backspace", "backspace");
    /** One pass over `keys`. */
    const pass = () => keys.reduce((s, key) => pickerKey(s, key).state, start);
    return { big, start, keys, pass };
  };

  // Decision 10's budget (each key under 8 ms) is pinned by the work a key does, not by timing
  // it: a wall-clock budget in the unit suite measures the runner, and failed on loaded ones
  // (issue #1144). These counts are the same on any machine.
  test("500 open and 25 closed items: each text's units are built once", () => {
    const { pass } = bigSearch();
    pass();
    const before = unitsBuilt();
    pass();
    // Every text was segmented in the first pass: the second builds no units at all.
    expect(unitsBuilt() - before).toBe(0);
  });

  test("500 open and 25 closed items: a key matches each field once per term, in one pass", () => {
    const { big, start, keys } = bigSearch();
    // The fields matchItem reads of a tab row: display, url and workspace, and title and markers
    // when set.
    const fieldsOf = (item: PickerItem) => 3 + (item.label ? 1 : 0) + (item.markers ? 1 : 0);
    /**
     * The fields one pass over the list tries for `query`: every item's fields for the first
     * term, and for each later term only the items that matched every earlier one.
     */
    const onePass = (query: string) => {
      const terms = query.trim().split(/\s+/).filter(Boolean);
      let n = 0;
      for (const item of big) {
        for (let k = 0; k < terms.length; k++) {
          n += fieldsOf(item);
          if (!matchItem(item, terms.slice(0, k + 1).join(" "))) break;
        }
      }
      return n;
    };
    // The counts cannot see the work after the match (sorting, the rows shown) or how long each
    // field takes; timing belongs in tools/bench, which measures against a baseline on one machine.
    let s = start;
    let scored = 0;
    for (const key of keys) {
      const before = matchWork();
      s = pickerKey(s, key).state;
      const work = matchWork();
      const tried = work.tried - before.tried;
      const expected = onePass(s.query);
      expect(tried, key).toBe(expected);
      // A field whose letters do not occur in order is dropped before any tier is tried.
      expect(work.full - before.full, key).toBe(work.matched - before.matched);
      if (tried) scored++;
    }
    // Most keys of the sequence change the query and match the list again.
    expect(scored).toBeGreaterThanOrEqual(20);
  });
});

describe("downloads picker (docs/specs/downloads.md)", () => {
  const record = (id: number, over: Partial<DownloadRecord> = {}): DownloadRecord => ({
    id,
    name: `file${id}.pdf`,
    url: `https://files${id}.example.com/get?token=secret`,
    path: `/home/u/Downloads/file${id}.pdf`,
    referrer: null,
    stopped: true,
    succeeded: true,
    canceled: false,
    deleted: false,
    hasProgress: true,
    hasPartialData: false,
    hasBlockedData: false,
    currentBytes: 100,
    totalBytes: 100,
    size: 100,
    speed: 0,
    targetExists: true,
    partFileExists: false,
    error: null,
    startTime: id * 1000,
    endTime: id * 1000 + 500,
    viewsInternally: true,
    workspace: null,
    agent: false,
    ...over,
  });
  const NOW = 10_000;
  const running = { stopped: false, succeeded: false, currentBytes: 50, hasPartialData: true };
  const rows = () =>
    downloadSections([record(1), record(2, { workspace: "work" }), record(3, running)], NOW);

  test("a download row's keys give a download effect; / types them", () => {
    let s = openPicker(rows());
    // The running one heads the active section.
    expect(pickerSelection(s)?.item).toMatchObject({ kind: "download", downloadId: "3" });
    s = pickerKey(s, "j").state;
    for (const key of ["o", "shift+o", "s", "y", "shift+y", "u", "shift+l", "enter"]) {
      expect(pickerKey(s, key).effect, key).toEqual({ type: "download", key, id: "2" });
    }
    // Pause, cancel, retry, remove and delete (docs/specs/downloads.md, Delivery 4).
    for (const key of ["p", "c", "r", "d", "shift+d"]) {
      expect(pickerKey(s, key).effect, key).toEqual({ type: "download", key, id: "2" });
    }
    // Allow or remove a blocked one through Firefox's dialog (Delivery 5).
    expect(pickerKey(s, "!").effect).toEqual({ type: "download", key: "!", id: "2" });
    expect(pickerKey(s, "x").effect).toBeNull();
    expect(pickerKey(s, "q").effect).toEqual({ type: "close" });
    s = pickerKey(s, "/").state;
    for (const key of ["o", "s", "y", "u", "!"]) {
      const r = pickerKey(s, key);
      expect(r.effect, key).toBeNull();
      s = r.state;
    }
    expect(s.query).toBe("osyu!");
  });

  test("the filter matches name, host, state and workspace", () => {
    const ids = (q: string) =>
      filterItems(rows(), q).map((m) => ("downloadId" in m.item ? m.item.downloadId : undefined));
    expect(ids("file1")).toEqual(["1"]);
    expect(ids("files2.example")).toEqual(["2"]);
    expect(ids("50%")).toEqual(["3"]);
    expect(ids("work")).toEqual(["2"]);
    expect(ids("token")).toEqual([]);
    const third = rows()[2];
    if (!third) throw new Error("no third row");
    expect(matchItem(third, "file1")?.highlights.display).toEqual([[0, 5]]);
  });

  test("sections are active and recent", () => {
    expect(rows().map(sectionOf)).toEqual(["active", "recent", "recent"]);
  });

  test("the highlight stays on its download when rows move", () => {
    let s = openPicker(rows());
    s = pickerKey(s, "j").state;
    expect(pickerSelection(s)?.item).toMatchObject({ downloadId: "2" });
    const moved = downloadSections(
      [record(1), record(2, { workspace: "work" }), record(4, running), record(3, running)],
      NOW,
    );
    s = setPickerItems(s, moved);
    expect(pickerSelection(s)?.item).toMatchObject({ downloadId: "2" });
    expect(s.selected).toBe(2);
  });
});

describe("split picker (docs/specs/multiple-splits.md behaviour 7)", () => {
  let model = createSplits();
  for (const tabs of [
    ["a", "b"],
    ["c", "d"],
    ["e", "f"],
  ])
    model = newSplit(model, tabs).splits;
  const titles = {
    a: "Editor",
    b: "PDF",
    c: "Search",
    d: "Docs",
    e: "Mail",
    f: "Calendar",
  } as Record<string, string>;
  const items = splitPickerItems(model, (id) => titles[id] ?? "");
  const selectedSplit = (s: PickerState) => splitIdOf(pickerSelection(s)?.item);

  test("opens on the shown split; Enter shows the selected one", () => {
    let s = openPicker(items, { activeId: "3" });
    expect(selectedSplit(s)).toBe("3");
    s = pickerKey(s, "k").state;
    expect(pickerKey(s, "enter").effect).toEqual({ type: "select", id: "2" });
  });

  test("a digit shows that split at once; a digit without a split does nothing", () => {
    const s = openPicker(items, { activeId: "3" });
    expect(pickerKey(s, "1").effect).toEqual({ type: "select", id: "1" });
    expect(pickerKey(s, "2").effect).toEqual({ type: "select", id: "2" });
    expect(pickerKey(s, "7")).toEqual({ state: s, effect: null });
  });

  test("typing after / filters by the panes' titles", () => {
    let s = openPicker(items, { activeId: "1" });
    for (const k of ["/", "c", "a", "l"]) s = pickerKey(s, k).state;
    expect(s.matches.map((m) => splitIdOf(m.item))).toEqual(["3"]);
    // In search mode a digit is typed, not a split picked.
    expect(pickerKey(s, "2").effect).toBeNull();
    expect(pickerKey(s, "enter").effect).toEqual({ type: "select", id: "3" });
  });
});

// Issue #1119: the behaviours below were not pinned by any test, so mutation testing could change
// them unnoticed.
describe("scores and highlights, exactly", () => {
  test("a score adds the tier band, the field's weight and three bonuses that never go negative", () => {
    // exact, display: 5000 + 300 + 200 (start 0) + 200 (no gaps) + 188 (6 clusters)
    expect(scoreField("GitHub", "github")?.score).toBe(5888);
    // word, url: 3000 + 150 + 170 (start 3) + 200 + 182 (9 clusters)
    expect(scoreField("my-github", "git", "url")?.score).toBe(3702);
    // subsequence, title: 1000 + 250 + 200 + 125 (3 gaps) + 188
    expect(scoreField("GitHub", "ghb", "title")?.score).toBe(1763);
    // start 30, 10 gaps, 122 clusters: each bonus stops at 0
    const far = `${"-".repeat(30)}a${"-".repeat(10)}b${"-".repeat(80)}`;
    expect(scoreField(far, "ab", "markers")).toEqual({
      tier: TIER.subsequence,
      score: 1050,
      ranges: [
        [30, 31],
        [41, 42],
      ],
    });
  });

  test("a folded match is scored on the folded text", () => {
    // 0 + 300 + 200 + 200 + 182 (9 folded clusters)
    expect(scoreField("Käyttäjät", "ka")?.score).toBe(882);
    // a folded subsequence: k, a, t with one gap
    expect(scoreField("Käyttäjät", "kat")).toEqual({
      tier: TIER.folded,
      score: 857,
      ranges: [
        [0, 2],
        [3, 4],
      ],
    });
    // A lone combining mark folds to nothing: it is skipped, not matched, and not counted.
    expect(scoreField("́éa", "ea")).toEqual({ tier: TIER.folded, score: 896, ranges: [[1, 3]] });
    // A query of marks alone has nothing to match.
    expect(scoreField("abc", "́")).toBeNull();
    // A Hangul syllable folds to its jamo, but one jamo is not a match.
    expect(scoreField("각", "ᄀ")).toBeNull();
  });

  test("word starts: after a non-letter, and an upper-case letter after a lower-case one", () => {
    // A cluster that starts with a format character is not a letter, even with a digit in it.
    expect(scoreField("؀1abc", "abc")).toMatchObject({ tier: TIER.word, ranges: [[2, 5]] });
    // Upper after upper, upper after a digit, a digit after a lower-case letter: no word start.
    expect(scoreField("GITHUB", "hub")?.tier).toBe(TIER.substring);
    expect(scoreField("git2Hub", "hub")?.tier).toBe(TIER.substring);
    expect(scoreField("git2go", "2go")?.tier).toBe(TIER.substring);
    // A title-case letter (ǅ) is neither upper nor lower case.
    expect(scoreField("ǅHub", "hub")?.tier).toBe(TIER.substring);
    expect(scoreField("aǅb", "ǆb")?.tier).toBe(TIER.substring);
    expect(scoreField("gitHub", "hub")?.tier).toBe(TIER.word);
  });

  test("subsequence: each letter after the last, the tightest span, the earliest on a tie", () => {
    expect(scoreField("abxb", "abb")?.ranges).toEqual([
      [0, 2],
      [3, 4],
    ]);
    expect(scoreField("ayb axxb", "ab")?.ranges).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(scoreField("ayb azb", "ab")?.ranges).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(scoreField("abxxxc a-b-c", "abc")?.ranges).toEqual([
      [7, 8],
      [9, 10],
      [11, 12],
    ]);
  });

  test("a field whose letters are not all there in order is dropped before any tier", () => {
    const before = matchWork();
    // Texts no other test uses, so that their units are built here.
    expect(scoreField("zq order 1119", "qz")).toBeNull();
    expect(scoreField("abc", "xyz")).toBeNull();
    const after = matchWork();
    expect(after.tried - before.tried).toBe(2);
    expect(after.full - before.full).toBe(0);
    expect(after.matched - before.matched).toBe(0);
    expect(scoreField("abc", "b")).not.toBeNull();
    expect(matchWork().matched - after.matched).toBe(1);
    expect(scoreField("Käyttäjät 1119", "ka")?.tier).toBe(TIER.folded);
    expect(matchWork().matched - after.matched).toBe(2);
  });

  test("a term's highlights in one field merge when they touch, and stay apart otherwise", () => {
    const tab = (display: string) =>
      ({
        ...(items[0] as PickerItem),
        display,
        title: "",
        url: "",
        workspaceName: "",
      }) as PickerItem;
    expect(matchItem(tab("GitHub"), "hub git")?.highlights).toEqual({ display: [[0, 6]] });
    expect(matchItem(tab("GitHub"), "git hub")?.highlights).toEqual({ display: [[0, 6]] });
    expect(matchItem(tab("abc xyz"), "xyz abc")?.highlights).toEqual({
      display: [
        [0, 3],
        [4, 7],
      ],
    });
    expect(matchItem(tab("abcdef"), "bcd abcdef")?.highlights).toEqual({ display: [[0, 6]] });
  });

  test("each field highlights under its own name; a tie keeps the earlier field", () => {
    const base = items[0] as PickerItem;
    const row = (over: Partial<PickerItem>) => ({ ...base, ...over }) as PickerItem;
    const plain = row({
      display: "Zed",
      title: "Zed",
      label: null,
      url: "u",
      workspaceName: "home",
    });
    expect(matchItem(plain, "home")?.highlights).toEqual({ workspace: [[0, 4]] });
    // An unlabelled tab without markers has no title or marker field to match "t" in.
    expect(matchItem(plain, "t")).toBeNull();
    expect(matchItem(row({ ...plain, markers: "pinned" }), "pin")?.highlights).toEqual({
      markers: [[0, 3]],
    });
    // display "abc" + 26 more (29 clusters) and title "abcd" both score 4842
    const tie = row({ ...plain, label: "x", display: `abc${"-".repeat(26)}`, title: "abcd" });
    expect(matchItem(tie, "abc")).toMatchObject({ score: 4842, highlights: { display: [[0, 3]] } });
    // A blank query matches with no terms.
    expect(matchItem(plain, "   ")).toEqual({ item: plain, score: 0, highlights: {} });
  });

  test("a workspace row matches its name only; a download its name, host, state and workspace", () => {
    const ws = workspaceItems(
      fixture({
        active: "w1",
        workspaces: [{ id: "w1", name: "home", tabs: [], activeTab: null }],
      }),
    );
    const before = matchWork().tried;
    expect(matchItem(ws[0] as AnyItem, "ho")?.highlights).toEqual({ display: [[0, 2]] });
    expect(matchWork().tried - before).toBe(1);
    const download = {
      kind: "download",
      downloadId: "9",
      section: "recent",
      display: "report.pdf",
      host: "files.example.com",
      state: "done",
      workspace: null,
    } as unknown as AnyItem;
    expect(matchItem(download, "example")?.highlights).toEqual({ markers: [[17, 24]] });
  });

  test("ids and sections of every kind of row", () => {
    expect(itemId({ kind: "log", logId: "L1" } as unknown as AnyItem)).toBe("L1");
    expect(
      markerWords({ playing: true, muted: true, pinned: true, agent: true, closed: true }),
    ).toBe("playing muted pinned agent closed");
    expect(markerWords({})).toBe("");
    expect(sectionOf({ kind: "workspace", workspaceId: "w1" } as unknown as AnyItem)).toBe("1/w1");
    expect(sectionOf({ kind: "addon", addonId: "a" } as unknown as AnyItem)).toBe("");
  });
});

describe("the units cache (decision 10)", () => {
  test("is cleared when it holds 8192 texts, so the next new text starts it again", () => {
    // Each new text is built once, and the term "q" too when the cache was just cleared.
    let n = 0;
    const step = () => {
      const before = unitsBuilt();
      scoreField(`cache text ${n++}`, "q");
      return unitsBuilt() - before;
    };
    // The term is in the cache from here on, until a clear.
    step();
    // Wherever the cache stands now, it is cleared within 8193 new texts.
    let k = 0;
    while (step() === 1) if (++k > 8193) throw new Error("the cache was never cleared");
    // It then holds that text and the term; 8190 more fill it, and the next clears it again.
    for (let i = 0; i < 8190; i++) expect(step()).toBe(1);
    expect(step()).toBe(2);
    // A text met again is not built again.
    const before = unitsBuilt();
    scoreField(`cache text ${n - 1}`, "q");
    expect(unitsBuilt()).toBe(before);
  });
});

describe("rows and keys, built inside each test", () => {
  // Built here rather than at the top of the file: a mutation tool runs only the tests that reach
  // a line, and code run while a file loads is reached by none of them.
  const model = () =>
    fixture({
      active: "w2",
      workspaces: [
        { id: "w1", name: "work", tabs: ["t1", "t2"], activeTab: "t2" },
        { id: "w2", name: "home", tabs: ["t3", "t4"], activeTab: "t4" },
        { id: "w3", name: "misc", tabs: ["t5"], activeTab: "t5" },
      ],
    });
  const tabInfo = (id: string) =>
    ({
      t1: { title: "One", url: "https://one.test/", playing: true, muted: true, pinned: true },
      t2: { title: "Two", url: "https://two.test/" },
      t3: { title: "Three", url: "https://three.test/" },
      t4: { title: "Four", url: "https://four.test/" },
      t5: { title: "Five", url: "https://five.test/" },
    })[id];

  test("a tab row: its place, flags, markers and label", () => {
    const rows = pickerItems(model(), tabInfo, { t3: "renamed" });
    expect(rows.map((r) => r.tabId)).toEqual(["t3", "t4", "t1", "t2", "t5"]);
    expect(rows.filter((r) => r.active).map((r) => r.tabId)).toEqual(["t4"]);
    expect(rows.find((r) => r.tabId === "t1")).toStrictEqual({
      tabId: "t1",
      workspaceId: "w1",
      workspaceName: "work",
      workspaceIndex: 1,
      tabIndex: 1,
      title: "One",
      url: "https://one.test/",
      label: null,
      display: "One",
      active: false,
      markers: "playing muted pinned",
      playing: true,
      muted: true,
      pinned: true,
    });
    expect(rows.find((r) => r.tabId === "t3")).toMatchObject({
      label: "renamed",
      display: "renamed",
    });
    expect(rows.find((r) => r.tabId === "t5")).toMatchObject({ workspaceIndex: 3, tabIndex: 1 });
    expect(Object.keys(rows.find((r) => r.tabId === "t2") ?? {})).not.toContain("markers");
    // Another window lists its workspaces in their own order, the agent's last.
    const other = pickerItems(model(), tabInfo, {}, { window: 3, agentId: "w1" });
    expect(other.map((r) => r.tabId)).toEqual(["t3", "t4", "t5", "t1", "t2"]);
    expect(other.find((r) => r.tabId === "t1")?.markers).toBe("playing muted pinned agent");
  });

  test("another window lists its workspaces in their order", () => {
    const five = fixture({
      active: "w3",
      workspaces: ["w1", "w2", "w3", "w4", "w5"].map((id) => ({
        id,
        name: id,
        tabs: [`${id}t`],
        activeTab: `${id}t`,
      })),
    });
    const rows = pickerItems(five, () => undefined, {}, { window: 2 });
    expect(rows.map((r) => r.workspaceId)).toEqual(["w1", "w2", "w3", "w4", "w5"]);
    expect(rows.filter((r) => r.active).map((r) => r.workspaceId)).toEqual(["w3"]);
  });

  test("a workspace row: active, agent and foreign counts", () => {
    const rows = workspaceItems(model(), undefined, "w3");
    expect(rows.map((r) => [r.workspaceId, r.active, r.agent ?? false, r.foreignCount])).toEqual([
      ["w1", false, false, 0],
      ["w2", true, false, 0],
      ["w3", false, true, 0],
    ]);
  });

  test("a blank query opens on the active item; a query on the best", () => {
    const rows = pickerItems(model(), tabInfo, {});
    expect(selectedTab(openPicker(rows, { activeId: "t4", query: " " }))).toBe("t4");
    expect(selectedTab(openPicker(rows, { activeId: "t5", query: "f" }))).toBe("t4");
  });

  test("left and right with a query of spaces still jump sections", () => {
    const rows = pickerItems(model(), tabInfo, {});
    const spaced = press(openPicker(rows, { activeId: "t3" }), ["/", "space", "esc"]).state;
    expect(spaced.query).toBe(" ");
    expect(selectedTab(press(spaced, ["right"]).state)).toBe("t1");
    expect(selectedTab(press(spaced, ["right", "right", "left"]).state)).toBe("t1");
    // Shift+tab with a blank query goes to the start of the section first.
    expect(selectedTab(press(spaced, ["right", "j", "shift+tab"]).state)).toBe("t1");
    const empty = openPicker([]);
    expect(pickerKey(empty, "right").state).toBe(empty);
    expect(pickerKey(empty, "left").state).toBe(empty);
  });

  test("tab with a query: to the next section with a match, and no further than the ends", () => {
    const rows = pickerItems(model(), tabInfo, {});
    // "f" matches Four (home) and Five (misc), not work.
    const s = press(openPicker(rows, { activeId: "t4" }), ["/", "f"]).state;
    expect(s.matches.map((m) => tabIdOf(m.item))).toEqual(["t4", "t5"]);
    const next = press(s, ["tab"]).state;
    expect(selectedTab(next)).toBe("t5");
    expect(pickerKey(next, "tab").state).toBe(next);
    expect(selectedTab(press(next, ["shift+tab"]).state)).toBe("t4");
    expect(pickerKey(s, "shift+tab").state).toBe(s);
    const none = press(s, ["z", "z"]).state;
    expect(none.matches).toEqual([]);
    expect(pickerKey(none, "tab").state).toBe(none);
  });

  test("up moves in browse mode", () => {
    const rows = pickerItems(model(), tabInfo, {});
    expect(selectedTab(press(openPicker(rows, { activeId: "t4" }), ["up"]).state)).toBe("t3");
  });

  test("shifted keys type one upper-case letter, nothing longer", () => {
    expect(typedChar("shift+a")).toBe("A");
    expect(typedChar("shift+ab")).toBeNull();
    expect(typedChar("ctrl+shift+a")).toBeNull();
  });

  test("m moves only a workspace; the permission keys act only on a permission", () => {
    const ws = workspaceItems(model());
    expect(pickerKey(openPicker(ws), "x").effect).toBeNull();
    const addon = { kind: "addon", addonId: "a1", display: "Add-on", active: false } as AnyItem;
    const permission = {
      kind: "permission",
      permissionId: "p1",
      display: "Camera",
      active: false,
    } as unknown as AnyItem;
    expect(pickerKey(openPicker([addon]), "m").effect).toBeNull();
    expect(pickerKey(openPicker([addon]), "a").effect).toBeNull();
    expect(pickerKey(openPicker([permission]), "x").effect).toBeNull();
    expect(pickerKey(openPicker([permission]), "a").effect).toEqual({
      type: "permission",
      op: "allow",
      id: "p1",
    });
  });
});
