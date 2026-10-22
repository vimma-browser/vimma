// docs/specs/vimma-mcp.md, sub-PR 2b: the question line in core. When it may open by itself
// (decision 14), what it says (13), what each key does (13, 20), the notices (15, 16, 23), the
// status bar's agent state (24), full control's question (29 C) and `:control` (29 D).
import { describe, test, expect } from "vitest";
import {
  CONTROL_MAX_MINUTES,
  controlEnd,
  FULL_CONTROL,
  QUIET_MS,
  agentAlertText,
  agentState,
  clientName,
  controlOnQuestion,
  controlStatus,
  deniedNotice,
  grantNotice,
  mayOpenByItself,
  noGrant,
  parseControlCommand,
  promptKey,
  questionLine,
  logRow,
  ranNotice,
  shownNotice,
} from "../src/agent-prompt.mjs";
import { textWidth } from "../src/textwidth.mjs";

const MIN = 60_000;
const label = { client: "example-agent", via: "example" };
const read = {
  tool: "vimma_read_page",
  label,
  what: {
    tab: "7",
    index: 2,
    title: "Pull requests · vimma-browser/vimma",
    url: "https://github.com/vimma-browser/vimma/pulls",
  },
};
const open = {
  tool: "vimma_open",
  label,
  what: { url: "https://docs.rs/serde/latest/serde/", host: "docs.rs" },
};
const full = { tool: FULL_CONTROL, label: { client: "vimma-ctl" }, what: {} };
const keys = {
  tool: "vimma_keys",
  label: { client: "claude-code" },
  what: {
    tab: "7",
    index: 2,
    title: "Pricing · Example",
    url: "https://example.com/pricing",
    keys: '3j /"pricing"⏎ gg',
  },
};
/** @param {{ parts: { text: string }[] }} line */
const text = (line) => line.parts.map((p) => p.text).join("");

describe("when the question may open by itself (decision 14)", () => {
  const calm = { focused: true, inField: false, sinceKeyMs: 10_000, otherOpen: false };
  test("a focused window, no field, no key for 1,500 ms, nothing else open: it opens", () => {
    expect(mayOpenByItself({ ...calm, fullscreen: false })).toBe(true);
    expect(mayOpenByItself({ ...calm, fullscreen: false, sinceKeyMs: QUIET_MS })).toBe(true);
  });
  test.each([
    ["the window is not focused", { focused: false }],
    ["focus is in a field", { inField: true }],
    ["a key was pressed in the last 1,500 ms", { sinceKeyMs: QUIET_MS - 1 }],
    ["another prompt, picker or the command line is open", { otherOpen: true }],
    ["the page is in DOM full screen", { fullscreen: true }],
  ])("it waits when %s", (_why, change) => {
    expect(mayOpenByItself({ ...calm, fullscreen: false, ...change })).toBe(false);
  });
});

