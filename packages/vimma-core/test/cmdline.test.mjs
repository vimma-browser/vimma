import { describe, test, expect } from "vitest";
import {
  COMMANDS,
  PENDING_ACTIONS,
  parseCommandLine,
  completeCommandLine,
  createHistory,
  pushHistory,
  historyPrevious,
  historyNext,
  resetHistoryCursor,
  parseToolbarCommand,
  parseBookmarksToolbarCommand,
} from "../src/cmdline.mjs";
import { ACTIONS, getAction } from "../src/actions.mjs";

const run = (command, id, extra = {}) => ({
  kind: "run",
  command,
  action: { id, ...(extra.arg !== undefined ? { arg: extra.arg } : {}) },
  ...(extra.text !== undefined ? { text: extra.text } : {}),
});

describe("parseCommandLine: plan §2 commands", () => {
  test.each([
    [":tabnew", run("tabnew", "tab.new")],
    ["tabnew https://x.org/?q=1", run("tabnew", "tab.new", { text: "https://x.org/?q=1" })],
    [':tabrename "my  tab"', run("tabrename", "tab.rename", { text: "my  tab" })],
    [":tabrename my   tab ", run("tabrename", "tab.rename", { text: "my   tab" })],
    [":tabrename Juuso's tab", run("tabrename", "tab.rename", { text: "Juuso's tab" })],
    [":open https://x.com/?q=it's", run("open", "page.open", { text: "https://x.com/?q=it's" })],
    [":tabrename 'my tab'", run("tabrename", "tab.rename", { text: "my tab" })],
    [':workspace "my ws"', run("workspace", "workspace.switch", { text: "my ws" })],
    [':tabrename "a" and "b"', run("tabrename", "tab.rename", { text: '"a" and "b"' })],
    [':tabrename "oops', run("tabrename", "tab.rename", { text: '"oops' })],
    [":tabrename '", run("tabrename", "tab.rename", { text: "'" })],
    ["::q", run("q", "pane.close")],
    [" :: :tabnew x", run("tabnew", "tab.new", { text: "x" })],
    [":tabrename", run("tabrename", "tab.rename")],
    [":q", run("q", "pane.close")],
    [":quit", run("q", "pane.close")],
    [":vsplit", run("vsplit", "pane.split_vertical")],
    [":vs", run("vsplit", "pane.split_vertical")],
    [":split", run("split", "pane.split_horizontal")],
    [":sp", run("split", "pane.split_horizontal")],
    [":wsnext", run("wsnext", "workspace.next")],
    [":wsprev", run("wsprev", "workspace.previous")],
    [":workspace", run("workspace", "workspace.picker")],
    [":workspace work", run("workspace", "workspace.switch", { text: "work" })],
    // Sub-specs 4a/4b (m3-workspace-lifecycle, m3-workspace-move).
    [":wsnew shop", run("wsnew", "workspace.new", { text: "shop" })],
    [":wsnew", run("wsnew", "workspace.new")],
    [":wsrename market", run("wsrename", "workspace.rename", { text: "market" })],
    [":wsrename", run("wsrename", "workspace.rename")],
    [":wsdelete", run("wsdelete", "workspace.close")],
    [":wsdelete shop", run("wsdelete", "workspace.close", { text: "shop" })],
    [":wsmove 2", run("wsmove", "workspace.move_tab", { text: "2" })],
    [":wsmove", run("wsmove", "workspace.move_tab")],
    [":move_to_workspace", run("move_to_workspace", "workspace.move_tab")],
    // workspace-routing: list the rules, add one for this site, move the tab where its rule says.
    [":route", run("route", "workspace.route")],
    [":route add work", run("route", "workspace.route", { text: "add work" })],
    [":route move", run("route", "workspace.route", { text: "move" })],
    [":route_rules", run("route_rules", "workspace.route")],
    // docs/specs/private-workspace.md decision 2: toggles; `close` closes it after y/N.
    [":private", run("private", "workspace.private")],
    [":priv", run("private", "workspace.private")],
    [":private close", run("private", "workspace.private", { text: "close" })],
    [":private_workspace", run("private_workspace", "workspace.private")],
    [":ls", run("ls", "goto.picker")],
    // docs/specs/tab-search.md decision 2: tab search, with the text as its query.
    [":tabsearch", run("tabsearch", "goto.picker")],
    [":ts", run("tabsearch", "goto.picker")],
    [":tabsearch jira 412", run("tabsearch", "goto.picker", { text: "jira 412" })],
    // Vim's :b {name} goes to a buffer by name: here, tab search with the name typed.
    [":b", run("tabsearch", "goto.picker")],
    [":b jira", run("tabsearch", "goto.picker", { text: "jira" })],
    // docs/specs/live-grep.md decision 2: with text opens with that query; alone resumes.
    [":grep", run("grep", "grep.resume")],
    [":grep retry budget", run("grep", "grep.open", { text: "retry budget" })],
    [":live_grep", run("live_grep", "grep.open")],
    [":sidebar", run("sidebar", "sidebar.toggle")],
    [":map", run("map", "help.show")],
    [":help", run("help", "help.show")],
    [":h", run("help", "help.show")],
    [":source", run("source", "config.reload")],
    [":source ~/work.toml", run("source", "config.reload", { text: "~/work.toml" })],
    [':so "my config.toml"', run("source", "config.reload", { text: "my config.toml" })],
    [":config", run("config", "config.edit")],
    [":edit_config", run("edit_config", "config.edit")],
    // docs/specs/theme-appearance.md B3: bare :theme switches dark <-> light in the host.
    [":theme", run("theme", "theme.appearance")],
    [":theme light", run("theme", "theme.appearance", { text: "light" })],
    [":theme_appearance", run("theme_appearance", "theme.appearance")],
    // docs/specs/toolbar-toggle.md decision 2: toggles; show / hide set a known state.
    [":toolbar", run("toolbar", "toolbar.toggle")],
    [":toolbar show", run("toolbar", "toolbar.toggle", { text: "show" })],
    [":toolbar hide", run("toolbar", "toolbar.toggle", { text: "hide" })],
    [":toggle_toolbar", run("toggle_toolbar", "toolbar.toggle")],
    [":show_toolbar", run("show_toolbar", "toolbar.show")],
    [":hide_toolbar", run("hide_toolbar", "toolbar.hide")],
    // docs/specs/bookmarks-toolbar-hidden.md decision 5: Firefox's toggle; a word sets a state.
    [":bookmarkstoolbar", run("bookmarkstoolbar", "browser.bookmarks_toolbar")],
    [
      ":bookmarkstoolbar show",
      run("bookmarkstoolbar", "browser.bookmarks_toolbar", { text: "show" }),
    ],
    [
      ":bookmarkstoolbar newtab",
      run("bookmarkstoolbar", "browser.bookmarks_toolbar", { text: "newtab" }),
    ],
    // docs/specs/vimma-mcp.md decision 29 D: full control for a while.
    [":control", run("control", "control.command")],
    [":control on 15", run("control", "control.command", { text: "on 15" })],
    [":control off", run("control", "control.command", { text: "off" })],
    [":agent_prompt", run("agent_prompt", "mcp.answer")],
    [":about", run("about", "tab.new", { text: "about:vimma" })],
    [":vimma", run("about", "tab.new", { text: "about:vimma" })],
    [":bug", run("bug", "tab.new", { text: "about:vimma#bug" })],
    [":open example.com", run("open", "page.open", { text: "example.com" })],
    ["  :  open   example.com  ", run("open", "page.open", { text: "example.com" })],
    [":TABNEW", run("tabnew", "tab.new")],
  ])("%j", (text, expected) => {
    expect(parseCommandLine(text)).toEqual(expected);
  });

  test.each([
    [":open", "missing-argument"],
    [':open ""', "missing-argument"],
    [":open ''", "missing-argument"],
    [":open    ", "missing-argument"],
    [":q now", "unexpected-argument"],
    [":map j k", "unexpected-argument"],
    [":ls x", "unexpected-argument"],
    [":about x", "unexpected-argument"],
    [":config work.toml", "unexpected-argument"],
  ])("%j → %s", (text, code) => {
    const r = parseCommandLine(text);
    expect(r.kind).toBe("error");
    expect(r.error.code).toBe(code);
    expect(r.error.message).toEqual(expect.any(String));
    expect(r.error.suggestions).toEqual(expect.any(Array));
  });

  test(":map with arguments says bindings live in config.toml", () => {
    expect(parseCommandLine(":map j k").error.message).toMatch(/config\.toml/);
  });

  test.each(["", ":", "  :  ", "::"])("%j is empty", (text) => {
    expect(parseCommandLine(text)).toEqual({ kind: "empty" });
  });
});

