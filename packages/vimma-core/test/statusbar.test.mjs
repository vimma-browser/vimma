import { describe, test, expect } from "vitest";
import fc from "fast-check";
import {
  WORKSPACE_COLOR_TOKENS,
  displayUrl,
  fitStatus,
  renderStatusBar,
  securityFromState,
  sharingCues,
  truncateUrl,
  statusAnnouncement,
  statusSegments,
  statusWidth,
  textWidth,
  truncate,
} from "../src/statusbar.mjs";
import { THEME_TOKENS } from "../src/theme.mjs";
import { hintKey, hintStatus, startHints } from "../src/hints.mjs";
import { parseKey } from "../src/keys.mjs";

/** @import { Segment } from "../src/statusbar.mjs" */

const base = {
  mode: /** @type {const} */ ("normal"),
  workspace: { name: "work", index: 1, color: "blue" },
  tab: { index: 2, count: 5, title: "GitHub", url: "https://github.com/" },
};

/** @param {Segment[]} segs */
const texts = (segs) => Object.fromEntries(segs.map((s) => [s.id, s.text]));

describe("status bar segments", () => {
  test("mode, workspace, tab position, title and host", () => {
    const segs = statusSegments(base);
    expect(segs.map((s) => [s.id, s.text, s.side])).toEqual([
      ["mode", "NORMAL", "left"],
      ["workspace", "● 1:work", "left"],
      ["tab", "tab 2/5", "left"],
      ["title", "GitHub", "left"],
      ["url", "github.com", "right"],
    ]);
    expect(segs[0]).toMatchObject({ fg: "--vimma-mode-normal-fg", bg: "--vimma-mode-normal" });
    expect(segs[1]?.fg).toBe("--vimma-text-blue");
  });

  test("every token named is a theme token", () => {
    const names = new Set(THEME_TOKENS.map((t) => t.name));
    const segs = statusSegments({
      ...base,
      pending: ["prefix"],
      pane: { index: 1, count: 2 },
      loading: true,
      configErrors: [{ line: 3, path: "keys.x", message: "bad" }],
    });
    for (const s of segs) {
      expect(names.has(s.fg), s.fg).toBe(true);
      if (s.bg) expect(names.has(s.bg), s.bg).toBe(true);
    }
    for (const t of Object.values(WORKSPACE_COLOR_TOKENS)) expect(names.has(t), t).toBe(true);
    for (const mode of ["insert", "visual", "command", "hint", "element", "help", "panel"]) {
      const m = statusSegments({ mode: /** @type {any} */ (mode) })[0];
      expect(names.has(/** @type {string} */ (m?.bg))).toBe(true);
    }
  });

  // docs/specs/element-focus.md decision 5: the focused block's kind and length by the badge.
  test("element focus: the ELEMENT badge, then the block's kind and length", () => {
    const segs = statusSegments({
      ...base,
      mode: "element",
      element: { kind: "paragraph", length: 412, seq: 1 },
    });
    expect(segs[0]).toMatchObject({
      id: "mode",
      text: "ELEMENT",
      fg: "--vimma-mode-element-fg",
      bg: "--vimma-mode-element",
    });
    expect(segs[1]).toMatchObject({ id: "element", text: "paragraph · 412 chars", bg: null });
    expect(THEME_TOKENS.some((t) => t.name === segs[1]?.fg)).toBe(true);
    const one = statusSegments({ mode: "element", element: { kind: "code", length: 1, seq: 2 } });
    expect(one[1]?.text).toBe("code · 1 char");
    expect(statusSegments({ ...base, mode: "normal" }).some((s) => s.id === "element")).toBe(false);
  });

  // docs/specs/follow-link-switch.md decision 8: gF's outcomes, shown with a label to type.
  test("gF's hint mode shows the background and go-there keys", () => {
    const segs = statusSegments({
      ...base,
      mode: "hint",
      hint: { action: "hint.follow_new_tab", label: "sd" },
    });
    expect(segs[0]).toMatchObject({ id: "mode", text: "HINT" });
    expect(segs[1]).toMatchObject({
      id: "hint",
      text: "sd background · sD go there",
      fg: "--vimma-fg-bright",
      bg: null,
      priority: 1,
    });
    expect(THEME_TOKENS.some((t) => t.name === segs[1]?.fg)).toBe(true);
    // A label whose last character has no upper case shows only the background half.
    const semi = statusSegments({
      mode: "hint",
      hint: { action: "hint.follow_new_tab", label: "a;" },
    });
    expect(semi[1]).toMatchObject({ id: "hint", text: "a; background" });
  });

  test("the switching action's hint mode shows only go there", () => {
    const segs = statusSegments({
      mode: "hint",
      hint: { action: "hint.follow_new_tab_fg", label: "sd" },
    });
    expect(segs[1]).toMatchObject({ id: "hint", text: "sd go there" });
  });

  test("f's and F's hint modes, and hint mode before its labels, have no hint segment", () => {
    for (const action of /** @type {const} */ (["hint.follow", "hint.element"])) {
      const segs = statusSegments({ mode: "hint", hint: { action, label: "sd" } });
      expect(segs.some((s) => s.id === "hint")).toBe(false);
    }
    const before = statusSegments({
      mode: "hint",
      hint: { action: "hint.follow_new_tab", label: null },
    });
    expect(before.some((s) => s.id === "hint")).toBe(false);
    const gone = statusSegments({
      mode: "normal",
      hint: { action: "hint.follow_new_tab", label: "a" },
    });
    expect(gone.some((s) => s.id === "hint")).toBe(false);
  });

  test("the hint segment follows the typed prefix", () => {
    const targets = Array.from({ length: 12 }, (_, i) => ({
      rect: { x: i * 50, y: 0, width: 40, height: 10 },
    }));
    let hs = startHints(targets, { action: "hint.follow_new_tab" });
    const text = () =>
      statusSegments({ mode: "hint", hint: hintStatus(hs) }).find((s) => s.id === "hint")?.text;
    expect(text()).toBe("a background · A go there");
    hs = hintKey(hs, parseKey("l")).state;
    expect(text()).toBe("la background · lA go there");
  });

  test("the hint segment is cut at its end", () => {
    const input = {
      mode: /** @type {const} */ ("hint"),
      hint: { action: /** @type {const} */ ("hint.follow_new_tab"), label: "sd" },
    };
    const fitted = fitStatus(statusSegments(input), 20);
    const hint = fitted.find((s) => s.id === "hint");
    expect(hint?.text.startsWith("sd backgr")).toBe(true);
    expect(hint?.text).not.toContain("go there");
  });

  test("starting gF's hints announces both outcomes once", () => {
    let last = { mode: /** @type {any} */ ("normal"), notFound: null };
    const said = [];
    /** @param {any} input */
    const speak = (input) => {
      const r = statusAnnouncement(last, input);
      if (r.text !== null) said.push(r.text);
      last = r.last;
    };
    speak({ mode: "hint", hint: { action: "hint.follow_new_tab", label: null } });
    speak({ mode: "hint", hint: { action: "hint.follow_new_tab", label: "a" } });
    speak({ mode: "hint", hint: { action: "hint.follow_new_tab", label: "la" } });
    speak({ mode: "normal" });
    speak({ mode: "hint", hint: { action: "hint.follow_new_tab_fg", label: "a" } });
    speak({ mode: "normal" });
    speak({ mode: "hint", hint: { action: "hint.follow", label: "a" } });
    expect(said).toEqual([
      "hint mode. new tab: lower case opens in the background, upper case goes there",
      "normal mode",
      "hint mode. new tab: goes there",
      "normal mode",
      "hint mode",
    ]);
  });

  test("pending keys: prefix colours for a prefix, plain otherwise", () => {
    const p = statusSegments({ mode: "normal", pending: ["prefix"] })[1];
    expect(p).toMatchObject({
      id: "pending",
      text: "prefix",
      fg: "--vimma-mode-prefix-fg",
      bg: "--vimma-mode-prefix",
    });
    const g = statusSegments({ mode: "normal", pending: ["2", "g"] })[1];
    expect(g).toMatchObject({ text: "2 g", fg: "--vimma-fg-bright", bg: null });
  });

  test("the title shows the rename; a missing title falls back to the URL once", () => {
    expect(texts(statusSegments({ ...base, tab: { ...base.tab, label: "code" } })).title).toBe(
      "code",
    );
    const noTitle = texts(
      statusSegments({ ...base, tab: { index: 1, count: 1, title: "", url: "https://a.org/x" } }),
    );
    expect(noTitle.title).toBe("https://a.org/x");
    expect(noTitle.url).toBeUndefined();
    expect(texts(statusSegments({ mode: "normal", tab: { index: 1, count: 1 } })).title).toBe(
      "New Tab",
    );
  });

  test("loading, progress and panes", () => {
    expect(texts(statusSegments({ ...base, loading: true, progress: 0.42 })).loading).toBe("42%");
    expect(texts(statusSegments({ ...base, loading: true })).loading).toBe("loading");
    expect(texts(statusSegments({ ...base, progress: 0.5 })).loading).toBeUndefined();
    expect(texts(statusSegments({ ...base, pane: { index: 1, count: 1 } })).pane).toBeUndefined();
    expect(texts(statusSegments({ ...base, pane: { index: 1, count: 2 } })).pane).toBe("pane 1/2");
  });

  test("a hidden view (side-panel-unsplit decision 27): split N hidden, dim, cut first", () => {
    const segs = statusSegments({ ...base, pane: { index: 2, count: 3, hidden: true } });
    expect(texts(segs).pane).toBe("split 3 hidden");
    const pane = segs.find((s) => s.id === "pane");
    expect(pane?.fg).toBe("--vimma-fg-dim");
    const title = segs.find((s) => s.id === "title");
    expect(/** @type {any} */ (pane).priority).toBeGreaterThan(/** @type {any} */ (title).priority);
  });

  test("config errors show file:line, and the count when there are more", () => {
    const one = [
      {
        line: 3,
        path: "keys.new_tabb",
        message: 'unknown action "new_tabb"',
        suggestion: "new_tab",
      },
    ];
    expect(texts(statusSegments({ mode: "normal", configErrors: one })).error).toBe(
      'config.toml:3: keys.new_tabb: unknown action "new_tabb" (did you mean "new_tab"?)',
    );
    const two = [...one, { line: 7, path: "theme.font", message: "bad" }];
    const seg = statusSegments({ mode: "normal", configErrors: two, configFile: "~/c.toml" }).find(
      (s) => s.id === "error",
    );
    expect(seg?.text.startsWith("2 errors: ~/c.toml:3: keys.new_tabb:")).toBe(true);
    expect(seg?.fg).toBe("--vimma-text-error");
  });

  test("alerts (workspaces off) show as a persistent error, after config errors", () => {
    const text = "workspaces off: containers are disabled";
    const seg = statusSegments({ mode: "normal", alerts: [text] }).find((s) => s.id === "alert");
    expect(seg).toMatchObject({ text, fg: "--vimma-text-error", side: "right" });
    const both = statusSegments({
      mode: "normal",
      alerts: [text],
      configErrors: [{ line: 1, path: "x", message: "bad" }],
    }).map((s) => s.id);
    expect(both.indexOf("error")).toBeLessThan(both.indexOf("alert"));
    expect(texts(statusSegments({ mode: "normal", alerts: [] })).alert).toBeUndefined();
  });

  test("a workspace without a known colour uses the accent", () => {
    const s = statusSegments({ mode: "normal", workspace: { name: "x", index: 2 } });
    expect(s[1]).toMatchObject({ text: "● 2:x", fg: "--vimma-text-accent" });
  });

  test("the private workspace shows ◆ private in the theme's magenta, with no number", () => {
    const s = statusSegments({
      mode: "normal",
      workspace: { name: "private", index: 0, private: true, color: "blue" },
    });
    expect(s[1]).toMatchObject({ id: "workspace", text: "◆ private", fg: "--vimma-text-magenta" });
  });

  // docs/specs/builtin-agent.md Behaviour 35: the built-in agent's running tasks, unless a
  // question waits, which comes first.
  test("the agent segment shows the built-in agent's running tasks", () => {
    const at = (/** @type {any} */ agent) =>
      statusSegments({ ...base, agent }).find((s) => s.id === "agent");
    const builtin = "◇ built-in 14/60 · 212k tok";
    expect(at({ waiting: 0, minutes: Infinity, ran: true, builtin })).toMatchObject({
      text: builtin,
      fg: "--vimma-text-cyan",
      bg: null,
    });
    expect(at({ waiting: 1, minutes: Infinity, ran: false, builtin })?.text).toBe("◇ agent 1?");
  });

  // docs/specs/vimma-mcp.md decision 24: glyph and word carry it without colour.
  test("the agent segment: ◇ agent, ◇ agent 2?, ◇ agent 14m, ◇ agent · in cyan, on the right", () => {
    const at = (/** @type {any} */ agent) =>
      statusSegments({ ...base, agent }).find((s) => s.id === "agent");
    expect(at(null)).toBeUndefined();
    expect(at({ waiting: 0, minutes: null, ran: false })).toMatchObject({
      text: "◇ agent",
      fg: "--vimma-text-cyan",
      bg: null,
      side: "right",
    });
    expect(at({ waiting: 2, minutes: 14, ran: false })?.text).toBe("◇ agent 2?");
    expect(at({ waiting: 0, minutes: 14, ran: false })?.text).toBe("◇ agent 14m");
    // docs/specs/mcp-session-grants.md S1: a grant for the whole connection has no minutes.
    expect(at({ waiting: 0, minutes: Infinity, ran: false })?.text).toBe("◇ agent granted");
    // A question waiting says so even just after a request ran: the question comes first.
    expect(at({ waiting: 1, minutes: null, ran: true })?.text).toBe("◇ agent 1?");
    expect(at({ waiting: 0, minutes: 14, ran: true })).toMatchObject({
      text: "◇ agent ·",
      fg: "--vimma-mode-normal-fg",
      bg: "--vimma-mode-normal",
    });
  });

  test("the agent segment gives way just after the workspace's", () => {
    const all = statusSegments({ ...base, agent: { waiting: 1, minutes: null, ran: false } });
    const p = (/** @type {string} */ id) => /** @type {Segment} */ (all.find((s) => s.id === id));
    expect(p("agent").priority).toBeGreaterThan(p("workspace").priority);
    expect(p("agent").priority).toBeLessThan(p("tab").priority);
    // Narrow: the URL and title go before it, the workspace stays longer.
    const fitted = fitStatus(all, 30).map((s) => s.id);
    expect(fitted).toContain("agent");
    expect(fitted).toContain("workspace");
    expect(fitted).not.toContain("url");
  });

  test("displayUrl drops http(s) and a lone trailing slash", () => {
    expect(displayUrl("https://github.com/")).toBe("github.com");
    expect(displayUrl("http://a.org/b/")).toBe("a.org/b/");
    expect(displayUrl("about:preferences")).toBe("about:preferences");
    expect(displayUrl("")).toBe("");
  });
});