describe("the question's text (decision 13)", () => {
  test("a read names the client, the tool, the tab's place, title and URL", () => {
    const line = questionLine(read, { grantMinutes: 15 });
    expect(text(line)).toBe(
      '◇ example-agent wants vimma_read_page: 2 "Pull requests · vimma-browser/vimma" ' +
        "github.com/vimma-browser/vimma/pulls",
    );
    expect(line.hint).toBe("y once · 15a for 15 min · n deny · x mute");
    expect(line.label).toBe(text(line));
  });

  test("an open shows the full URL with its host in bold", () => {
    const line = questionLine(open, { grantMinutes: 10 });
    expect(text(line)).toBe(
      "◇ example-agent wants vimma_open: https://docs.rs/serde/latest/serde/",
    );
    expect(line.parts.filter((p) => p.strong).map((p) => p.text)).toEqual(["docs.rs"]);
  });

  test("an open into an agent tab says which tab it replaces", () => {
    const into = {
      ...open,
      what: { ...open.what, tab: "7", title: "Old", current: "https://a.b/" },
    };
    expect(text(questionLine(into, { grantMinutes: 10 }))).toBe(
      '◇ example-agent wants vimma_open: https://docs.rs/serde/latest/serde/ in "Old"',
    );
  });

  // mcp-drive D14: the keys exactly as they will run, after parsing.
  test("vimma_keys shows the tab and the keys as they will run", () => {
    const line = questionLine(keys, { grantMinutes: 15 });
    expect(text(line)).toBe(
      '◇ claude-code wants vimma_keys: 2 "Pricing · Example" example.com/pricing  keys: ' +
        '3j /"pricing"⏎ gg',
    );
    expect(line.hint).toBe("y once · 15a for 15 min · n deny · x mute");
    const shown = line.parts.find((p) => p.text === '3j /"pricing"⏎ gg');
    expect(shown?.isolate).toBe("ltr");
  });

  test("the tab list and a close", () => {
    const tabs = { tool: "vimma_tabs", label, what: { count: 4 } };
    expect(text(questionLine(tabs, { grantMinutes: 10 }))).toBe(
      "◇ example-agent wants vimma_tabs: the list of agent tabs (4)",
    );
    const close = { ...read, tool: "vimma_close_tab" };
    expect(text(questionLine(close, { grantMinutes: 10 }))).toBe(
      '◇ example-agent wants vimma_close_tab: 2 "Pull requests · vimma-browser/vimma" ' +
        "github.com/vimma-browser/vimma/pulls",
    );
  });

  test("full control asks y/N, with no grant (decision 29)", () => {
    const line = questionLine(full, { grantMinutes: 10 });
    expect(text(line)).toBe(
      '◇ a client with no code wants full control (every workspace, not only "agent") — y/N',
    );
    expect(line.hint).toBe("y allow · n deny");
  });

  // mcp-drive D23 (security.md M22): the question is asked only while MCP is on, so it always
  // says that full control reaches past the agent workspace, by the workspace's own name.
  test("full control names the agent workspace it reaches beyond", () => {
    const line = questionLine(
      { ...full, what: { code: "7F3K" } },
      { grantMinutes: 10, agentWorkspace: "bots\u202e" },
    );
    expect(text(line)).toBe(
      '◇ vimma-ctl with code 7F3K wants full control (every workspace, not only "bots") — y/N',
    );
    expect(line.parts.find((p) => p.text === "bots")?.isolate).toBe("auto");
    expect(line.label).toBe(text(line));
  });

  // The code vimma-ctl printed tells a racing client's question apart.
  test("full control shows the client's code, in bold", () => {
    const line = questionLine({ ...full, what: { code: "7F3K" } }, { grantMinutes: 10 });
    expect(text(line)).toBe(
      '◇ vimma-ctl with code 7F3K wants full control (every workspace, not only "agent") — y/N',
    );
    expect(line.parts.filter((p) => p.strong).map((p) => p.text)).toEqual(["7F3K"]);
    expect(line.hint).toBe("y if the code is the one vimma-ctl printed · n deny");
  });

  // Text an agent or a page chooses is isolated, so a right-to-left run
  // in a title or a client name cannot reorder the rest of the question.
  test("the client name and titles are isolated, URLs are isolated left to right", () => {
    const iso = (/** @type {any} */ line) =>
      line.parts
        .filter((/** @type {any} */ p) => p.isolate)
        .map((/** @type {any} */ p) => [p.text, p.isolate]);
    expect(iso(questionLine(read, { grantMinutes: 10 }))).toEqual([
      ["example-agent", "auto"],
      ["Pull requests · vimma-browser/vimma", "auto"],
      ["github.com/vimma-browser/vimma/pulls", "ltr"],
    ]);
    expect(iso(questionLine(open, { grantMinutes: 10 }))).toEqual([
      ["example-agent", "auto"],
      ["https://", "ltr"],
      ["docs.rs", "ltr"],
      ["/serde/latest/serde/", "ltr"],
    ]);
  });

  test("a hostile title of 300 characters is literal text cut at 60 columns", () => {
    const title = `<img src=x onerror=alert(1)>${"x".repeat(272)}`;
    const line = questionLine({ ...read, what: { ...read.what, title } }, { grantMinutes: 10 });
    const shown = /** @type {string} */ (/"(.*)"/.exec(text(line))?.[1]);
    expect(shown.startsWith("<img src=x onerror=alert(1)>")).toBe(true);
    expect(textWidth(shown)).toBe(60);
    expect(shown.endsWith("…")).toBe(true);
  });

  test("the client is its name, else the parent process, else an agent", () => {
    expect(clientName({ client: "codex", via: "node" })).toBe("codex");
    expect(clientName({ client: "", via: "node" })).toBe("node");
    expect(clientName({ client: "" })).toBe("an agent");
    expect(clientName(null)).toBe("an agent");
  });

  test("control characters in a label or title never reach the line", () => {
    const evil = { client: "a\nb\u202ec" };
    expect(clientName(evil)).toBe("a b c");
  });
});