describe("parseCommandLine: actions, abbreviations, errors", () => {
  test.each([
    [":scroll_down", run("scroll_down", "scroll.down")],
    [":tab.next", run("tab.next", "tab.next")],
    [":select_tab_3", run("select_tab_3", "tab.goto", { arg: 3 })],
    [":prev_workspace", run("prev_workspace", "workspace.previous")],
  ])("%j runs the action", (text, expected) => {
    expect(parseCommandLine(text)).toEqual(expected);
  });

  test("actions take no arguments", () => {
    expect(parseCommandLine(":scroll_down 3").error.code).toBe("unexpected-argument");
  });

  test("an ambiguous dotted id is unknown", () => {
    expect(parseCommandLine(":tab.goto").error.code).toBe("unknown-command");
  });

  test.each([
    [":tabr x", run("tabrename", "tab.rename", { text: "x" })],
    [":wsn", run("wsnext", "workspace.next")],
    [":sideb", run("sidebar", "sidebar.toggle")],
  ])("%j is a unique prefix", (text, expected) => {
    expect(parseCommandLine(text)).toEqual(expected);
  });

  test(":w is ambiguous and lists the candidates", () => {
    const r = parseCommandLine(":w");
    expect(r.error.code).toBe("ambiguous-command");
    expect([...r.error.suggestions].sort()).toEqual([
      "workspace",
      "workspaces",
      "wsdelete",
      "wsmove",
      "wsnew",
      "wsnext",
      "wsprev",
      "wsrename",
    ]);
  });

  test(":tabnwe is unknown and suggests tabnew", () => {
    const r = parseCommandLine(":tabnwe");
    expect(r.error.code).toBe("unknown-command");
    expect(r.error.suggestions).toEqual(["tabnew"]);
    expect(r.error.message).toContain("tabnwe");
  });

  test(":scroll_dwn suggests scroll_down", () => {
    expect(parseCommandLine(":scroll_dwn").error.suggestions).toEqual(["scroll_down"]);
  });

  test("an unknown word with no near match suggests nothing", () => {
    expect(parseCommandLine(":xyzzyplugh").error.suggestions).toEqual([]);
  });

  test("results are frozen", () => {
    const r = parseCommandLine(":tabnew x");
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.action)).toBe(true);
  });
});

