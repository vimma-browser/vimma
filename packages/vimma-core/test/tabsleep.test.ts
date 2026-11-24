// docs/specs/tab-sleep.md: which tabs go to sleep (decision 3).
import { describe, test, expect } from "vitest";
import {
  PRIVATE_SLEEP_TEXT,
  namedSleepText,
  planSleep,
  SLEEP_CHECK_MS,
  sleepReport,
} from "../src/workspaces/tabsleep.mjs";

import type { SleepTab } from "../src/workspaces/tabsleep.mjs";

const MIN = 60_000;
const NOW = 1_000 * MIN;
const AFTER = 120 * MIN;

/** A loaded background web page, unseen for three hours. */
function tab(over: Partial<SleepTab> = {}): SleepTab {
  return {
    id: "t",
    lastSeen: NOW - 180 * MIN,
    onScreen: false,
    pinned: false,
    sound: false,
    pip: false,
    sharing: false,
    private: false,
    agent: false,
    url: "https://example.com/page",
    loading: false,
    asleep: false,
    ...over,
  };
}

const plan = (tabs: SleepTab[], over: Partial<Parameters<typeof planSleep>[0]> = {}) =>
  planSleep({ now: NOW, sleepAfterMs: AFTER, tabs, sites: [], agentConnected: false, ...over });