describe("the keys (decisions 13 and 20)", () => {
  const none = { count: "" };
  test("y allows once; n, Esc and Enter deny; x denies and mutes", () => {
    expect(promptKey(none, "y")).toEqual({ kind: "answer", answer: { kind: "once" } });
    expect(promptKey(none, "Y")).toEqual({ kind: "answer", answer: { kind: "once" } });
    for (const key of ["n", "esc", "enter"]) {
      expect(promptKey(none, key)).toEqual({ kind: "answer", answer: { kind: "deny" } });
    }
    expect(promptKey(none, "x")).toEqual({ kind: "answer", answer: { kind: "mute" } });
  });

  test("a count then a grants that many minutes; a bare a the default", () => {
    let s = none;
    for (const d of ["1", "5"]) {
      const r = promptKey(s, d);
      expect(r.kind).toBe("count");
      s = { count: /** @type {{ count: string }} */ (r).count };
    }
    expect(s.count).toBe("15");
    expect(promptKey(s, "a")).toEqual({ kind: "answer", answer: { kind: "grant", minutes: 15 } });
    expect(promptKey(none, "a")).toEqual({
      kind: "answer",
      answer: { kind: "grant", minutes: null },
    });
  });

  test("backspace takes a digit back; a leading 0 and a fifth digit are ignored", () => {
    expect(promptKey({ count: "15" }, "backspace")).toEqual({ kind: "count", count: "1" });
    expect(promptKey(none, "0")).toEqual({ kind: "ignore" });
    expect(promptKey({ count: "1440" }, "9")).toEqual({ kind: "ignore" });
  });

  test("any other key neither allows nor denies", () => {
    for (const key of ["j", "q", "space", "ctrl+y", "alt+n", "shift+a", "tab", "f5"]) {
      expect(promptKey(none, key)).toEqual({ kind: "ignore" });
    }
  });

  test("full control: only y allows; no count, no grant; x is a plain no", () => {
    const f = { full: true };
    expect(promptKey(none, "y", f)).toEqual({ kind: "answer", answer: { kind: "once" } });
    expect(promptKey(none, "x", f)).toEqual({ kind: "answer", answer: { kind: "deny" } });
    expect(promptKey(none, "a", f)).toEqual({ kind: "ignore" });
    expect(promptKey(none, "5", f)).toEqual({ kind: "ignore" });
  });
});