describe("command table", () => {
  const ids = new Set(ACTIONS.map((a) => a.id));

  test("every command maps to an action in actions.mjs or in PENDING_ACTIONS", () => {
    for (const c of COMMANDS) {
      for (const id of [c.action, c.textAction].filter(Boolean)) {
        expect(ids.has(id) || PENDING_ACTIONS.includes(id), `${c.name} → ${id}`).toBe(true);
      }
    }
  });

  test(":q's action says the last pane closes the tab (plan §2)", () => {
    expect(getAction("close_pane").description).toBe("Close pane; the last pane closes the tab");
  });

  test("PENDING_ACTIONS are exactly the missing ones, not yet in actions.mjs", () => {
    expect(PENDING_ACTIONS).toEqual([]);
    for (const id of PENDING_ACTIONS) expect(ids.has(id)).toBe(false);
  });

  test(":open's page.open is an action now (m1-cmdline): open_url, unbound by default", () => {
    expect(getAction("open_url")).toMatchObject({ id: "page.open", group: "Navigation" });
  });

  test("command names and aliases are unique and every command has a description", () => {
    const names = COMMANDS.flatMap((c) => [c.name, ...c.aliases]);
    expect(new Set(names).size).toBe(names.length);
    for (const c of COMMANDS) expect(c.description.length).toBeGreaterThan(0);
  });
});