describe("truncation", () => {
  test("truncate end and middle with one ellipsis", () => {
    expect(truncate("abcdef", 4, "end")).toBe("abc…");
    expect(truncate("abcdef", 4, "middle")).toBe("ab…f");
    expect(truncate("abcdef", 6, "end")).toBe("abcdef");
    expect(truncate("abcdef", 1, "middle")).toBe("a");
    expect(truncate("家族", 1, "end")).toBe("…");
    expect(truncate("abcdef", 0, "end")).toBe("");
    expect(truncate("😀😀😀", 3, "end")).toBe("😀…");
    expect(truncate("😀😀😀", 2, "end")).toBe("…");
  });

  test("width is terminal columns over grapheme clusters", () => {
    expect(textWidth("家族の写真")).toBe(10);
    expect(textWidth("😀a")).toBe(3);
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
    expect(textWidth(family)).toBe(2);
    expect(textWidth("\u{1F1EB}\u{1F1EE}")).toBe(2);
    expect(textWidth("e\u0301a\u0308")).toBe(2);
    expect(textWidth("\u2764\uFE0F")).toBe(2);
    expect(textWidth("●")).toBe(1);
    expect(textWidth("ｆｕｌｌ")).toBe(8);
    expect(textWidth("a\u200Bb")).toBe(2);
    expect(textWidth("")).toBe(0);
  });

  test("truncation never splits a grapheme cluster", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    expect(truncate(family.repeat(3), 3, "end")).toBe(`${family}…`);
    expect(truncate("e\u0301".repeat(4), 3, "middle")).toBe("e\u0301…e\u0301");
    expect(truncate("家族の写真", 5, "end")).toBe("家族…");
    expect(truncate("家族の写真", 6, "middle")).toBe("家…真");
    expect(truncate("\u{1F1EB}\u{1F1EE}\u{1F1F8}\u{1F1EA}", 3, "end")).toBe("\u{1F1EB}\u{1F1EE}…");
  });

  test("fits: identity", () => {
    const segs = statusSegments(base);
    expect(fitStatus(segs, 200)).toBe(segs);
    expect(statusWidth(segs)).toBe(6 + 8 + 7 + 6 + 10 + 4);
  });

  test("least important gives way first: the URL shrinks, then goes, then the title shrinks", () => {
    const input = {
      ...base,
      tab: { ...base.tab, title: "A fairly long page title", url: "https://example.com/a/b/c/d" },
    };
    const full = statusSegments(input);
    const w = statusWidth(full);
    const a = renderStatusBar(input, w - 4);
    expect(texts(a).url).toBe("example…a/b/c/d");
    expect(texts(a).title).toBe("A fairly long page title");
    const b = renderStatusBar(input, w - 20);
    expect(texts(b).url).toBeUndefined();
    expect(texts(b).title).toBe("A fairly long page title");
    const c = renderStatusBar(input, statusWidth(full.filter((s) => s.id !== "url")) - 5);
    expect(texts(c).title).toBe("A fairly long page…");
    expect(renderStatusBar(input, 3).map((s) => s.text)).toEqual(["NO…"]);
    expect(renderStatusBar(input, 1).map((s) => s.text)).toEqual(["N"]);
    expect(renderStatusBar(input, 0)).toEqual([]);
  });

  test("properties: fits, keeps mode and order, gives way least important first", () => {
    const seg = fc.record({
      text: fc.string({
        unit: fc.constantFrom("a", "b", " ", "家", "e\u0301", "😀"),
        minLength: 1,
        maxLength: 30,
      }),
      priority: fc.integer({ min: 1, max: 9 }),
      min: fc.integer({ min: 1, max: 12 }),
      cut: fc.constantFrom("end", "middle", "none"),
      side: fc.constantFrom("left", "right"),
    });
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 8 }),
        fc.array(seg, { maxLength: 8 }),
        fc.integer({ min: 1, max: 120 }),
        (modeText, rest, width) => {
          /** @type {Segment[]} */
          const segs = [
            {
              id: "mode",
              text: modeText,
              fg: "--vimma-fg",
              bg: null,
              side: "left",
              priority: 0,
              min: 1,
              cut: "end",
            },
            ...rest.map((r, i) => ({ id: `s${i}`, fg: "--vimma-fg", bg: null, ...r })),
          ].map((s) => /** @type {Segment} */ (s));
          const out = fitStatus(segs, width);
          expect(statusWidth(out)).toBeLessThanOrEqual(width);
          if (statusWidth(segs) <= width) expect(out).toBe(segs);
          expect(out[0]?.id).toBe("mode");
          const idx = out.map((o) => segs.findIndex((s) => s.id === o.id));
          expect(idx).toEqual(idx.slice().sort((x, y) => x - y));
          const kept = new Map(out.map((o) => [o.id, o]));
          for (const s of segs.slice(1)) {
            const o = kept.get(s.id);
            if (o && o.text !== s.text) {
              expect(s.cut).not.toBe("none");
              // a wide character that does not fit may leave one column unused
              expect(textWidth(o.text)).toBeGreaterThanOrEqual(
                Math.min(s.min, textWidth(s.text)) - 1,
              );
              // a segment is shortened only as far as needed: no space is left unused
              expect(statusWidth(out)).toBeGreaterThanOrEqual(width - 1);
            }
            if (!o || o.text !== s.text) {
              // every less important segment (ties: later ones) is gone
              for (const t of segs.slice(1)) {
                const lessImportant =
                  t.priority > s.priority ||
                  (t.priority === s.priority && segs.indexOf(t) > segs.indexOf(s));
                if (lessImportant) expect(kept.has(t.id)).toBe(false);
              }
            }
          }
        },
      ),
    );
  });
});