describe("notices and notifications (decisions 15, 16 and 23)", () => {
  test("a grant says what and for how long, and when it was capped", () => {
    expect(grantNotice(read, { minutes: 15, capped: false })).toBe(
      "example-agent may use vimma_read_page for 15 min (:mcp revoke ends it)",
    );
    expect(grantNotice(read, { minutes: 480, capped: true })).toBe(
      "example-agent may use vimma_read_page for 480 min, the most [mcp] grant_max_minutes allows " +
        "(:mcp revoke ends it)",
    );
  });

  test("a call under a grant shows what it did and the time left", () => {
    expect(ranNotice(read, 14 * MIN + 1, 0)).toBe(
      'example-agent read "Pull requests · vimma-browser/vimma" (grant, 15m left)',
    );
    expect(ranNotice(open, 59_000, 0)).toBe("example-agent opened docs.rs (grant, 1m left)");
    expect(ranNotice({ ...read, tool: "vimma_tabs", what: { count: 2 } }, MIN, 0)).toBe(
      "example-agent listed the agent tabs (grant, 1m left)",
    );
    expect(ranNotice(keys, 12 * MIN, 0)).toBe(
      'claude-code pressed 3j /"pricing"⏎ gg in "Pricing · Example" (grant, 12m left)',
    );
    // mcp-drive D14: a follow under a grant names the host it loaded.
    const followed = { ...keys, what: { ...keys.what, keys: "fsd", followed: "docs.example.com" } };
    expect(ranNotice(followed, 12 * MIN, 0)).toBe(
      'claude-code followed a link to docs.example.com in "Pricing · Example" (grant, 12m left)',
    );
    expect(ranNotice({ ...read, tool: "vimma_close_tab" }, MIN, 0)).toBe(
      'example-agent closed "Pull requests · vimma-browser/vimma" (grant, 1m left)',
    );
  });

  // docs/specs/mcp-forms.md F28: vimma_elements asks with the tab, and its notice names it.
  test("vimma_elements: the tab in the question, the page in the notice", () => {
    const elements = { ...keys, tool: "vimma_elements", what: { ...keys.what, keys: undefined } };
    expect(text(questionLine(elements, { grantMinutes: 10 }))).toBe(
      '◇ claude-code wants vimma_elements: 2 "Pricing · Example" example.com/pricing',
    );
    expect(ranNotice(elements, 12 * MIN, 0)).toBe(
      'claude-code listed the buttons and fields of "Pricing · Example" (grant, 12m left)',
    );
    expect(agentAlertText(elements)).toBe(
      "claude-code asks to use Vimma's agent workspace (list a page's buttons and fields)",
    );
  });

  // docs/specs/mcp-forms.md F28: vimma_activate asks with the tab and the element; a submit
  // asks with the form's method and destination, offers no grant (F15) and names its fields.
  test("vimma_activate: the element in the question, what it clicked in the notice", () => {
    const activate = {
      tool: "vimma_activate",
      label: { client: "claude-code" },
      what: {
        tab: "7",
        index: 2,
        title: "List · Example",
        url: "https://example.com/list",
        label: "sg",
        kind: "button",
        text: "Add to list",
      },
    };
    expect(text(questionLine(activate, { grantMinutes: 10 }))).toBe(
      '◇ claude-code wants vimma_activate: 2 "List · Example" example.com/list  sg button "Add to list"',
    );
    expect(noGrant(activate)).toBe(false);
    expect(ranNotice(activate, 12 * MIN, 0)).toBe(
      'claude-code clicked button "Add to list" in "List · Example" (grant, 12m left)',
    );
    expect(agentAlertText(activate)).toBe(
      "claude-code asks to use Vimma's agent workspace (click on a page)",
    );
    const long = { ...activate, what: { ...activate.what, text: "x".repeat(100) } };
    expect(text(questionLine(long, { grantMinutes: 10 }))).toMatch(/ sg button "x{59}…"$/);
  });

  test("a submit: method and host in bold, the field count, y or n only", () => {
    const submit = {
      tool: "vimma_activate",
      label: { client: "claude-code" },
      what: {
        tab: "7",
        index: 2,
        title: "Sign up · Example",
        url: "https://example.com/signup",
        label: "sg",
        kind: "button",
        text: "Sign up",
        submit: {
          method: "post",
          action: "https://example.com/api/signup",
          host: "example.com",
          fields: 3,
        },
      },
    };
    const line = questionLine(submit, { grantMinutes: 10 });
    expect(text(line)).toBe(
      '◇ claude-code wants to submit a form: 2 "Sign up · Example" → POST example.com/api/signup (3 fields)',
    );
    expect(line.parts.filter((p) => p.strong).map((p) => p.text)).toEqual(["POST", "example.com"]);
    expect(line.hint).toBe("y submit once · n deny");
    expect(noGrant(submit)).toBe(true);
    expect(promptKey({ count: "" }, "a", { noGrant: noGrant(submit) })).toEqual({ kind: "ignore" });
    expect(agentAlertText(submit)).toBe(
      "claude-code asks to use Vimma's agent workspace (submit a form)",
    );
    const one = {
      ...submit,
      what: { ...submit.what, submit: { ...submit.what.submit, fields: 1 } },
    };
    expect(text(questionLine(one, { grantMinutes: 10 }))).toMatch(/\(1 field\)$/);
  });

  test("denials and timeouts", () => {
    expect(deniedNotice(read, "user")).toBe("denied example-agent's vimma_read_page");
    expect(deniedNotice(read, "timeout")).toBe("agent request timed out (denied)");
    expect(deniedNotice(read, "mute")).toBe(
      "denied example-agent's vimma_read_page; muted until it reconnects",
    );
    expect(deniedNotice(full, "user")).toBe("denied vimma-ctl full control");
  });

  test("the desktop notification names the client and the kind of request, never a URL", () => {
    expect(agentAlertText(read)).toBe(
      "example-agent asks to use Vimma's agent workspace (read a page)",
    );
    expect(agentAlertText(open)).toBe(
      "example-agent asks to use Vimma's agent workspace (open a page)",
    );
    expect(agentAlertText(keys)).toBe(
      "claude-code asks to use Vimma's agent workspace (move around a page)",
    );
    expect(agentAlertText(full)).toBe("vimma-ctl asks for full control of Vimma (every workspace)");
    for (const q of [read, open]) expect(agentAlertText(q)).not.toMatch(/github|docs\.rs|http/);
  });
});

