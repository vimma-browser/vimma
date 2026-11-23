import { describe, expect, it } from "vitest";
import { hintLabels } from "../../../packages/vimma-core/src/page/hints.mjs";
import type { Director } from "../record.ts";
import { SHOTS } from "../shots.ts";

interface Tab {
  title: string;
  selected: boolean;
}

/**
 * A stand-in for the recorder's Director: a small model of the window that answers the keys the
 * tabs shot sends (tab search on `b`, Enter reopening the drill page, `gb` labelling the tab line
 * and a label going to that tab). `until` throws unless the state already holds, so every wait
 * in the shot has to name a state the keys before it reached.
 */
function fakeDirector(titles: string[]) {
  const s = {
    mode: "normal",
    workspace: "main",
    tabs: titles.map((title, i): Tab => ({ title, selected: i === titles.length - 1 })),
  };
  const keys: string[] = [];
  const waits: string[] = [];
  const select = (i: number) => s.tabs.forEach((t, j) => (t.selected = i === j));
  let typed = "";
  const press = (k: string) => {
    keys.push(k);
    if (s.mode === "normal" && k === "b") {
      s.mode = "help";
      typed = "";
    } else if (s.mode === "help" && k === "enter") {
      if (typed === "drill") {
        s.tabs.push({ title: "Rollback drill, Q3 · Wiki", selected: false });
        select(s.tabs.length - 1);
      }
      s.mode = "normal";
    } else if (s.mode === "help") {
      typed += k;
    } else if (s.mode === "normal" && k === "g b") {
      s.mode = "hint";
      typed = "";
    } else if (s.mode === "hint") {
      typed += k;
      const at = hintLabels(s.tabs.length).indexOf(typed);
      if (at >= 0) {
        select(at);
        s.mode = "normal";
      }
    }
  };
  const d = {
    labels: {},
    points: {},
    state: async () => structuredClone(s),
    async until(test: (state: unknown) => boolean, what: string) {
      waits.push(what);
      if (!test(structuredClone(s))) throw new Error(`not yet: ${what}`);
      return structuredClone(s);
    },
    hold: async () => {},
    mark: () => {},
    send: async (k: string) => press(k),
    key: async (k: string) => press(k),
    prefix: async (k: string) => (press("ctrl+b"), press(k)),
    type: async (text: string) => {
      for (const c of text) press(c);
    },
  };
  return { d: d as unknown as Director, s, keys, waits };
}

const TEAM = [
  "On-call runbook · Wiki",
  "Release checklist 4.2 · Wiki",
  "INC-1187 Checkout slow after deploy · Tracker",
  "Standup, Tuesday · Notes",
];

describe("SHOTS", () => {
  it("lists the storyboard without live grep", () => {
    expect(SHOTS.map((s) => s.name)).toEqual([
      "keys",
      "tiling",
      "flip",
      "marks",
      "tabs",
      "agent",
      "theme",
      "help",
    ]);
  });
});

describe("the tabs shot", () => {
  const tabs = SHOTS.find((s) => s.name === "tabs");
  if (!tabs) throw new Error("no tabs shot");

  it("reopens the drill page from tab search, then goes to the incident with gb", async () => {
    const { d, s, keys, waits } = fakeDirector(TEAM);
    await tabs.run(d);
    expect(keys.slice(0, 1)).toEqual(["b"]);
    const gb = keys.indexOf("g b");
    expect(gb).toBeGreaterThan(keys.indexOf("enter"));
    expect(waits.some((w) => /label/i.test(w))).toBe(true);
    expect(s.mode).toBe("normal");
    expect(s.tabs.length).toBe(5);
    expect(s.tabs.find((t) => t.selected)?.title).toMatch(/^INC-1187/);
  });

  it("types the label the tab line gives the incident, its third tab", async () => {
    const { d, keys } = fakeDirector(TEAM);
    await tabs.run(d);
    const label = keys.slice(keys.indexOf("g b") + 1).join("");
    expect(label).toBe(hintLabels(5)[2]);
  });
});