// docs/specs/toolbar-toggle.md, decision 12: while the toolbar is hidden the bar carries the
// cues the hidden toolbar did.
describe("status bar with the toolbar hidden", () => {
  const hidden = { ...base, toolbarHidden: true };
  const http = { ...hidden, tab: { ...base.tab, title: "Plain", url: "http://example.org/a" } };

  test("not secure for an insecure page, in the error colour, as important as config errors", () => {
    const segs = statusSegments({ ...http, security: "insecure" });
    const sec = segs.find((s) => s.id === "security");
    expect(sec).toMatchObject({
      text: "not secure",
      fg: "--vimma-text-error",
      side: "right",
      priority: 2,
    });
  });

  test.each([["secure"], ["neutral"], [undefined]])("nothing for a %s page", (security) => {
    const segs = statusSegments({ ...hidden, ...(security ? { security } : {}) });
    expect(segs.some((s) => s.id === "security")).toBe(false);
  });

  test("private in a private window, unless the workspace already says private", () => {
    const segs = statusSegments({ ...hidden, workspace: null, privateWindow: true });
    expect(texts(segs).private).toBe("private");
    const ws = statusSegments({
      ...hidden,
      workspace: { name: "private", index: 0, private: true },
      privateWindow: true,
    });
    expect(ws.filter((s) => s.text.includes("private"))).toHaveLength(1);
    expect(
      statusSegments({ ...hidden, privateWindow: false }).some((s) => s.id === "private"),
    ).toBe(false);
  });

  test("the URL outlasts the title in a narrow bar", () => {
    const input = {
      ...hidden,
      tab: { index: 1, count: 1, title: "A long page title here", url: "https://example.org/x" },
    };
    const full = statusSegments(input);
    const url = full.find((s) => s.id === "url");
    const title = full.find((s) => s.id === "title");
    expect(url && title && url.priority < title.priority).toBe(true);
    const narrow = renderStatusBar(input, statusWidth(full) - textWidth("A long page title here"));
    expect(texts(narrow).url).toBe("example.org/x");
    expect(texts(narrow).title).toBeUndefined();
  });

  test("http:// stays for an http: page; https:// is still dropped", () => {
    expect(texts(statusSegments(http)).url).toBe("http://example.org/a");
    expect(texts(statusSegments(hidden)).url).toBe("github.com");
  });

  test("with the toolbar shown the segments are exactly today's, whatever the new inputs say", () => {
    const security = fc.constantFrom("secure", "insecure", "neutral", undefined);
    const url = fc.constantFrom("http://a.org/", "https://b.org/x", "about:vimma", null);
    fc.assert(
      fc.property(
        security,
        fc.boolean(),
        url,
        fc.boolean(),
        fc.constantFrom(false, undefined),
        (sec, priv, u, wsPrivate, shown) => {
          const today = {
            ...base,
            workspace: wsPrivate ? { name: "private", index: 0, private: true } : base.workspace,
            tab: { ...base.tab, url: u },
          };
          const extra = {
            ...today,
            ...(shown === undefined ? {} : { toolbarHidden: shown }),
            ...(sec ? { security: sec } : {}),
            privateWindow: priv,
          };
          expect(statusSegments(extra)).toEqual(statusSegments(today));
        },
      ),
      { seed: 20261014, numRuns: 300 },
    );
  });
});