describe("the status bar's agent state (decision 24)", () => {
  test("nothing without an agent connection or a question", () => {
    expect(agentState({ connections: 0, waiting: 0, grants: [], ranAt: null, now: 0 })).toBe(null);
  });
  test("waiting questions, the shortest grant in minutes, a request that just ran", () => {
    const base = { connections: 1, waiting: 0, grants: [], ranAt: null, now: 0 };
    expect(agentState(base)).toEqual({ waiting: 0, minutes: null, ran: false });
    expect(agentState({ ...base, waiting: 2 })).toMatchObject({ waiting: 2 });
    expect(agentState({ ...base, grants: [{ until: 14 * MIN }, { until: 30 * MIN }] })).toEqual({
      waiting: 0,
      minutes: 14,
      ran: false,
    });
    expect(agentState({ ...base, ranAt: 0, now: 1999 }).ran).toBe(true);
    expect(agentState({ ...base, ranAt: 0, now: 2000 }).ran).toBe(false);
  });
  test("a full-control question with no agent connected still shows", () => {
    expect(agentState({ connections: 0, waiting: 1, grants: [], ranAt: null, now: 0 })).toEqual({
      waiting: 1,
      minutes: null,
      ran: false,
    });
  });
});

describe(":control (decision 29 D)", () => {
  test("parses on <minutes>, off, and the status", () => {
    expect(parseControlCommand("")).toEqual({ kind: "status" });
    expect(parseControlCommand(" on 15 ")).toEqual({ kind: "on", minutes: 15 });
    expect(parseControlCommand("off")).toEqual({ kind: "off" });
    expect(parseControlCommand(`on ${CONTROL_MAX_MINUTES}`)).toEqual({
      kind: "on",
      minutes: CONTROL_MAX_MINUTES,
    });
  });
  test.each(["on", "on 0", "on -5", "on 1.5", `on ${CONTROL_MAX_MINUTES + 1}`, "on x", "maybe"])(
    "refuses %j",
    (t) => {
      expect(parseControlCommand(t).kind).toBe("refuse");
    },
  );
  // mcp-drive D22 (security.md M22): while MCP is on, an agent with a shell can use full
  // control too, so the question says what it gives away.
  test("while MCP is on, the question says full control reaches beyond the agent workspace", () => {
    // The name is set apart as its own bidi run (security.md M4), as in the question line.
    expect(controlOnQuestion(15, "agent")).toBe(
      'Turn on full control for 15 min? It reaches every workspace and tab, not only "\u2068agent\u2069", ' +
        "and any local AI agent with a shell can use it. y/N",
    );
    expect(controlOnQuestion(1, "bots\n\u202e")).toBe(
      'Turn on full control for 1 min? It reaches every workspace and tab, not only "\u2068bots\u2069", ' +
        "and any local AI agent with a shell can use it. y/N",
    );
  });
  test("the question and the status", () => {
    expect(controlOnQuestion(15)).toBe(
      "Turn on full control (vimma-ctl: keys in this window, every workspace) for 15 min? y/N",
    );
    expect(controlOnQuestion(15, null)).toBe(controlOnQuestion(15));
    expect(controlStatus({ enabled: false, until: null, now: 0 })).toBe(
      "full control off (:control on <minutes>)",
    );
    expect(controlStatus({ enabled: true, until: 14 * MIN + 1, now: 0 })).toBe(
      "full control on, 15m left",
    );
    expect(controlStatus({ enabled: true, until: null, now: 0 })).toBe(
      "full control on (vimma.control.enabled, no time limit)",
    );
  });
});