describe("completeCommandLine", () => {
  const values = (text, opts) => completeCommandLine(text, opts).candidates.map((c) => c.value);

  test("tab → tabnew, tabrename, tabsearch first, then actions", () => {
    const v = values(":tab");
    expect(v.slice(0, 3)).toEqual(["tabnew", "tabrename", "tabsearch"]);
    expect(completeCommandLine(":tab").word).toBe("tab");
    expect(completeCommandLine(":tab").candidates[3].kind).toBe("action");
  });

  test("wsp → wsprev", () => {
    expect(values("wsp")[0]).toBe("wsprev");
    expect(values("::wsp")[0]).toBe("wsprev");
  });

  test("fuzzy scd → scroll_down before scroll_half_down", () => {
    const v = values(":scd");
    expect(v).toContain("scroll_down");
    expect(v.indexOf("scroll_down")).toBeLessThan(v.indexOf("scroll_half_down"));
  });

  test("prefix matches come before fuzzy matches", () => {
    const v = values(":sp");
    expect(v[0]).toBe("sp");
    const firstFuzzy = v.findIndex((x) => !x.startsWith("sp"));
    expect(v.slice(firstFuzzy).every((x) => !x.startsWith("sp"))).toBe(true);
  });

  test("an empty word lists commands then actions, cut at limit", () => {
    const all = completeCommandLine(":", { limit: 1000 }).candidates;
    const commandCount = COMMANDS.reduce((n, c) => n + 1 + c.aliases.length, 0);
    expect(all).toHaveLength(commandCount + new Set(ACTIONS.map((a) => a.name)).size);
    expect(all.slice(0, commandCount).every((c) => c.kind === "command")).toBe(true);
    expect(values("")).toHaveLength(20);
    expect(values("", { limit: 3 })).toEqual(["open", "tabnew", "tabrename"]);
  });

  test("case-insensitive", () => {
    expect(values("TABN")[0]).toBe("tabnew");
  });

  test("after the command word there is nothing to complete", () => {
    expect(completeCommandLine(":tabnew x")).toEqual({ word: "tabnew", candidates: [] });
    expect(completeCommandLine(":tabnew ").candidates).toEqual([]);
  });

  test("each candidate has a description; an alias says what it is short for", () => {
    for (const c of completeCommandLine("", { limit: 1000 }).candidates) {
      expect(c.description.length).toBeGreaterThan(0);
    }
    const vs = completeCommandLine(":vs").candidates.find((c) => c.value === "vs");
    expect(vs.description).toContain("vsplit");
  });

  test(":theme completes dark, light and system", () => {
    expect(values(":theme ")).toEqual(["theme dark", "theme light", "theme system"]);
    expect(values(":theme li")).toEqual(["theme light"]);
    const c = completeCommandLine(":theme sy").candidates[0];
    expect(c).toMatchObject({ label: "system", kind: "argument", description: "appearance" });
  });

  test(":toolbar completes show and hide", () => {
    expect(values(":toolbar ")).toEqual(["toolbar show", "toolbar hide"]);
    expect(values(":toolbar hi")[0]).toBe("toolbar hide");
    const c = completeCommandLine(":toolbar sh").candidates[0];
    expect(c).toMatchObject({ label: "show", kind: "argument", description: "toolbar" });
  });

  test(":bookmarkstoolbar completes show, hide and newtab", () => {
    expect(values(":bookmarkstoolbar ")).toEqual([
      "bookmarkstoolbar show",
      "bookmarkstoolbar hide",
      "bookmarkstoolbar newtab",
    ]);
    expect(values(":bookmarkstoolbar sho")).toEqual(["bookmarkstoolbar show"]);
    const c = completeCommandLine(":bookmarkstoolbar ne").candidates[0];
    expect(c).toMatchObject({
      label: "newtab",
      kind: "argument",
      description: "bookmarks toolbar",
    });
  });

  test("no match gives no candidates", () => {
    expect(values(":qqqqqqqq")).toEqual([]);
  });
});

describe("parseToolbarCommand: :toolbar [show|hide]", () => {
  test("without text it toggles; show and hide set the state, in any case", () => {
    expect(parseToolbarCommand(undefined)).toEqual({ kind: "toggle" });
    expect(parseToolbarCommand("  ")).toEqual({ kind: "toggle" });
    expect(parseToolbarCommand("show")).toEqual({ kind: "show" });
    expect(parseToolbarCommand(" HIDE ")).toEqual({ kind: "hide" });
  });

  test("an unknown word is refused, with the closest name when one is close", () => {
    expect(parseToolbarCommand("hid")).toEqual({
      kind: "refuse",
      text: ':toolbar takes "show", "hide" or nothing: did you mean "hide"?',
    });
    expect(parseToolbarCommand("sideways")).toEqual({
      kind: "refuse",
      text: ':toolbar takes "show", "hide" or nothing',
    });
  });
});

