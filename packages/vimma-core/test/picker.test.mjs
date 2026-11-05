import { describe, test, expect } from "vitest";
import fc from "fast-check";
import {
  TIER,
  filterItems,
  matchItem,
  openPicker,
  pickerItems,
  pickerKey,
  pickerSelection,
  scoreField,
  sectionOf,
  setPickerItems,
  unitsBuilt,
  workspaceItems,
} from "../src/picker.mjs";
import { downloadSections } from "../src/downloads.mjs";
import { createSplits, newSplit, splitPickerItems } from "../src/splits.mjs";

/** @import { PickerState, PickerItem } from "../src/picker.mjs" */

const workspaces = {
  active: "w1",
  workspaces: [
    { id: "w1", name: "work", tabs: ["t1", "t2"], activeTab: "t2" },
    { id: "w2", name: "personal", tabs: ["t3", "t4"], activeTab: "t3" },
  ],
};
/** @type {Record<string, { title: string, url: string }>} */
const info = {
  t1: { title: "GitHub", url: "https://github.com/" },
  t2: { title: "Mail", url: "https://mail.example.com/" },
  t3: { title: "Recipes", url: "https://recipes.org/" },
  t4: { title: "Bank", url: "https://bank.fi/" },
};
const items = pickerItems(workspaces, (id) => info[id], { t3: "cook" });

/**
 * @param {PickerState} s
 * @param {string[]} keys
 */
function press(s, keys) {
  /** @type {ReturnType<typeof pickerKey>["effect"]} */
  let effect = null;
  for (const k of keys) ({ state: s, effect } = pickerKey(s, k));
  return { state: s, effect };
}

/** @param {PickerState} s */
const selectedTab = (s) => pickerSelection(s)?.item.tabId;

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
    const exact = /** @type {{ score: number }} */ (scoreField("Käyttäjät", "kä"));
    const folded = /** @type {{ score: number }} */ (scoreField("Käyttäjät", "ka"));
    expect(exact.score).toBeGreaterThan(folded.score);
    // a folded match in the best field still loses to an exact subsequence in the worst one
    const sub = /** @type {{ score: number }} */ (scoreField("x-k-y-a", "ka", "workspace"));
    expect(sub.score).toBeGreaterThan(folded.score);
    expect(scoreField("Käyttäjät", "kö")).toBeNull();
  });

  test("tiers beat fields: a URL prefix match outranks a title word match", () => {
    const url = /** @type {{ score: number }} */ (scoreField("github.com/x", "git", "url"));
    const title = /** @type {{ score: number }} */ (scoreField("My github", "git", "title"));
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
    expect(cook.map((m) => m.item.tabId)).toEqual(["t3"]);
    expect(cook[0]?.highlights.display).toEqual([[0, 4]]);
    expect(filterItems(items, "recipes")[0]?.item.tabId).toBe("t3");
    expect(filterItems(items, "recipes")[0]?.highlights.title).toEqual([[0, 7]]);
    expect(filterItems(items, "personal").map((m) => m.item.tabId)).toEqual(["t3", "t4"]);
    expect(filterItems(items, "  work   mail ").map((m) => m.item.tabId)).toEqual(["t2"]);
    expect(filterItems(items, "github.com")[0]?.highlights.url).toEqual([[8, 18]]);
    expect(matchItem(/** @type {PickerItem} */ (items[0]), "zzz")).toBeNull();
  });

  test("a blank query lists everything in order; ties keep input order", () => {
    expect(filterItems(items, " ").map((m) => [m.item.tabId, m.score])).toEqual([
      ["t1", 0],
      ["t2", 0],
      ["t3", 0],
      ["t4", 0],
    ]);
    const twins = pickerItems(
      {
        active: "w1",
        workspaces: [{ id: "w1", name: "a", tabs: ["x", "y", "z"], activeTab: "x" }],
      },
      () => ({ title: "Docs", url: "https://docs.rs/" }),
      {},
    );
    expect(filterItems(twins, "doc").map((m) => m.item.tabId)).toEqual(["x", "y", "z"]);
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
    expect(r.matches.map((m) => m.item.tabId)).toEqual(["t1"]);
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
    expect(performance.now() - start).toBeLessThan(1000);
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

  /** @param {string} q @param {string} s */
  const isSubsequence = (q, s) => {
    let i = 0;
    for (const ch of s.toLowerCase()) if (ch === q.toLowerCase()[i]) i++;
    return i === q.length;
  };

  /** @param {[number, number][]} ranges @param {string} s */
  const wellFormed = (ranges, s) => {
    for (let i = 0; i < ranges.length; i++) {
      const [a, b] = /** @type {[number, number]} */ (ranges[i]);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(s.length);
      expect(a).toBeLessThan(b);
      if (i > 0) expect(a).toBeGreaterThan(/** @type {[number, number]} */ (ranges[i - 1])[1]);
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
        const [a, b] = /** @type {[number, number]} */ (m && m.ranges[0]);
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
        const exact = /** @type {{ score: number }} */ (scoreField(a.s, a.s, a.f));
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
          const ws = {
            active: "w1",
            workspaces: [
              { id: "w1", name: "ws", tabs: rows.map((_, i) => `t${i}`), activeTab: null },
            ],
          };
          const list = pickerItems(ws, (id) => rows[Number(id.slice(1))], {});
          const out = filterItems(list, query);
          for (let i = 1; i < out.length; i++) {
            const p = /** @type {any} */ (out[i - 1]);
            const c = /** @type {any} */ (out[i]);
            expect(p.score).toBeGreaterThanOrEqual(c.score);
            if (p.score === c.score)
              expect(list.indexOf(p.item)).toBeLessThan(list.indexOf(c.item));
          }
          for (const m of out)
            for (const [k, r] of Object.entries(m.highlights)) {
              wellFormed(r, /** @type {any} */ (m.item)[k === "workspace" ? "workspaceName" : k]);
            }
        },
      ),
    );
  });
});