// docs/security.md C3: with the toolbar hidden the status bar is the only origin
// indicator, so the URL never loses its registrable domain to truncation.
describe("the URL keeps its registrable domain while the toolbar is hidden", () => {
  const SPOOF =
    "https://accounts.google.com.secure-login-verification-session-0123456789.evil.example/signin/v2/identifier?continue=https%3A%2F%2Fmail.google.com%2Fmail%2F&service=mail&flowName=GlifWebSignIn";
  const SPOOF_HOST =
    "accounts.google.com.secure-login-verification-session-0123456789.evil.example";
  const spoofTab = {
    index: 1,
    count: 1,
    title: "Sign in",
    url: SPOOF.replace("https://", ""),
    origin: { host: SPOOF_HOST, base: "evil.example" },
  };
  const hiddenInput = { mode: /** @type {const} */ ("normal"), toolbarHidden: true, tab: spoofTab };

  test.each([[80], [120], [160]])("the reviewer's spoof URL at %i columns", (width) => {
    const url = texts(renderStatusBar(hiddenInput, width)).url;
    expect(url).toBeDefined();
    // The base domain is whole and ends the host: what follows is the path or nothing.
    expect(url).toMatch(/evil\.example(…|\/|$)/);
    // Anything that reads like another site comes after the real host, in the path.
    const google = url.indexOf("mail.google.com");
    if (google >= 0) expect(google).toBeGreaterThan(url.indexOf("evil.example"));
  });

  test("the path goes first, then the leftmost labels, never the base domain", () => {
    const o = { host: "a.b.example.com", base: "example.com" };
    const t = "a.b.example.com/some/long/path";
    expect(truncateUrl(t, 100, o)).toBe(t);
    expect(truncateUrl(t, 20, o)).toBe("a.b.example.com/som…");
    expect(truncateUrl(t, 16, o)).toBe("a.b.example.com…");
    expect(truncateUrl(t, 15, o)).toBe("…b.example.com…");
    expect(truncateUrl(t, 13, o)).toBe("…example.com…");
    // Narrower than the base domain: cut at the end as the last resort, never dropped.
    expect(truncateUrl(t, 12, o)).toBe("…example.co…");
    expect(truncateUrl(t, 2, o)).toBe("……");
  });

  test("a scheme is kept while it fits, then goes with the leftmost labels", () => {
    const o = { host: "www.example.org", base: "example.org" };
    const t = "http://www.example.org/path/to/page";
    expect(truncateUrl(t, 26, o)).toBe("http://www.example.org/pa…");
    expect(truncateUrl(t, 23, o)).toBe("http://www.example.org…");
    expect(truncateUrl(t, 20, o)).toBe("…www.example.org…");
    expect(truncateUrl(t, 13, o)).toBe("…example.org…");
  });

  test("IDN, IP, IPv6 and long public suffixes", () => {
    const idn = { host: "pääsy.kirjaudu.esimerkki.fi", base: "esimerkki.fi" };
    expect(truncateUrl("pääsy.kirjaudu.esimerkki.fi/a/b/c", 18, idn)).toBe("…esimerkki.fi…");
    const ip = { host: "192.168.100.200", base: "192.168.100.200" };
    expect(truncateUrl("http://192.168.100.200:8080/admin", 17, ip)).toBe("…192.168.100.200…");
    expect(truncateUrl("http://192.168.100.200:8080/admin", 16, ip)).toBe("…192.168.100.20…");
    const v6 = { host: "2001:db8::1", base: "2001:db8::1" };
    expect(truncateUrl("http://[2001:db8::1]/index.html", 22, v6)).toBe("http://[2001:db8::1]/…");
    expect(truncateUrl("http://[2001:db8::1]/index.html", 15, v6)).toBe("…[2001:db8::1]…");
    const jp = { host: "login.city.kawasaki.jp", base: "city.kawasaki.jp" };
    expect(truncateUrl("login.city.kawasaki.jp/x/y", 18, jp)).toBe("…city.kawasaki.jp…");
  });

  // C3: nested and simple URLs (blob:, view-source:) keep the origin they carry, and
  // a URL with no host is cut at its end, never in the middle, while the toolbar is hidden.
  const BLOB_HOST = "accounts.google.com.secure-login-verification-session-0123456789.evil.example";
  test.each([[50], [80], [120]])("blob:, view-source: and no host at %i columns", (width) => {
    const at = (url, origin) =>
      texts(
        renderStatusBar(
          {
            mode: "normal",
            toolbarHidden: true,
            tab: { index: 1, count: 1, title: "Sign in", url, origin },
          },
          width,
        ),
      ).url;
    const origin = { host: BLOB_HOST, base: "evil.example" };
    const blob = at(
      `blob:https://${BLOB_HOST}/accounts.google.com/signin/0f8b2a3c-5d6e-4f70-8a9b-0c1d2e3f4a5b`,
      origin,
    );
    expect(blob).toMatch(/evil\.example(…|\/|$)/);
    const source = at(`view-source:https://${BLOB_HOST}/accounts.google.com/signin`, origin);
    expect(source).toMatch(/evil\.example(…|\/|$)/);
    const noHost = at(`data:text/html,${"accounts.google.com ".repeat(10)}`, null);
    expect(noHost?.startsWith("data:text/html,")).toBe(true);
    expect(noHost).not.toMatch(/…./);
  });

  test("without an origin (about:, file:) the end is cut", () => {
    expect(truncateUrl("about:preferences#privacy", 12, null)).toBe("about:prefe…");
  });

  test("property: at any width the URL is whole, keeps its base domain, or is gone with the title", () => {
    const label = fc.stringMatching(/^[a-z0-9-]{1,12}$/);
    fc.assert(
      fc.property(
        fc.array(label, { minLength: 0, maxLength: 6 }),
        fc.array(label, { minLength: 1, maxLength: 2 }),
        fc.string({ maxLength: 60 }),
        fc.string({ maxLength: 40 }),
        fc.integer({ min: 1, max: 200 }),
        (subs, baseLabels, path, title, width) => {
          const base = baseLabels.join(".") + ".example";
          const host = [...subs, base].join(".");
          const url = `${host}/${path}`;
          const input = {
            mode: /** @type {const} */ ("normal"),
            toolbarHidden: true,
            tab: { index: 1, count: 1, title, url, origin: { host, base } },
          };
          const out = texts(renderStatusBar(input, width));
          if (out.url !== undefined && !out.url.includes(base)) {
            // The last resort: a bar narrower than `…<base>…` next to the mode cuts its end.
            expect(width).toBeLessThan(textWidth(base) + 10);
            expect(out.url.endsWith("…")).toBe(true);
          } else if (out.url !== undefined) {
            expect(out.url).toContain(base);
            const at = out.url.lastIndexOf(base);
            expect(["", "…", "/"]).toContain(out.url.slice(at + base.length, at + base.length + 1));
          } else {
            // Only a bar too narrow for anything but the mode drops the address.
            expect(width).toBeLessThan(12);
            expect(out.title).toBeUndefined();
          }
        },
      ),
      { seed: 20261014, numRuns: 1000 },
    );
  });

  test("a title equal to the URL does not take the URL's place", () => {
    const url = "accounts.google.com.evil.example/signin";
    const input = {
      ...hiddenInput,
      tab: {
        ...spoofTab,
        title: url,
        url,
        origin: { host: "accounts.google.com.evil.example", base: "evil.example" },
      },
    };
    const segs = statusSegments(input);
    expect(texts(segs).url).toBe(url);
    expect(texts(renderStatusBar(input, 50)).url).toMatch(/evil\.example/);
    expect(texts(renderStatusBar(input, 30)).url).toMatch(/evil\.example/);
  });
});