describe("parseBookmarksToolbarCommand: :bookmarkstoolbar [show|hide|newtab]", () => {
  test("without text it toggles; each word sets its state, in any case", () => {
    expect(parseBookmarksToolbarCommand(undefined)).toEqual({ kind: "toggle" });
    expect(parseBookmarksToolbarCommand(" ")).toEqual({ kind: "toggle" });
    expect(parseBookmarksToolbarCommand("show")).toEqual({ kind: "set", setting: "shown" });
    expect(parseBookmarksToolbarCommand(" HIDE ")).toEqual({ kind: "set", setting: "hidden" });
    expect(parseBookmarksToolbarCommand("newtab")).toEqual({ kind: "set", setting: "newtab" });
  });

  test("an unknown word is refused, with the closest one when it is close", () => {
    const refusal = ':bookmarkstoolbar takes "show", "hide", "newtab" or nothing';
    expect(parseBookmarksToolbarCommand("shw")).toEqual({
      kind: "refuse",
      text: `${refusal}: did you mean "show"?`,
    });
    expect(parseBookmarksToolbarCommand("blue")).toEqual({ kind: "refuse", text: refusal });
  });
});

describe("history", () => {
  const push = (h, ...lines) => lines.reduce(pushHistory, h);

  test("push trims, drops empty lines, dedupes to newest, honours limit", () => {
    let h = push(createHistory({ limit: 3 }), "a", "  ", " b ", "c", "a");
    expect(h.entries).toEqual(["b", "c", "a"]);
    h = pushHistory(h, "d");
    expect(h.entries).toEqual(["c", "a", "d"]);
    expect(createHistory().limit).toBe(100);
  });

  test("Up walks back saving the draft; Down returns to it", () => {
    let h = push(createHistory(), "tabnew", "ls", "source");
    let out = historyPrevious(h, "");
    expect(out.text).toBe("source");
    out = historyPrevious(out.history, out.text);
    expect(out.text).toBe("ls");
    out = historyNext(out.history, out.text);
    expect(out.text).toBe("source");
    out = historyNext(out.history, out.text);
    expect(out.text).toBe("");
    expect(out.history.index).toBe(null);
  });

  test("Up recalls only lines starting with the draft, and does not wrap", () => {
    const h = push(createHistory(), "tabnew a", "ls", "tabnew b");
    let out = historyPrevious(h, "tab");
    expect(out.text).toBe("tabnew b");
    out = historyPrevious(out.history, out.text);
    expect(out.text).toBe("tabnew a");
    out = historyPrevious(out.history, out.text);
    expect(out.text).toBe("tabnew a");
    out = historyNext(out.history, out.text);
    expect(out.text).toBe("tabnew b");
    out = historyNext(out.history, out.text);
    expect(out.text).toBe("tab");
  });

  test("Up with no match keeps the current text; Down with no cursor returns it", () => {
    const h = push(createHistory(), "ls");
    expect(historyPrevious(h, "zz").text).toBe("zz");
    expect(historyNext(h, "typed")).toEqual({ history: h, text: "typed" });
    expect(historyPrevious(createHistory(), "x").text).toBe("x");
  });

  test("reset clears the cursor; push resets it too", () => {
    const h = push(createHistory(), "ls", "q");
    const up = historyPrevious(h, "").history;
    expect(up.index).not.toBe(null);
    expect(resetHistoryCursor(up)).toMatchObject({ index: null, draft: "" });
    expect(pushHistory(up, "x")).toMatchObject({ index: null, draft: "" });
  });

  test("histories are frozen and never mutated", () => {
    const h = createHistory();
    pushHistory(h, "a");
    expect(h.entries).toEqual([]);
    expect(Object.isFrozen(h)).toBe(true);
  });

  test("a bad limit throws", () => {
    expect(() => createHistory({ limit: 0 })).toThrow(RangeError);
    expect(() => createHistory({ limit: 1.5 })).toThrow(RangeError);
  });
});