describe("workspace picker (m3-workspaces 5)", () => {
  const model = {
    active: "w2",
    workspaces: [
      { id: "w1", name: "work", tabs: ["t1", "t2"], activeTab: "t2" },
      { id: "w2", name: "personal", tabs: ["t3"], activeTab: "t3" },
      { id: "w3", name: "admin", tabs: [], activeTab: null },
    ],
  };
  const ws = workspaceItems(model, (id) => id === "t1");
  /** @param {PickerState} s */
  const selectedWs = (s) => /** @type {any} */ (pickerSelection(s)?.item)?.workspaceId;

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
    expect(m.map((x) => /** @type {any} */ (x.item).workspaceId)).toEqual(["w3"]);
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
    const reordered = workspaceItems({ ...model, workspaces: [c, a, b].map((w) => ({ ...w })) });
    expect(selectedWs(setPickerItems(s, reordered))).toBe("w3");
  });
});

describe("tab search (docs/specs/tab-search.md)", () => {
  const model = {
    active: "w2",
    workspaces: [
      { id: "w1", name: "work", tabs: ["t1", "t2"], activeTab: "t2" },
      { id: "wa", name: "agent", tabs: ["a1"], activeTab: "a1" },
      { id: "w2", name: "personal", tabs: ["t3", "t4"], activeTab: "t3" },
    ],
  };
  /** @type {Record<string, { title: string, url: string, playing?: boolean,
   *   muted?: boolean, pinned?: boolean }>} */
  const tabInfo = {
    t1: { title: "Jira 412", url: "https://jira.example.com/412", playing: true },
    t2: { title: "Docs", url: "https://docs.example.com/" },
    a1: { title: "Docs", url: "https://docs.example.com/agent" },
    t3: { title: "Radio", url: "https://radio.fi/", muted: true },
    t4: { title: "Pinned mail", url: "https://mail.fi/", pinned: true },
  };
  const tabs = pickerItems(model, (id) => tabInfo[id], {}, { agentId: "wa" });
  const closed = /** @type {PickerItem} */ (
    /** @type {unknown} */ ({
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
    })
  );
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
    expect(filterItems(list, "playing").map((m) => m.item.tabId)).toEqual(["t1"]);
    expect(filterItems(list, "muted").map((m) => m.item.tabId)).toEqual(["t3"]);
    expect(filterItems(list, "closed").map((m) => m.item.tabId)).toEqual(["closed:7"]);
    expect(filterItems(list, "old").map((m) => m.item.tabId)).toEqual(["closed:7"]);
    expect(filterItems(list, "docs.example.com/old")[0]?.highlights.url).toEqual([[8, 28]]);
    const agentFirst = [/** @type {PickerItem} */ (tabs[4]), /** @type {PickerItem} */ (tabs[3])];
    const docs = filterItems(agentFirst, "docs").map((m) => m.item.tabId);
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
    const ids = (/** @type {PickerState} */ x) => selectedTab(x);
    expect(ids(press(s, ["tab"]).state)).toBe("t1");
    expect(ids(press(s, ["tab", "tab"]).state)).toBe("a1");
    expect(ids(press(s, ["tab", "tab", "tab"]).state)).toBe("closed:7");
    expect(ids(press(s, ["tab", "tab", "tab", "tab"]).state)).toBe("closed:7");
    expect(ids(press(s, ["tab", "tab", "shift+tab"]).state)).toBe("t1");
    expect(ids(press(s, ["j", "shift+tab"]).state)).toBe("t3");
    // With a query, the next section's best match; search mode stays.
    const q = press(s, ["/", "d", "o", "c", "s"]).state;
    expect(q.matches.map((m) => m.item.tabId)).toEqual(["t2", "a1", "closed:7"]);
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
    expect(s.matches.map((m) => m.item.tabId)).toEqual(["t3"]);
    expect(openPicker(list, { typeFirst: true }).query).toBe("");
    expect(openPicker(list, {}).mode).toBe("browse");
  });

  test("500 open and 25 closed items: each key well under 8 ms; units are built once", () => {
    const words = ["jira", "docs", "mail", "calendar", "bank", "news", "radio", "wiki", "git"];
    const big = Array.from({ length: 525 }, (_, n) => ({
      .../** @type {PickerItem} */ (tabs[0]),
      tabId: `b${n}`,
      title: `${words[n % words.length]} ${n} – ${words[(n * 7) % words.length]} board`,
      display: `${words[n % words.length]} ${n} – ${words[(n * 7) % words.length]} board`,
      url: `https://${words[(n * 3) % words.length]}.example.com/item/${n}`,
      workspaceName: `ws${n % 5}`,
      ...(n >= 500 ? { closed: /** @type {const} */ (true), markers: "closed" } : {}),
    }));
    const start = press(openPicker(big, {}), ["/"]).state;
    const keys = [..."abc", "space", ..."def", "ctrl+w", ..."jira", "ctrl+u", ..."docs"];
    keys.push("space", ..."wiki", "backspace", "backspace");
    /** One pass over `keys`: each key's time in ms. */
    const pass = () => {
      let s = start;
      return keys.map((key) => {
        const t0 = performance.now();
        s = pickerKey(s, key).state;
        return performance.now() - t0;
      });
    };
    // Warm-up passes let the JIT optimise the matcher, as it is after the first few keys in a
    // browser; each key's time is then its fastest of five passes, so a GC pause or a busy
    // neighbour in one pass is not counted as its cost.
    for (let i = 0; i < 3; i++) pass();
    const before = unitsBuilt();
    const runs = Array.from({ length: 5 }, pass);
    const times = keys.map((_, k) => Math.min(...runs.map((r) => /** @type {number} */ (r[k]))));
    expect(times.length).toBeGreaterThanOrEqual(20);
    expect(Math.max(...times)).toBeLessThan(8);
    // Every text was segmented in the warm-up: the measured passes build no units at all.
    expect(unitsBuilt() - before).toBe(0);
  });
});