// The end time of :control on fails closed.
describe(":control's end time", () => {
  const now = 1_800_000_000_000;
  test("no pref: no end time (control set in about:config)", () => {
    expect(controlEnd(undefined, now)).toEqual({ kind: "none" });
  });
  test("a time ahead, within 1440 minutes and a minute: control stays on until then", () => {
    expect(controlEnd(String(now + 15 * MIN), now)).toEqual({
      kind: "until",
      until: now + 15 * MIN,
    });
    expect(controlEnd(String(now + (CONTROL_MAX_MINUTES + 1) * MIN), now).kind).toBe("until");
  });
  test.each([
    ["passed", String(now - 1)],
    ["now", String(now)],
    [
      "beyond the cap (a clock moved back, or a hand edit)",
      String(now + (CONTROL_MAX_MINUTES + 2) * MIN),
    ],
    ["empty", ""],
    ["zero", "0"],
    ["negative", "-5"],
    ["not a number", "soon"],
    ["a fraction", "1.5"],
    ["seconds in exponent form", "1e15"],
    ["too long to be exact", "99999999999999999999"],
  ])("%s: off", (_why, raw) => {
    expect(controlEnd(raw, now)).toEqual({ kind: "off" });
  });
});

// docs/specs/vimma-mcp.md, decision 31 (sub-PR 2c): a download asks with its name, size, type
// and host, never the URL; a dangerous one is allowed only with `!`, for that one file.
describe("a download's question (decision 31 a, d)", () => {
  const none = { count: "" };
  const download = {
    tool: "vimma_download",
    label,
    what: {
      name: "report.pdf",
      size: 2_100_000,
      type: "application/pdf",
      ext: "pdf",
      host: "example.com",
    },
  };
  const page = { ...download, label: { client: "a page in the agent workspace" } };

  test("name, size, type and extension, and the host in bold; no URL", () => {
    const line = questionLine(download, { grantMinutes: 10 });
    expect(text(line)).toBe(
      '◇ example-agent wants vimma_download: "report.pdf" 2.1 MB application/pdf (.pdf) ' +
        "from example.com",
    );
    expect(line.parts.filter((p) => p.strong).map((p) => p.text)).toEqual(["example.com"]);
    expect(line.hint).toBe("y once · 10a for 10 min · n deny · x mute");
  });

  test("an unknown size and type say so", () => {
    const what = { name: "blob", size: -1, type: "", ext: "", host: "example.com" };
    expect(text(questionLine({ ...download, what }, { grantMinutes: 10 }))).toBe(
      '◇ example-agent wants vimma_download: "blob" unknown size unknown type from example.com',
    );
  });

  test("a dangerous file says why, and only ! allows it", () => {
    const what = { ...download.what, name: "setup.sh", danger: "a script" };
    const line = questionLine({ ...download, what }, { grantMinutes: 10 });
    expect(text(line)).toBe(
      '◇ example-agent wants vimma_download: "setup.sh" 2.1 MB application/pdf (.pdf) ' +
        "from example.com — ⚠ a script",
    );
    expect(line.hint).toBe("! allow this one file · n deny");
  });

  // When ClamAV could not scan it, keeping it is asked.
  test("ClamAV could not scan it: y keeps it, anything else deletes it", () => {
    const what = { ...download.what, unscanned: "ClamAV failed" };
    const line = questionLine({ ...download, what }, { grantMinutes: 10 });
    expect(text(line)).toMatch(/ — ⚠ not scanned: ClamAV failed; keep it\?$/);
    expect(line.hint).toBe("y keep it unscanned · n delete");
    const u = { noGrant: true };
    expect(promptKey(none, "y", u)).toEqual({ kind: "answer", answer: { kind: "once" } });
    expect(promptKey(none, "a", u)).toEqual({ kind: "ignore" });
  });

  test("a download no agent asked for (a page's own) cannot be granted", () => {
    const line = questionLine(page, { grantMinutes: 10 });
    expect(text(line)).toMatch(/^◇ a page in the agent workspace wants vimma_download: /);
    expect(line.hint).toBe("y once · n deny");
  });

  test("the name is isolated text, cut at 60 columns", () => {
    const what = { ...download.what, name: `\u202e${"x".repeat(100)}.pdf` };
    const line = questionLine({ ...download, what }, { grantMinutes: 10 });
    const name = line.parts.find((p) => p.isolate === "auto");
    expect(name?.text).not.toMatch(/\u202e/);
    expect(textWidth(name?.text ?? "")).toBeLessThanOrEqual(60);
  });

  test("! allows a dangerous one; y, a and counts do nothing there", () => {
    const d = { dangerous: true };
    expect(promptKey(none, "!", d)).toEqual({ kind: "answer", answer: { kind: "once" } });
    for (const key of ["y", "Y", "a", "5"])
      expect(promptKey(none, key, d)).toEqual({ kind: "ignore" });
    expect(promptKey(none, "n", d)).toEqual({ kind: "answer", answer: { kind: "deny" } });
    expect(promptKey(none, "x", d)).toEqual({ kind: "answer", answer: { kind: "mute" } });
    expect(promptKey(none, "!")).toEqual({ kind: "ignore" });
  });

  test("a page's download: y or n, no grant, and x is a plain no", () => {
    const p = { noGrant: true };
    expect(promptKey(none, "y", p)).toEqual({ kind: "answer", answer: { kind: "once" } });
    expect(promptKey(none, "a", p)).toEqual({ kind: "ignore" });
    expect(promptKey(none, "3", p)).toEqual({ kind: "ignore" });
    expect(promptKey(none, "x", p)).toEqual({ kind: "answer", answer: { kind: "deny" } });
  });

  test("under a grant, the notice; the notification names no file or host", () => {
    expect(ranNotice(download, 9 * MIN, 0)).toBe(
      'example-agent downloads "report.pdf" (grant, 9m left)',
    );
    expect(agentAlertText(download)).toBe(
      "example-agent asks to use Vimma's agent workspace (download a file)",
    );
  });
});