describe("planSleep", () => {
  test("the check runs every 5 minutes", () => {
    expect(SLEEP_CHECK_MS).toBe(5 * MIN);
  });

  test("a tab unseen longer than sleep_after sleeps; one seen within it stays", () => {
    const r = plan([
      tab({ id: "old" }),
      tab({ id: "new", lastSeen: NOW - 60 * MIN }),
      tab({ id: "edge", lastSeen: NOW - AFTER }),
    ]);
    expect(r.sleep).toEqual(["old"]);
    expect(r.keep).toEqual([
      { id: "new", reason: "recent" },
      { id: "edge", reason: "recent" },
    ]);
  });

  test("sleep_after 0 plans nothing", () => {
    const r = plan([tab({ id: "a" }), tab({ id: "b", lastSeen: 0 })], { sleepAfterMs: 0 });
    expect(r).toEqual({ sleep: [], keep: [] });
  });

  test("last seen is the later of lastAccessed and the last on-screen check", () => {
    // The host passes the later of the two; planSleep compares only that.
    const r = plan([
      tab({ id: "watched", lastSeen: Math.max(NOW - 300 * MIN, NOW - 10 * MIN) }),
      tab({ id: "left", lastSeen: Math.max(NOW - 300 * MIN, NOW - 200 * MIN) }),
    ]);
    expect(r.sleep).toEqual(["left"]);
  });

  test("on screen, pinned, sound, picture-in-picture, sharing, private and loading keep a tab awake", () => {
    const r = plan([
      tab({ id: "screen", onScreen: true }),
      tab({ id: "pin", pinned: true }),
      tab({ id: "sound", sound: true }),
      tab({ id: "pip", pip: true }),
      tab({ id: "share", sharing: true }),
      tab({ id: "priv", private: true }),
      tab({ id: "load", loading: true }),
      tab({ id: "plain" }),
    ]);
    expect(r.sleep).toEqual(["plain"]);
    expect(r.keep).toEqual([
      { id: "screen", reason: "onScreen" },
      { id: "pin", reason: "pinned" },
      { id: "sound", reason: "sound" },
      { id: "pip", reason: "pip" },
      { id: "share", reason: "sharing" },
      { id: "priv", reason: "private" },
      { id: "load", reason: "loading" },
    ]);
  });

  test("agent workspace tabs stay awake only while an agent is connected", () => {
    const tabs = [tab({ id: "agent", agent: true }), tab({ id: "user" })];
    expect(plan(tabs, { agentConnected: true })).toEqual({
      sleep: ["user"],
      keep: [{ id: "agent", reason: "agent" }],
    });
    expect(plan(tabs, { agentConnected: false }).sleep).toEqual(["agent", "user"]);
  });

  test("only http, https and file pages sleep", () => {
    const r = plan([
      tab({ id: "http", url: "http://example.com/" }),
      tab({ id: "https", url: "https://example.com/" }),
      tab({ id: "file", url: "file:///home/me/notes.html" }),
      tab({ id: "about", url: "about:vimma" }),
      tab({ id: "start", url: "about:newtab" }),
      tab({ id: "src", url: "view-source:https://example.com/" }),
      tab({ id: "moz", url: "moz-extension://abc/page.html" }),
      tab({ id: "bad", url: "not a url" }),
    ]);
    expect(r.sleep).toEqual(["http", "https", "file"]);
    expect(r.keep.map((k) => k.reason)).toEqual(["page", "page", "page", "page", "page"]);
  });

  test("a site with sleep = false stays awake, its subdomains too; the most specific table wins", () => {
    const sites = [
      { match: "example.com", sleep: false },
      { match: "news.example.com", sleep: true },
    ];
    const r = plan(
      [
        tab({ id: "root", url: "https://example.com/" }),
        tab({ id: "sub", url: "https://mail.example.com/inbox" }),
        tab({ id: "news", url: "https://news.example.com/" }),
        tab({ id: "deep", url: "https://a.news.example.com/" }),
        tab({ id: "other", url: "https://badexample.com/" }),
        tab({ id: "file", url: "file:///tmp/x.html" }),
      ],
      { sites },
    );
    expect(r.sleep).toEqual(["news", "deep", "other", "file"]);
    expect(r.keep).toEqual([
      { id: "root", reason: "site" },
      { id: "sub", reason: "site" },
    ]);
  });

  test("a tab already asleep is not planned again", () => {
    const r = plan([tab({ id: "z", asleep: true }), tab({ id: "a" })]);
    expect(r).toEqual({ sleep: ["a"], keep: [] });
  });

  test("by hand: the time rule is off", () => {
    const r = plan([tab({ id: "fresh", lastSeen: NOW }), tab({ id: "pin", pinned: true })], {
      mode: "hand",
    });
    expect(r.sleep).toEqual(["fresh"]);
    expect(r.keep).toEqual([{ id: "pin", reason: "pinned" }]);
    // By hand works with the automatic check off too.
    expect(plan([tab({ id: "fresh" })], { mode: "hand", sleepAfterMs: 0 }).sleep).toEqual([
      "fresh",
    ]);
  });

  test("by number: pin and site rule are ignored; on screen, sound, sharing, private and agent are not", () => {
    const sites = [{ match: "example.com", sleep: false }];
    const r = plan(
      [
        tab({ id: "pin", pinned: true, lastSeen: NOW }),
        tab({ id: "site" }),
        tab({ id: "screen", onScreen: true }),
        tab({ id: "sound", sound: true }),
        tab({ id: "share", sharing: true }),
        tab({ id: "priv", private: true }),
        tab({ id: "agent", agent: true }),
      ],
      { sites, mode: "named", agentConnected: true },
    );
    expect(r.sleep).toEqual(["pin", "site"]);
    expect(r.keep.map((k) => k.reason)).toEqual([
      "onScreen",
      "sound",
      "sharing",
      "private",
      "agent",
    ]);
  });

  test("each kept tab reports the first rule that keeps it", () => {
    const r = plan([
      tab({ id: "a", onScreen: true, pinned: true, sound: true, lastSeen: NOW }),
      tab({ id: "b", pinned: true, url: "about:vimma", lastSeen: NOW }),
      tab({ id: "c", url: "about:vimma", loading: true, lastSeen: NOW }),
      tab({ id: "d", loading: true, lastSeen: NOW }),
    ]);
    expect(r.keep).toEqual([
      { id: "a", reason: "onScreen" },
      { id: "b", reason: "pinned" },
      { id: "c", reason: "page" },
      { id: "d", reason: "loading" },
    ]);
  });
});