describe("downloads picker (docs/specs/downloads.md)", () => {
  /**
   * @param {number} id
   * @param {Partial<import("../src/downloads.mjs").DownloadRecord>} [over]
   * @returns {import("../src/downloads.mjs").DownloadRecord}
   */
  const record = (id, over = {}) => ({
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
    expect(pickerKey(s, "x").effect).toBeNull();
    expect(pickerKey(s, "q").effect).toEqual({ type: "close" });
    s = pickerKey(s, "/").state;
    for (const key of ["o", "s", "y", "u"]) {
      const r = pickerKey(s, key);
      expect(r.effect, key).toBeNull();
      s = r.state;
    }
    expect(s.query).toBe("osyu");
  });

  test("the filter matches name, host, state and workspace", () => {
    const ids = (/** @type {string} */ q) =>
      filterItems(rows(), q).map((m) => /** @type {any} */ (m.item).downloadId);
    expect(ids("file1")).toEqual(["1"]);
    expect(ids("files2.example")).toEqual(["2"]);
    expect(ids("50%")).toEqual(["3"]);
    expect(ids("work")).toEqual(["2"]);
    expect(ids("token")).toEqual([]);
    const third = /** @type {any} */ (rows()[2]);
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
  const titles = /** @type {Record<string, string>} */ ({
    a: "Editor",
    b: "PDF",
    c: "Search",
    d: "Docs",
    e: "Mail",
    f: "Calendar",
  });
  const items = splitPickerItems(model, (id) => titles[id] ?? "");
  /** @param {PickerState} s */
  const selectedSplit = (s) => /** @type {any} */ (pickerSelection(s)?.item)?.splitId;

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
    expect(s.matches.map((m) => /** @type {any} */ (m.item).splitId)).toEqual(["3"]);
    // In search mode a digit is typed, not a split picked.
    expect(pickerKey(s, "2").effect).toBeNull();
    expect(pickerKey(s, "enter").effect).toEqual({ type: "select", id: "3" });
  });
});