// Finding 5: the security state comes from the browser's security flags, as Firefox's own
// browser-siteIdentity.js reads them, not from a hidden element's classes.
describe("securityFromState", () => {
  const base = {
    scheme: "https",
    secure: false,
    broken: false,
    certOverride: false,
    errorPage: false,
    secureContext: false,
  };
  test.each([
    ["a verified https page", { secure: true, secureContext: true }, "secure"],
    ["mixed content (broken)", { secure: false, broken: true }, "insecure"],
    [
      "a certificate exception",
      { secure: true, certOverride: true, secureContext: true },
      "insecure",
    ],
    ["a certificate error page", { errorPage: true }, "insecure"],
    ["plain http", { scheme: "http" }, "insecure"],
    ["http on localhost (a secure context)", { scheme: "http", secureContext: true }, "neutral"],
    ["about:", { scheme: "about", secureContext: true }, "neutral"],
    ["a cert error under about:", { scheme: "about", errorPage: true }, "insecure"],
    ["file:", { scheme: "file" }, "neutral"],
    ["an add-on page", { scheme: "moz-extension", secureContext: true }, "neutral"],
    ["a blank page", { scheme: "about", secureContext: false }, "neutral"],
  ])("%s", (_name, over, level) => {
    expect(securityFromState({ ...base, ...over })).toBe(level);
  });
});