// Behaviour 9-13: what `:sleep`, its forms and the side panel's `z` say.
describe("sleep messages", () => {
  test(":sleep reports the count and, when some stayed awake, how many and the most common reason", () => {
    expect(sleepReport({ slept: 3, keep: [] })).toBe("3 tabs asleep");
    expect(sleepReport({ slept: 1, keep: [] })).toBe("1 tab asleep");
    expect(sleepReport({ slept: 0, keep: [] })).toBe("0 tabs asleep");
    expect(sleepReport({ slept: 2, keep: ["onScreen", "sound", "onScreen"] })).toBe(
      "2 tabs asleep; 3 stay awake: on screen",
    );
    expect(sleepReport({ slept: 0, keep: ["pinned"] })).toBe(
      "0 tabs asleep; 1 stays awake: pinned",
    );
  });

  test("a tie between reasons names the one Behaviour 2 lists first", () => {
    // The start page and the tab on screen: "on screen" is the one the user expects.
    expect(sleepReport({ slept: 2, keep: ["page", "onScreen"] })).toBe(
      "2 tabs asleep; 2 stay awake: on screen",
    );
    expect(sleepReport({ slept: 1, keep: ["unload", "sound", "loading", "sound", "unload"] })).toBe(
      "1 tab asleep; 5 stay awake: playing sound",
    );
  });

  test("every reason reads as a phrase", () => {
    const reasons = [
      ["onScreen", "on screen"],
      ["pinned", "pinned"],
      ["sound", "playing sound"],
      ["pip", "in Picture-in-Picture"],
      ["sharing", "sharing a camera, microphone or screen"],
      ["private", "private"],
      ["agent", "an agent is connected"],
      ["page", "not a web page"],
      ["site", "its site has sleep = false"],
      ["loading", "loading"],
      ["unload", "it would ask before leaving"],
    ] as const;
    for (const [reason, text] of reasons) {
      expect(sleepReport({ slept: 0, keep: [reason] })).toBe(
        `0 tabs asleep; 1 stays awake: ${text}`,
      );
    }
  });

  test(":sleep N says the tab is asleep, on screen, asleep already, or what keeps it awake", () => {
    expect(namedSleepText([{ number: 3, reason: null }])).toBe("Tab 3 asleep");
    expect(namedSleepText([{ number: 2, reason: "onScreen" }])).toBe("Tab 2 is on screen");
    expect(namedSleepText([{ number: 5, reason: "asleep" }])).toBe("Tab 5 is asleep already");
    expect(namedSleepText([{ number: 4, reason: "sound" }])).toBe(
      "Tab 4 stays awake: it is playing sound",
    );
    expect(namedSleepText([{ number: 4, reason: "agent" }])).toBe(
      "Tab 4 stays awake: an agent is connected",
    );
    expect(namedSleepText([{ number: 4, reason: "unload" }])).toBe(
      "Tab 4 stays awake: it would ask before leaving",
    );
    expect(namedSleepText([{ number: 4, reason: "site" }])).toBe(
      "Tab 4 stays awake: its site has sleep = false",
    );
  });

  test("several named tabs (the side panel's marks) are reported as :sleep reports, tabs asleep already left out", () => {
    expect(
      namedSleepText([
        { number: 1, reason: null },
        { number: 2, reason: "asleep" },
        { number: 3, reason: null },
        { number: 4, reason: "onScreen" },
      ]),
    ).toBe("2 tabs asleep; 1 stays awake: on screen");
    expect(namedSleepText([])).toBe("0 tabs asleep");
  });

  test("a private window's :sleep says private tabs do not sleep", () => {
    expect(PRIVATE_SLEEP_TEXT).toBe("Private tabs do not sleep");
  });
});