// docs/specs/mcp-drive.md D2-D6 (security.md M19): vimma_show asks y or n for one agent tab, no
// grant, and the notice after it says how to get back.
describe("vimma_show's question and notice (mcp-drive D2-D6)", () => {
  const show = { ...keys, tool: "vimma_show", what: { ...keys.what, keys: undefined } };
  const none = { count: "" };

  test("it names the tab it would show, and offers only y and n", () => {
    const line = questionLine(show, { grantMinutes: 15 });
    expect(text(line)).toBe(
      '◇ claude-code wants vimma_show: 2 "Pricing · Example" example.com/pricing ' +
        '(switches you to "agent")',
    );
    expect(line.hint).toBe("y show it · n deny");
    expect(line.label).toBe(text(line));
    const named = questionLine(show, { grantMinutes: 15, agentWorkspace: "bots" });
    expect(text(named)).toMatch(/\(switches you to "bots"\)$/);
    expect(named.parts.find((p) => p.text === "bots")?.isolate).toBe("auto");
  });

  test("no grant: a, counts and x do not grant or mute", () => {
    expect(noGrant(show)).toBe(true);
    expect(noGrant(keys)).toBe(false);
    expect(noGrant(read)).toBe(false);
    const p = { noGrant: noGrant(show) };
    expect(promptKey(none, "y", p)).toEqual({ kind: "answer", answer: { kind: "once" } });
    expect(promptKey(none, "a", p)).toEqual({ kind: "ignore" });
    expect(promptKey(none, "1", p)).toEqual({ kind: "ignore" });
    expect(promptKey(none, "x", p)).toEqual({ kind: "answer", answer: { kind: "deny" } });
  });

  test("the notice after the switch says ctrl+^ goes back, and names another window", () => {
    expect(shownNotice(show, { otherWindow: false })).toBe(
      "showing claude-code's tab · ctrl+^ goes back",
    );
    expect(shownNotice(show, { otherWindow: true })).toBe(
      "showing claude-code's tab, shown in the other window · ctrl+^ there goes back",
    );
    expect(shownNotice({ ...show, label: null }, { otherWindow: false })).toBe(
      "showing an agent's tab · ctrl+^ goes back",
    );
    // Already on the agent workspace: a plain tab selection, so ctrl+^ would not go back.
    expect(shownNotice(show, { otherWindow: false, switched: false })).toBe(
      "showing claude-code's tab",
    );
  });

  test("the desktop notification names no title or URL", () => {
    expect(agentAlertText(show)).toBe(
      "claude-code asks to use Vimma's agent workspace (show you a page)",
    );
  });
});

describe(":mcp log of a show that failed after the yes (mcp-drive D14)", () => {
  test("it reads as failed, not as allowed", () => {
    const e = {
      at: 0,
      client: "claude-code",
      tool: "vimma_show",
      title: "A",
      detail: "",
      outcome: "failed",
    };
    expect(logRow(e)).toMatch(/ · failed$/);
  });
});