// Finding 3: what the page uses (camera, microphone, screen, location, XR, serial), which the
// hidden address bar and tab strip showed.
describe("sharing: devices in use while the toolbar is hidden", () => {
  test("sharingCues reads Firefox's per-tab sharing state", () => {
    expect(sharingCues(null)).toEqual([]);
    expect(sharingCues({})).toEqual([]);
    // Firefox's shapes (webrtcUI getCombinedStateForBrowser): camera and microphone are
    // nsIMediaManagerService states, 1 capturing, 2 disabled (paused), 0 none; screen a string.
    expect(sharingCues({ webRTC: { camera: 1, microphone: 1, sharing: "camera" } })).toEqual([
      "camera",
      "mic",
    ]);
    expect(sharingCues({ webRTC: { camera: 2, microphone: 1 } })).toEqual(["camera paused", "mic"]);
    expect(sharingCues({ webRTC: { camera: 0, microphone: 2 } })).toEqual(["mic paused"]);
    expect(sharingCues({ webRTC: { screen: "Screen" } })).toEqual(["screen"]);
    expect(sharingCues({ webRTC: { screen: "WindowPaused" } })).toEqual(["screen paused"]);
    expect(sharingCues({ geo: true, xr: true, serial: true })).toEqual([
      "location",
      "XR",
      "serial",
    ]);
  });

  test("a segment as important as `not secure`, only while hidden", () => {
    const tab = { index: 1, count: 1, title: "Call", url: "meet.example/x" };
    const segs = statusSegments({
      mode: "normal",
      toolbarHidden: true,
      tab,
      sharing: ["camera", "mic"],
    });
    expect(segs.find((s) => s.id === "sharing")).toMatchObject({
      text: "using camera, mic",
      fg: "--vimma-text-error",
      side: "right",
      priority: 2,
    });
    expect(
      statusSegments({ mode: "normal", tab, sharing: ["camera"] }).some((s) => s.id === "sharing"),
    ).toBe(false);
  });
});