describe("workspace commands like Vim's buffer commands", () => {
  test.each([
    [":ws", run("workspace", "workspace.picker")],
    [":ws work", run("workspace", "workspace.switch", { text: "work" })],
    [":ws 2", run("workspace", "workspace.switch", { text: "2" })],
    [":ws #", run("workspace", "workspace.switch", { text: "#" })],
    [":wn", run("wsnext", "workspace.next")],
    [":wsn", run("wsnext", "workspace.next")],
    [":wp", run("wsprev", "workspace.previous")],
    [":wd", run("wsdelete", "workspace.close")],
    [":wd shop", run("wsdelete", "workspace.close", { text: "shop" })],
    [":wa shop", run("wsnew", "workspace.new", { text: "shop" })],
    [":workspaces", run("workspaces", "workspace.picker")],
    [":last_workspace", run("last_workspace", "workspace.last")],
  ])("%j", (text, expected) => {
    expect(parseCommandLine(text)).toEqual(expected);
  });

  test.each([":wn x", ":wp x", ":workspaces x"])("%j takes no argument", (text) => {
    expect(parseCommandLine(text).error.code).toBe("unexpected-argument");
  });

  test("no command word is two commands' (aliases included)", () => {
    const words = COMMANDS.flatMap((c) => [c.name, ...c.aliases]);
    expect(new Set(words).size).toBe(words.length);
  });

  test("a command whose name begins every other match wins a shared prefix", () => {
    // :wor could be :workspace or :workspaces; Vim takes the shorter, so do we.
    expect(parseCommandLine(":wor")).toEqual(run("workspace", "workspace.picker"));
    expect(parseCommandLine(":workspac 2")).toEqual(
      run("workspace", "workspace.switch", { text: "2" }),
    );
    expect(parseCommandLine(":bookm")).toEqual(run("bookmark", "bookmark.add"));
    expect(parseCommandLine(":addo")).toEqual(run("addon", "addons.popup"));
    expect(parseCommandLine(":wsr")).toEqual(run("wsrename", "workspace.rename"));
    // still ambiguous when no candidate begins all the others
    expect(parseCommandLine(":s").error.code).toBe("ambiguous-command");
  });

  test("Tab completes workspace names after :ws, :workspace, :wd, :wsdelete and :wsmove", () => {
    const names = ["work", "personal", "my ws"];
    const complete = (/** @type {string} */ line) =>
      completeCommandLine(line, { args: { workspace: names } }).candidates;
    expect(complete(":ws ").map((c) => c.value)).toEqual(["ws work", "ws personal", "ws my ws"]);
    expect(complete(":ws per").map((c) => c.value)).toEqual(["ws personal"]);
    expect(complete(":ws per")[0]).toMatchObject({
      kind: "argument",
      label: "personal",
      description: "workspace",
    });
    expect(complete(":workspace wo").map((c) => c.value)).toEqual(["workspace work"]);
    expect(complete(":wd my").map((c) => c.value)).toEqual(["wd my ws"]);
    expect(complete(":wsdelete wo").map((c) => c.value)).toEqual(["wsdelete work"]);
    expect(complete(":wsmove wo").map((c) => c.value)).toEqual(["wsmove work"]);
    // :wa names a new workspace: nothing to complete
    expect(complete(":wa wo")).toEqual([]);
    // workspace names never complete :addon
    expect(completeCommandLine(":addon wo", { args: { workspace: names } }).candidates).toEqual([]);
  });
});

describe(":firefox (docs/specs/firefox-keys.md decision 5)", () => {
  test("runs firefox.command with the id as its text", () => {
    expect(parseCommandLine(":firefox Tools:Downloads")).toEqual(
      run("firefox", "firefox.command", { text: "Tools:Downloads" }),
    );
  });

  test("needs an id", () => {
    expect(parseCommandLine(":firefox")).toMatchObject({
      kind: "error",
      error: { code: "missing-argument" },
    });
  });

  test("Tab completes the window's ids the host supplies", () => {
    const { candidates } = completeCommandLine(":firefox down", {
      args: { firefox: ["Browser:Reload", "Tools:Downloads"] },
    });
    expect(candidates.map((c) => c.value)).toEqual(["firefox Tools:Downloads"]);
    expect(candidates[0]?.description).toBe("Firefox command");
  });
});