// C3: the URL takes room only from less important segments. The mode, then
// `not secure`, `private` and the devices in use come before it; the URL is cut further
// (its end-cut domain as the last resort) rather than pushing any of them off the bar.
describe("the security cues outrank the kept URL", () => {
  const cueTexts = ["not secure", "using camera, mic", "private"];
  const cuesWidth = cueTexts.reduce((n, t) => n + textWidth(t) + 1, 0);

  test("the reviewer's 63-character domain at 50 and 80 columns", () => {
    const base = `${"x".repeat(63)}.example`;
    const host = `login.paypal.com.${base}`;
    for (const width of [50, 80]) {
      const out = texts(
        renderStatusBar(
          {
            mode: "normal",
            toolbarHidden: true,
            security: "insecure",
            sharing: ["camera"],
            tab: {
              index: 1,
              count: 1,
              title: "PayPal",
              url: `${host}/signin`,
              origin: { host, base },
            },
          },
          width,
        ),
      );
      expect(out.security).toBe("not secure");
      expect(out.sharing).toBe("using camera");
      expect(out.mode?.length).toBeGreaterThan(0);
      expect(out.url?.length).toBeGreaterThan(0);
    }
  });

  test("property: from 40 to 160 columns the cues stay, the URL shows, the URL never cuts the mode", () => {
    const label = fc.stringMatching(/^[a-z0-9]{1,63}$/);
    fc.assert(
      fc.property(
        fc.array(label, { maxLength: 3 }),
        label,
        fc.string({ maxLength: 40 }),
        fc.integer({ min: 40, max: 160 }),
        (subs, name, path, width) => {
          const base = `${name}.example`;
          const host = [...subs, base].join(".");
          const out = texts(
            renderStatusBar(
              {
                mode: "normal",
                toolbarHidden: true,
                security: "insecure",
                sharing: ["camera", "mic"],
                privateWindow: true,
                workspace: { name: "work", index: 1 },
                tab: {
                  index: 1,
                  count: 3,
                  title: "Sign in",
                  url: `${host}/${path}`,
                  origin: { host, base },
                },
              },
              width,
            ),
          );
          expect(out.security).toBe("not secure");
          expect(out.sharing).toBe("using camera, mic");
          expect(out.private).toBe("private");
          expect(out.url?.length).toBeGreaterThan(0);
          if (out.url && !out.url.includes(base)) expect(out.url.endsWith("…")).toBe(true);
          // The mode is never dropped, and gives up its full word only once the less important
          // segments are gone; it keeps its one-column short form.
          expect(out.mode?.length).toBeGreaterThan(0);
          if (out.mode !== "NORMAL") {
            expect(out.workspace).toBeUndefined();
            expect(out.tab).toBeUndefined();
          }
          // Room for all of it: nothing is cut.
          if (width >= textWidth("NORMAL") + 1 + cuesWidth + textWidth(`${host}/${path}`)) {
            expect(out.mode).toBe("NORMAL");
          }
        },
      ),
      { seed: 20261015, numRuns: 1000 },
    );
  });
});
