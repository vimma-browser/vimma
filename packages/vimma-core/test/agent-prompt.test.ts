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
  checkpointNotice,
  checkpointText,
  isCheckpoint,
  agentState,
  clientName,
  controlOnQuestion,
  controlStatus,
  deniedNotice,
  grantNotice,
  mayOpenByItself,
  noGrant,
  PAGE_CLIENT,
  parseControlCommand,
  promptKey,
  questionLine,
  logRow,
  fillFits,
  ranNotice,
  shownNotice,
  stepText,
} from "../src/agent/agent-prompt.mjs";
import { textWidth } from "../src/text/textwidth.mjs";
import type { LogEntry } from "../src/agent/agent.mjs";

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
const text = (line: { parts: { text: string }[] }) => line.parts.map((p) => p.text).join("");

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
    expect(line.hint).toBe("y once · 15a 15 min · n deny · x mute");
    expect(line.label).toBe(text(line));
  });

  // docs/specs/mcp-session-grants.md S1: with grant_minutes 0, the default, a bare a lasts the
  // whole connection, and the hint says so.
  test("with grant_minutes 0 the hint says a lasts until the agent quits", () => {
    expect(questionLine(read, { grantMinutes: 0 }).hint).toBe(
      "y once · a until it quits · n deny · x mute",
    );
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
    expect(line.hint).toBe("y once · 15a 15 min · n deny · x mute");
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
    const iso = (line: any) =>
      line.parts.filter((p: any) => p.isolate).map((p: any) => [p.text, p.isolate]);
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
    const shown = /"(.*)"/.exec(text(line))?.[1] as string;
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

  test("every bidi control leaves a label, the Arabic letter mark among them", () => {
    expect(clientName({ client: "a\u061cb\u200ec\u2067d" })).toBe("a b c d");
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
      s = { count: (r as { count: string }).count };
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
  test("a grant names the waiting calls it let run, which the user did not see asked", () => {
    expect(grantNotice(read, { minutes: 15, capped: false }, 2)).toBe(
      "example-agent may use the agent workspace for 15 min; paying and sending text or personal " +
        "details still ask (ctrl+b shift+a ends it) · it also ran 2 waiting calls (:mcp log)",
    );
    expect(grantNotice(read, { minutes: 15, capped: false }, 1)).toMatch(
      / · it also ran 1 waiting call \(:mcp log\)$/,
    );
  });

  test("a grant names its scope, its length, the cap, and the key that ends it", () => {
    expect(grantNotice(read, { minutes: 15, capped: false })).toBe(
      "example-agent may use the agent workspace for 15 min; paying and sending text or personal " +
        "details still ask (ctrl+b shift+a ends it)",
    );
    expect(grantNotice(read, { minutes: 480, capped: true })).toBe(
      "example-agent may use the agent workspace for 480 min, the most [mcp] grant_max_minutes " +
        "allows; paying and sending text or personal details still ask (ctrl+b shift+a ends it)",
    );
  });

  test("a grant for the whole connection says it lasts until the agent quits", () => {
    expect(grantNotice(read, { minutes: Infinity, capped: false })).toBe(
      "example-agent may use the agent workspace until it quits; paying and sending text or " +
        "personal details still ask (ctrl+b shift+a ends it)",
    );
  });

  test("a call under a grant for the whole connection names no time left", () => {
    expect(ranNotice(open, Infinity, 0)).toBe("example-agent opened docs.rs (grant)");
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

  // docs/specs/mcp-forms.md F22, F28: vimma_console asks with the tab, and its notice names it.
  test("vimma_console: the tab in the question, the page in the notice", () => {
    const read = { ...keys, tool: "vimma_console", what: { ...keys.what, keys: undefined } };
    expect(text(questionLine(read, { grantMinutes: 10 }))).toBe(
      '◇ claude-code wants vimma_console: 2 "Pricing · Example" example.com/pricing',
    );
    expect(ranNotice(read, 12 * MIN, 0)).toBe(
      'claude-code read the errors of "Pricing · Example" (grant, 12m left)',
    );
    expect(agentAlertText(read)).toBe(
      "claude-code asks to use Vimma's agent workspace (read a page's errors and failed requests)",
    );
  });

  // docs/specs/mcp-forms.md F18, F28: vimma_screenshot asks with the tab, and its notice names it.
  test("vimma_screenshot: the tab in the question, the page in the notice", () => {
    const shot = { ...keys, tool: "vimma_screenshot", what: { ...keys.what, keys: undefined } };
    expect(text(questionLine(shot, { grantMinutes: 10 }))).toBe(
      '◇ claude-code wants vimma_screenshot: 2 "Pricing · Example" example.com/pricing',
    );
    expect(ranNotice(shot, 12 * MIN, 0)).toBe(
      'claude-code took a screenshot of "Pricing · Example" (grant, 12m left)',
    );
    expect(agentAlertText(shot)).toBe(
      "claude-code asks to use Vimma's agent workspace (take a screenshot of a page)",
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

  // Issue #584: a step that also returns the page's element list says so in its question and
  // its notice, since a yes to it is a yes to vimma_elements on the page it leaves.
  test("a step that returns the element list says so in the question and the notice", () => {
    const what = {
      tab: "7",
      index: 2,
      title: "List · Example",
      url: "https://example.com/list",
      label: "sg",
      kind: "button",
      text: "Add to list",
      elements: true,
    };
    const activate = { tool: "vimma_activate", label: { client: "claude-code" }, what };
    expect(text(questionLine(activate, { grantMinutes: 10 }))).toBe(
      '◇ claude-code wants vimma_activate: 2 "List · Example" example.com/list  sg button "Add to list", then vimma_elements',
    );
    expect(ranNotice(activate, 12 * MIN, 0)).toBe(
      'claude-code clicked button "Add to list" in "List · Example" and listed the buttons and fields after it (grant, 12m left)',
    );
    const opened = { ...open, what: { ...open.what, elements: true } };
    expect(text(questionLine(opened, { grantMinutes: 10 }))).toMatch(/, then vimma_elements$/);
    expect(ranNotice(opened, Infinity, 0)).toBe(
      "example-agent opened docs.rs and listed the buttons and fields after it (grant)",
    );
    const plain = { ...activate, what: { ...what, elements: false } };
    expect(text(questionLine(plain, { grantMinutes: 10 }))).not.toMatch(/vimma_elements/);
    // A checkpoint's question names the list too: its yes returns it.
    const submit = {
      ...activate,
      what: {
        ...what,
        submit: { method: "post", action: "https://example.com/a", host: "example.com", fields: 1 },
      },
    };
    const asked = questionLine(submit, { grantMinutes: 10 });
    expect(asked.hint).toBe("y send it · n stop");
    expect(text(asked)).toMatch(/, then vimma_elements$/);
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
    // Without the fields the child read (it did not answer), the question counts them.
    const line = questionLine(submit, { grantMinutes: 10 });
    expect(text(line)).toBe(
      '▲ claude-code wants to send a form: 2 "Sign up · Example" → POST example.com/api/signup (3 fields)',
    );
    expect(line.parts.filter((p) => p.strong).map((p) => p.text)).toEqual(["POST", "example.com"]);
    expect(line.hint).toBe("y send it · n stop");
    expect(noGrant(submit)).toBe(true);
    expect(promptKey({ count: "" }, "a", { noGrant: noGrant(submit) })).toEqual({ kind: "ignore" });
    expect(agentAlertText(submit)).toBe("claude-code asks to send a form");
    const one = {
      ...submit,
      what: { ...submit.what, submit: { ...submit.what.submit, fields: 1 } },
    };
    expect(text(questionLine(one, { grantMinutes: 10 }))).toMatch(/\(1 field\)$/);
  });

  // docs/specs/mcp-checkpoints.md Behaviour 2-4, 6-7, C2, C3, C7: a checkpoint stands out
  // (▲ and the warning colour on its glyph and verb), shows the content of its step and is
  // answered with y or n only.
  const signup = {
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
        fields: 6,
      },
      sent: {
        fields: [
          { name: "email", value: "a@example.com" },
          { name: "name", value: "Ada" },
          { name: "password", secret: true },
          { name: "cv", file: true },
        ],
        hidden: 2,
        more: 0,
      },
    },
  };

  test("a form checkpoint lists the fields it sends, sensitive ones as •••", () => {
    const line = questionLine(signup, { grantMinutes: 10 });
    expect(text(line)).toBe(
      '▲ claude-code wants to send a form: 2 "Sign up · Example" → POST example.com/api/signup' +
        '  email "a@example.com", name "Ada", password •••, cv (file), + 2 hidden',
    );
    expect(line.parts.filter((p) => p.warn).map((p) => p.text)).toEqual([
      "▲",
      "wants to send a form",
    ]);
    // The page's names and the values are their own bidi runs (security.md M4).
    expect(line.parts.find((p) => p.text === "a@example.com")?.isolate).toBe("auto");
    expect(line.parts.find((p) => p.text === "email")?.isolate).toBe("auto");
    expect(line.hint).toBe("y send it · n stop");
    expect(line.label).toBe(text(line));
  });

  test("a form checkpoint names an entry it did not read, and says when the page adds", () => {
    const what = {
      ...signup.what,
      sent: {
        fields: [
          { name: "qty", value: "1" },
          { name: "note", opaque: true },
          { name: "doc", file: true, opaque: true },
        ],
        hidden: 1,
        more: 0,
        unread: true,
      },
    };
    expect(text(questionLine({ ...signup, what }, { grantMinutes: 10 }))).toBe(
      '▲ claude-code wants to send a form: 2 "Sign up · Example" → POST example.com/api/signup' +
        '  qty "1", note (not read), doc (file), + 1 hidden, + what the page adds',
    );
    const bare = { ...signup.what, sent: { fields: [], hidden: 0, more: 0, unread: true } };
    expect(text(questionLine({ ...signup, what: bare }, { grantMinutes: 10 }))).toContain(
      "example.com/api/signup  + what the page adds",
    );
  });

  test("a form checkpoint cleans the page's names and values and cuts them to fit", () => {
    const what = {
      ...signup.what,
      sent: {
        fields: [
          { name: "bio‮", value: `${"x".repeat(100)}\n` },
          ...Array.from({ length: 30 }, (_, i) => ({ name: `f${i}`, value: "v" })),
        ],
        hidden: 0,
        more: 3,
      },
    };
    const line = text(questionLine({ ...signup, what }, { grantMinutes: 10 }));
    expect(line).toContain(`  bio "${"x".repeat(39)}…", f0 "v"`);
    expect(line).not.toContain("‮");
    // Cut where the line ends, and the fields past the child's cap are counted too.
    expect(line).toMatch(/, … \(\d+ more\)$/);
    const more = Number(/\((\d+) more\)$/.exec(line)?.[1]);
    expect(more).toBeGreaterThan(3);
    const fields = line.slice(line.indexOf("  bio"));
    expect(textWidth(fields)).toBeLessThanOrEqual(175);
  });

  const pay = {
    tool: "vimma_activate",
    label: { client: "claude-code" },
    what: {
      tab: "7",
      index: 2,
      title: "Checkout · Shop",
      url: "https://shop.example/checkout",
      label: "sg",
      kind: "button",
      text: "Confirm order",
      pay: { text: "Confirm order", site: "shop.example", total: "Total 42,90 €" },
    },
  };

  test("a payment checkpoint names the button, site and stated amount", () => {
    const line = questionLine(pay, { grantMinutes: 10 });
    expect(text(line)).toBe(
      '▲ claude-code wants to pay: "Confirm order" on shop.example · the page says "Total 42,90 €"',
    );
    expect(line.parts.filter((p) => p.warn).map((p) => p.text)).toEqual(["▲", "wants to pay"]);
    expect(line.parts.filter((p) => p.strong).map((p) => p.text)).toEqual(["shop.example"]);
    expect(line.parts.find((p) => p.text === "Total 42,90 €")?.isolate).toBe("auto");
    expect(line.parts.find((p) => p.text === "Confirm order")?.isolate).toBe("auto");
    expect(line.hint).toBe("y pay · n stop");
    expect(noGrant(pay)).toBe(true);
    expect(agentAlertText(pay)).toBe("claude-code asks to pay");
    // No total on the page: none is quoted.
    const bare = { ...pay, what: { ...pay.what, pay: { text: "Pay", site: "shop.example" } } };
    expect(text(questionLine(bare, { grantMinutes: 10 }))).toBe(
      '▲ claude-code wants to pay: "Pay" on shop.example',
    );
    // A key step has no button: the keys stand in for it.
    const keyed = {
      ...keys,
      what: { ...keys.what, keys: "H", pay: { text: "", site: "shop.example", keys: "H" } },
    };
    expect(text(questionLine(keyed, { grantMinutes: 10 }))).toBe(
      "▲ claude-code wants to pay: keys H on shop.example",
    );
    // A follow names its link, and the call's keys follow, so none runs unseen.
    const followed = {
      ...keys,
      what: { ...keys.what, keys: "3j fsd", pay: { text: "Maksa nyt", site: "shop.example" } },
    };
    expect(text(questionLine(followed, { grantMinutes: 10 }))).toBe(
      '▲ claude-code wants to pay: "Maksa nyt" on shop.example  keys: 3j fsd',
    );
  });

  // A hosted payment frame takes the money: its site is named, and the tab's after it.
  test("a pay button in a frame of another site names that site, then the tab's", () => {
    const framed = {
      ...pay,
      what: {
        ...pay.what,
        pay: { text: "Pay 42,90 €", site: "pay.provider.example", top: "shop.example" },
      },
    };
    const line = questionLine(framed, { grantMinutes: 10 });
    expect(text(line)).toBe(
      '▲ claude-code wants to pay: "Pay 42,90 €" on pay.provider.example (in shop.example)',
    );
    expect(line.parts.filter((p) => p.strong).map((p) => p.text)).toEqual(["pay.provider.example"]);
    expect(line.parts.find((p) => p.text === "shop.example")?.isolate).toBe("ltr");
    expect(checkpointNotice(framed)).toBe(
      "allowed payment on pay.provider.example (in shop.example)",
    );
    expect(deniedNotice(framed, "user")).toBe(
      "stopped claude-code's payment on pay.provider.example (in shop.example)",
    );
  });

  test("a payment that also sends a form: the payment wording, then the fields", () => {
    const both = {
      ...pay,
      what: { ...pay.what, submit: signup.what.submit, sent: signup.what.sent },
    };
    expect(text(questionLine(both, { grantMinutes: 10 }))).toBe(
      '▲ claude-code wants to pay: "Confirm order" on shop.example · the page says "Total 42,90 €"' +
        ' → POST example.com/api/signup  email "a@example.com", name "Ada", password •••, cv (file), + 2 hidden',
    );
    expect(questionLine(both, { grantMinutes: 10 }).hint).toBe("y pay · n stop");
    expect(agentAlertText(both)).toBe("claude-code asks to pay");
  });

  test("a checkpoint offers y and n only, and x is a plain no", () => {
    for (const q of [pay, signup]) {
      const plain = { noGrant: noGrant(q) };
      expect(promptKey({ count: "" }, "y", plain)).toEqual({
        kind: "answer",
        answer: { kind: "once" },
      });
      expect(promptKey({ count: "" }, "x", plain)).toEqual({
        kind: "answer",
        answer: { kind: "deny" },
      });
      expect(promptKey({ count: "" }, "a", plain)).toEqual({ kind: "ignore" });
      expect(promptKey({ count: "" }, "5", plain)).toEqual({ kind: "ignore" });
      for (const key of ["n", "esc", "enter"]) {
        expect(promptKey({ count: "" }, key, plain)).toEqual({
          kind: "answer",
          answer: { kind: "deny" },
        });
      }
    }
  });

  test("a checkpoint's yes and no say what happened to the step", () => {
    expect(isCheckpoint(pay)).toBe(true);
    expect(isCheckpoint(signup)).toBe(true);
    expect(isCheckpoint(read)).toBe(false);
    expect(checkpointNotice(pay)).toBe("allowed payment on shop.example");
    expect(checkpointNotice(signup)).toBe("allowed sending the form to example.com");
    expect(deniedNotice(pay, "user")).toBe("stopped claude-code's payment on shop.example");
    expect(deniedNotice(signup, "user")).toBe("stopped claude-code's form to example.com");
  });

  // docs/specs/mcp-forms.md F14, F28: vimma_fill asks with the tab and each field's label, name
  // and value, cut with … to fit; a fill that submits asks with the form's destination too and
  // offers no grant (F15).
  test("vimma_fill: each field and value in the question, how many in the notice", () => {
    const fill = {
      tool: "vimma_fill",
      label: { client: "claude-code" },
      what: {
        tab: "7",
        index: 2,
        title: "Sign up · Example",
        url: "https://example.com/signup",
        fields: [{ label: "sd", name: "Email", value: "ada@example.com" }],
      },
    };
    const line = questionLine(fill, { grantMinutes: 10 });
    expect(text(line)).toBe(
      '◇ claude-code wants vimma_fill: 2 "Sign up · Example" example.com/signup  sd Email = "ada@example.com"',
    );
    // The agent's values and the page's names are their own bidi runs (security.md M4).
    expect(line.parts.find((p) => p.text === "ada@example.com")?.isolate).toBe("auto");
    expect(noGrant(fill)).toBe(false);
    expect(ranNotice(fill, 12 * MIN, 0)).toBe(
      'claude-code filled 1 field in "Sign up · Example" (grant, 12m left)',
    );
    expect(agentAlertText(fill)).toBe(
      "claude-code asks to use Vimma's agent workspace (fill in a form)",
    );
    const three = {
      ...fill,
      what: {
        ...fill.what,
        fields: [
          { label: "sd", name: "Email", value: "x".repeat(100) },
          { label: "sf", name: "", value: "two\nlines" },
          { label: "sg", name: "Remember me", value: true },
        ],
      },
    };
    expect(text(questionLine(three, { grantMinutes: 10 }))).toBe(
      '◇ claude-code wants vimma_fill: 2 "Sign up · Example" example.com/signup  3 fields: ' +
        `sd Email = "${"x".repeat(39)}…", sf = "two lines", sg Remember me = checked`,
    );
    expect(ranNotice(three, 12 * MIN, 0)).toBe(
      'claude-code filled 3 fields in "Sign up · Example" (grant, 12m left)',
    );
    // Thirty-two fields still fit one line: the list is cut with …, and :mcp log has it all.
    const many = {
      ...fill,
      what: {
        ...fill.what,
        fields: Array.from({ length: 32 }, (_, i) => ({ label: "sd", name: `F${i}`, value: "v" })),
      },
    };
    const cut = text(questionLine(many, { grantMinutes: 10 }));
    expect(cut).toMatch(/ {2}32 fields: sd F0 = "v", .*, … \(\d+ more\)$/);
    expect(fillFits(many.what)).toBe(false);
    expect(fillFits(three.what)).toBe(false);
    expect(fillFits(fill.what)).toBe(true);
    expect(textWidth(cut.slice(cut.indexOf("32 fields: ")))).toBeLessThanOrEqual(185);
  });

  test("a fill that submits: the destination, then the fields, y or n only", () => {
    const submit = {
      tool: "vimma_fill",
      label: { client: "claude-code" },
      what: {
        tab: "7",
        index: 2,
        title: "Sign up · Example",
        url: "https://example.com/signup",
        fields: [{ label: "sd", name: "Email", value: "ada@example.com" }],
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
      '▲ claude-code wants to send a form: 2 "Sign up · Example" → POST example.com/api/signup (3 fields)  after filling 1 field: sd Email = "ada@example.com"',
    );
    expect(line.parts.filter((p) => p.strong).map((p) => p.text)).toEqual(["POST", "example.com"]);
    expect(line.hint).toBe("y send it · n stop");
    expect(noGrant(submit)).toBe(true);
    expect(agentAlertText(submit)).toBe("claude-code asks to send a form");
    // Behaviour 4: what else the form sends follows what the fill puts in.
    const sent = {
      ...submit,
      what: {
        ...submit.what,
        sent: {
          fields: [
            { name: "plan", value: "pro" },
            { name: "pin", secret: true },
          ],
          hidden: 1,
          more: 0,
        },
      },
    };
    expect(text(questionLine(sent, { grantMinutes: 10 }))).toBe(
      '▲ claude-code wants to send a form: 2 "Sign up · Example" → POST example.com/api/signup  after filling 1 field: sd Email = "ada@example.com"  also plan "pro", pin •••, + 1 hidden',
    );
    const only = { ...sent, what: { ...sent.what, sent: { fields: [], hidden: 0, more: 0 } } };
    expect(text(questionLine(only, { grantMinutes: 10 }))).toBe(
      '▲ claude-code wants to send a form: 2 "Sign up · Example" → POST example.com/api/signup  after filling 1 field: sd Email = "ada@example.com"',
    );
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
    expect(agentState({ ...base, grants: [{ until: Infinity }] })?.minutes).toBe(Infinity);
    expect(agentState({ ...base, ranAt: 0, now: 1999 })?.ran).toBe(true);
    expect(agentState({ ...base, ranAt: 0, now: 2000 })?.ran).toBe(false);
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
    expect(line.hint).toBe("y once · 10a 10 min · n deny · x mute");
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
    const e: LogEntry = {
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

// docs/specs/mcp-consequence.md Behaviour 1, 4, 5: under a grant, a form checkpoint that may be
// allowed offers `a` for that button on that site; a payment never does.
describe("a form allowed for the grant (mcp-consequence K5)", () => {
  const form = {
    tool: "vimma_activate",
    label: { client: "claude-code" },
    what: {
      tab: "7",
      index: 2,
      title: "Kori · Kauppa",
      url: "https://shop.example/kori",
      label: "ad",
      kind: "button",
      text: "Lisää koriin",
      submit: {
        method: "post",
        action: "https://shop.example/cart",
        host: "shop.example",
        fields: 2,
      },
      sent: { fields: [{ name: "zip", value: "00100" }], hidden: 1, more: 0 },
      here: { site: "shop.example", key: "k" },
    },
  };

  test("a form checkpoint under a grant offers a", () => {
    expect(questionLine(form, { grantMinutes: 0 }).hint).toBe("y send it · a always here · n stop");
    expect(promptKey({ count: "" }, "a", { noGrant: true, here: true })).toEqual({
      kind: "answer",
      answer: { kind: "here" },
    });
    // A count before it means nothing: the allowance lasts as the grant does.
    expect(promptKey({ count: "15" }, "a", { noGrant: true, here: true })).toEqual({
      kind: "answer",
      answer: { kind: "here" },
    });
    expect(promptKey({ count: "" }, "5", { noGrant: true, here: true })).toEqual({
      kind: "ignore",
    });
  });

  test("a payment checkpoint never offers a", () => {
    const pay = { ...form, what: { ...form.what, pay: { text: "Osta", site: "shop.example" } } };
    expect(questionLine(pay, { grantMinutes: 0 }).hint).toBe("y pay · n stop");
    const plain = { ...form, what: { ...form.what, here: undefined } };
    expect(questionLine(plain, { grantMinutes: 0 }).hint).toBe("y send it · n stop");
    expect(promptKey({ count: "" }, "a", { noGrant: true })).toEqual({ kind: "ignore" });
  });

  test("the allowance's notice and log outcome", () => {
    expect(checkpointNotice(form, true)).toBe(
      'allowed "Lisää koriin" on shop.example for this grant',
    );
    expect(checkpointNotice(form)).toBe("allowed sending the form to shop.example");
    // A queue's entry, its connection included: the row leaves it out.
    const entry = {
      at: 0,
      conn: 1,
      client: "claude-code",
      tool: "vimma_activate",
      title: "Kori",
      detail: "ad",
      outcome: "checkpoint-here" as const,
    };
    const row = logRow(entry);
    expect(row).toMatch(/allowed \(checkpoint, for the grant\)$/);
  });

  test("a form run under a grant names where it went", () => {
    const { here, ...rest } = form.what;
    void here;
    expect(ranNotice({ ...form, what: rest }, Infinity, 0)).toBe(
      'claude-code clicked button "Lisää koriin" in "Kori · Kauppa" and sent the form to POST shop.example (grant)',
    );
  });
});

// Issue #1119: edges the weekly mutation run found unpinned.
describe("the question line's edges (mutation-tested)", () => {
  type Line = { parts: unknown[] };
  /** Every part of a line is an object with its text, nothing spread into it by mistake. */
  const wellFormed = (line: Line) =>
    line.parts.every(
      (p) =>
        typeof p === "object" && p !== null && typeof (p as { text: unknown }).text === "string",
    );

  test("spaces left around a control character become one", () => {
    expect(clientName({ client: "a \u0007 b" })).toBe("a b");
    expect(clientName({ client: "\u202E  b  " })).toBe("b");
  });

  test("a tab without a place in the workspace is named by its title alone", () => {
    const { index, ...what } = read.what;
    void index;
    expect(text(questionLine({ ...read, what }, { grantMinutes: 15 }))).toBe(
      '◇ example-agent wants vimma_read_page: "Pull requests · vimma-browser/vimma" ' +
        "github.com/vimma-browser/vimma/pulls",
    );
  });

  test("an open with no host, or a host not in its URL, bolds nothing", () => {
    for (const host of [undefined, "", "example.org"]) {
      const line = questionLine({ ...open, what: { ...open.what, host } }, { grantMinutes: 10 });
      expect(line.parts.slice(-1)).toEqual([
        { text: "https://docs.rs/serde/latest/serde/", isolate: "ltr" },
      ]);
      expect(line.parts.filter((p) => p.strong)).toEqual([]);
    }
    // A URL that ends with its host has no empty part after it.
    const bare = questionLine(
      { ...open, what: { url: "https://docs.rs", host: "docs.rs" } },
      { grantMinutes: 10 },
    );
    expect(bare.parts.slice(-2)).toEqual([
      { text: "https://", isolate: "ltr" },
      { text: "docs.rs", strong: true, isolate: "ltr" },
    ]);
  });

  test("a download without a size, a type or an extension says so; with one, its extension", () => {
    const download = { tool: "vimma_download", label, what: { name: "blob", host: "example.com" } };
    expect(text(questionLine(download, { grantMinutes: 10 }))).toBe(
      '◇ example-agent wants vimma_download: "blob" unknown size unknown type from example.com',
    );
    const typed = {
      ...download,
      what: { ...download.what, size: 0, type: "text/csv", ext: "csv" },
    };
    expect(text(questionLine(typed, { grantMinutes: 10 }))).toBe(
      '◇ example-agent wants vimma_download: "blob" 0 B text/csv (.csv) from example.com',
    );
  });

  test("only a download can be a page's own; a question without a label or details is no checkpoint", () => {
    const pageLabel = { client: PAGE_CLIENT };
    expect(noGrant({ tool: "vimma_read_page", label: pageLabel, what: {} })).toBe(false);
    expect(noGrant({ tool: "vimma_download", label: pageLabel, what: {} })).toBe(true);
    const bare = { tool: "vimma_download", label: null } as unknown as Parameters<
      typeof noGrant
    >[0];
    expect(noGrant(bare)).toBe(false);
    expect(isCheckpoint(bare)).toBe(false);
    expect(questionLine(bare, { grantMinutes: 10 }).hint).toBe(
      "y once · 10a 10 min · n deny · x mute",
    );
  });

  test("an activation names the element's label, kind and text in quotes", () => {
    const click = {
      tool: "vimma_activate",
      label,
      what: { ...read.what, label: "sd", kind: "button", text: "Merge" },
    };
    expect(text(questionLine(click, { grantMinutes: 10 }))).toBe(
      '◇ example-agent wants vimma_activate: 2 "Pull requests · vimma-browser/vimma" ' +
        'github.com/vimma-browser/vimma/pulls  sd button "Merge"',
    );
  });

  test("a form checkpoint: fields past the cap, hidden ones, nothing to say", () => {
    const form = (sent: unknown) => ({
      tool: "vimma_activate",
      label,
      what: {
        title: "Shop",
        submit: { method: "post", action: "https://shop.example/cart", host: "shop.example" },
        sent,
      },
    });
    const ask = (sent: unknown) => questionLine(form(sent), { grantMinutes: 10 });
    const head = '▲ example-agent wants to send a form: "Shop" → POST shop.example/cart';
    expect(text(ask({ fields: [], hidden: 0, more: 3 }))).toBe(`${head}  … (3 more)`);
    expect(text(ask({ hidden: 2 }))).toBe(`${head}  + 2 hidden`);
    expect(text(ask({ fields: [], hidden: 0, more: 0 }))).toBe(head);
    for (const sent of [
      { fields: [], hidden: 0, more: 0 },
      { fields: [{ name: "a", value: "1" }, { name: "b" }], hidden: 0, more: 0 },
    ]) {
      expect(wellFormed(ask(sent)), JSON.stringify(sent)).toBe(true);
    }
    // A field without a name or a value is shown empty, never "undefined".
    expect(text(ask({ fields: [{}, null], hidden: 0, more: 0 }))).toBe(`${head}   "",  ""`);
    // The field count without a list of what is sent.
    const counted = questionLine(
      {
        ...form(undefined),
        what: { ...form(undefined).what, submit: { ...form(undefined).what.submit, fields: 2 } },
      },
      { grantMinutes: 10 },
    );
    expect(text(counted)).toBe(`${head} (2 fields)`);
    expect(wellFormed(counted)).toBe(true);
  });

  test("a form checkpoint's fields fill 160 columns exactly; past them, the rest are counted", () => {
    // Each field is 40 columns wide: `n "…"` and the ", " before all but the first.
    const field = (i: number) => ({ name: "n", value: "v".repeat(i ? 34 : 36) });
    const ask = (n: number, rest: object = {}) =>
      text(
        questionLine(
          {
            tool: "vimma_activate",
            label,
            what: {
              title: "Shop",
              submit: { method: "post", action: "https://shop.example/cart", host: "shop.example" },
              sent: {
                fields: Array.from({ length: n }, (_, i) => field(i)),
                hidden: 0,
                more: 0,
                ...rest,
              },
            },
          },
          { grantMinutes: 10 },
        ),
      );
    expect(ask(4)).toMatch(/v" *$/);
    expect(ask(4)).not.toContain("more");
    expect(ask(5)).toMatch(/v", … \(1 more\)$/);
    expect(ask(6, { more: 2, hidden: 1 })).toMatch(/v", … \(4 more\), \+ 1 hidden$/);
  });

  test("a fill's fields fill 160 columns exactly, and fit whole; past them, or cut, they do not", () => {
    // Each field is 40 columns wide: `a n = "…"` and the ", " before all but the first.
    const field = (i: number) => ({ label: "a", name: "n", value: "v".repeat(i ? 30 : 32) });
    const what = (n: number) => ({
      ...read.what,
      fields: Array.from({ length: n }, (_, i) => field(i)),
    });
    const ask = (n: number) =>
      questionLine({ tool: "vimma_fill", label, what: what(n) }, { grantMinutes: 10 });
    expect(text(ask(4))).toMatch(/v"$/);
    expect(fillFits(what(4))).toBe(true);
    expect(text(ask(5))).toMatch(/v", … \(1 more\)$/);
    expect(fillFits(what(5))).toBe(false);
    expect(fillFits({ fields: [{ label: "a", name: "n", value: "v".repeat(41) }] })).toBe(false);
    expect(fillFits({ fields: [{ label: "a", name: "n".repeat(25), value: "v" }] })).toBe(false);
    expect(
      fillFits({ fields: [{ label: "a", name: "n".repeat(24), value: "v".repeat(40) }] }),
    ).toBe(true);
  });

  test("a fill: no fields, a field that is null, an unchecked box, a long name cut at its end", () => {
    const ask = (fields: unknown) =>
      questionLine(
        { tool: "vimma_fill", label, what: { ...read.what, fields } },
        { grantMinutes: 10 },
      );
    const tab =
      '◇ example-agent wants vimma_fill: 2 "Pull requests · vimma-browser/vimma" github.com/vimma-browser/vimma/pulls';
    expect(text(ask(undefined))).toBe(`${tab}  0 fields: `);
    expect(text(ask([null]))).toBe(`${tab}   = ""`);
    expect(text(ask([{ label: "a", name: "agree", value: false }]))).toBe(
      `${tab}  a agree = unchecked`,
    );
    expect(text(ask([{ label: "a", name: `${"n".repeat(30)}`, value: "v" }]))).toBe(
      `${tab}  a ${"n".repeat(23)}… = "v"`,
    );
    // A first field wider than the line is counted, with nothing before it.
    expect(text(ask([{ label: "x".repeat(200), name: "n", value: "v" }]))).toBe(
      `${tab}  … (1 more)`,
    );
    // No part of a field is empty text.
    const parts = ask([{ label: "", name: "", value: "" }]).parts;
    expect(
      parts
        .slice(parts.findIndex((p) => p.text === "github.com/vimma-browser/vimma/pulls") + 1)
        .every((p) => p.text),
    ).toBe(true);
  });

  test("a step whose payment detail is not an object asks as a form", () => {
    const q = { tool: "vimma_activate", label, what: { title: "Shop", pay: true } };
    expect(text(questionLine(q, { grantMinutes: 10 }))).toBe(
      '▲ example-agent wants to send a form: "Shop"',
    );
    expect(questionLine(q, { grantMinutes: 10 }).hint).toBe("y send it · n stop");
  });

  test("the keys: N denies, shift+y allows, only a lone digit counts, backspace needs one", () => {
    const none = { count: "" };
    expect(promptKey(none, "N")).toEqual({ kind: "answer", answer: { kind: "deny" } });
    expect(promptKey(none, "shift+y")).toEqual({ kind: "answer", answer: { kind: "once" } });
    expect(promptKey(none, "5x")).toEqual({ kind: "ignore" });
    expect(promptKey(none, "backspace")).toEqual({ kind: "ignore" });
    expect(promptKey({ count: "12" }, "q")).toEqual({ kind: "ignore" });
    expect(promptKey({ count: "123" }, "backspace")).toEqual({ kind: "count", count: "12" });
  });

  test("the time left counts from now, not from the epoch", () => {
    const now = 1_800_000_000_000;
    expect(ranNotice(read, now + 5 * MIN, now)).toBe(
      'example-agent read "Pull requests · vimma-browser/vimma" (grant, 5m left)',
    );
    expect(controlStatus({ enabled: true, until: now + 5 * MIN, now })).toBe(
      "full control on, 5m left",
    );
    const base = { connections: 1, waiting: 0, ranAt: null, now };
    expect(agentState({ ...base, grants: [{ until: now + 5 * MIN }] })?.minutes).toBe(5);
    expect(agentState({ ...base, grants: [], ranAt: now - 1000 })?.ran).toBe(true);
    expect(agentState({ ...base, grants: [], ranAt: now - 3000 })?.ran).toBe(false);
  });

  test(":control: no text is the status; on takes one minute up; one word more refuses", () => {
    expect(parseControlCommand(undefined)).toEqual({ kind: "status" });
    expect(parseControlCommand("ON 1")).toEqual({ kind: "on", minutes: 1 });
    for (const t of ["off now", "on 15 more", "15 on", "of"]) {
      expect(parseControlCommand(t), t).toEqual({
        kind: "refuse",
        text: `:control takes on <minutes> (1 to ${CONTROL_MAX_MINUTES}) or off`,
      });
    }
  });

  test(":control's end time: digits alone, nothing around them", () => {
    const now = 1_800_000_000_000;
    const at = now + 15 * MIN;
    expect(controlEnd(` ${at}`, now)).toEqual({ kind: "off" });
    expect(controlEnd(`${at}\n`, now)).toEqual({ kind: "off" });
    expect(controlEnd(`0x${at.toString(16)}`, now)).toEqual({ kind: "off" });
  });
});

describe("notices, the transcript and :mcp log, at their edges (mutation-tested)", () => {
  test("full control shows a code only when it is a string of the code's own characters", () => {
    const ask = (code: unknown) =>
      text(questionLine({ ...full, what: { code } }, { grantMinutes: 10 }));
    expect(ask("K7Q2")).toMatch(/^◇ vimma-ctl with code K7Q2 wants full control/);
    for (const code of [2345, "ABIO", "K7Q", "K7Q22", ["K7Q2"]]) {
      expect(ask(code), String(code)).toMatch(/^◇ a client with no code wants full control/);
    }
  });

  test(":control on takes plain digits only", () => {
    for (const t of ["on 1e3", "on 0x10", "on +5"]) {
      expect(parseControlCommand(t).kind, t).toBe("refuse");
    }
  });

  test("a step of a tool with no words of its own is named by the tool", () => {
    expect(stepText({ tool: "vimma_future", what: {} })).toBe("used vimma_future");
    expect(stepText({ tool: "vimma_keys", what: { keys: "3j", title: "T" } })).toBe(
      'pressed 3j in "T"',
    );
    // A click whose submit detail is not an object names no form.
    expect(
      stepText({
        tool: "vimma_activate",
        what: { kind: "button", text: "Go", title: "T", submit: true },
      }),
    ).toBe('clicked button "Go" in "T"');
  });

  test("a checkpoint in the transcript: a payment without a total, a form without a host", () => {
    expect(checkpointText({ what: { pay: { site: "shop.example" } } })).toBe(
      "▲ asked to pay on shop.example",
    );
    const long = `Total 42,90 € ${"incl. VAT ".repeat(6)}`;
    expect(checkpointText({ what: { pay: { site: "shop.example", total: long } } })).toBe(
      `▲ asked to pay on shop.example · the page says "${long.slice(0, 39)}…"`,
    );
    expect(checkpointText({ what: { pay: true, submit: { host: "shop.example" } } })).toBe(
      "▲ asked to send a form to shop.example",
    );
    expect(checkpointText({ what: { submit: { action: "https://shop.example/cart?x=1" } } })).toBe(
      "▲ asked to send a form to shop.example/cart?x=1",
    );
    expect(
      checkpointText({ what: { submit: { host: "a.example", action: "https://b.example/" } } }),
    ).toBe("▲ asked to send a form to a.example");
  });

  test("a checkpoint's yes without a host names the destination; without either, nothing", () => {
    expect(
      checkpointNotice({
        tool: "vimma_activate",
        label,
        what: { submit: { action: "https://shop.example/cart" } },
      }),
    ).toBe("allowed sending the form to shop.example/cart");
    expect(checkpointNotice({ tool: "vimma_activate", label, what: {} })).toBe(
      "allowed sending the form to ",
    );
  });

  test("a show in another window, of a window already on the agent workspace", () => {
    const show = { tool: "vimma_show", label, what: {} };
    expect(shownNotice(show, { otherWindow: true, switched: false })).toBe(
      "showing example-agent's tab in the other window",
    );
  });

  test("the notification of a question without details, or of a tool it does not know", () => {
    expect(agentAlertText({ tool: "vimma_tabs", label } as never)).toBe(
      "example-agent asks to use Vimma's agent workspace (list its tabs)",
    );
    expect(agentAlertText({ tool: "vimma_future", label, what: {} })).toBe(
      "example-agent asks to use Vimma's agent workspace (use a tool)",
    );
  });

  test(":mcp log: an empty detail adds nothing, a long one is cut at its end, a stop says why", () => {
    const e: LogEntry = {
      at: new Date(2026, 0, 1, 9, 5, 7).getTime(),
      client: "claude-code",
      tool: "vimma_keys",
      title: "",
      detail: "",
      outcome: "yes",
    };
    expect(logRow(e)).toBe("09:05:07 \u2068claude-code\u2069 vimma_keys · allowed");
    expect(logRow({ ...e, detail: "k".repeat(130) })).toBe(
      `09:05:07 \u2068claude-code\u2069 vimma_keys \u2068${"k".repeat(119)}…\u2069 · allowed`,
    );
    expect(logRow({ ...e, outcome: "stopped" })).toBe(
      "09:05:07 \u2068claude-code\u2069 vimma_keys · stopped (early)",
    );
    expect(logRow({ ...e, outcome: "stopped", why: "budget" } as LogEntry)).toBe(
      "09:05:07 \u2068claude-code\u2069 vimma_keys · stopped (budget)",
    );
  });
});

// security.md M4: what an agent or a page chose is drawn as its own bidi run.
describe("every chosen text is its own bidi run (mutation-tested)", () => {
  const isolation = (line: { parts: { text: string; isolate?: string }[] }, t: string) =>
    line.parts.find((p) => p.text === t)?.isolate;

  test("a download's name, an element's text, a replaced tab's title and the host", () => {
    const download = {
      tool: "vimma_download",
      label,
      what: { name: "report.pdf", size: 1, type: "application/pdf", host: "example.com" },
    };
    const d = questionLine(download, { grantMinutes: 10 });
    expect(isolation(d, "report.pdf")).toBe("auto");
    expect(isolation(d, "example.com")).toBe("ltr");
    const click = {
      tool: "vimma_activate",
      label,
      what: { ...read.what, label: "sd", kind: "button", text: "Merge" },
    };
    expect(isolation(questionLine(click, { grantMinutes: 10 }), "Merge")).toBe("auto");
    const fill = {
      tool: "vimma_fill",
      label,
      what: { ...read.what, fields: [{ label: "sd", name: "Email", value: "a" }] },
    };
    expect(isolation(questionLine(fill, { grantMinutes: 10 }), "Email")).toBe("auto");
    const into = { ...open, what: { ...open.what, tab: "7", title: "Old" } };
    expect(isolation(questionLine(into, { grantMinutes: 10 }), "Old")).toBe("auto");
  });

  test("a checkpoint's client, title, keys and site", () => {
    const form = {
      tool: "vimma_activate",
      label,
      what: {
        title: "Shop",
        submit: { method: "post", action: "https://a.example/", host: "a.example" },
      },
    };
    const f = questionLine(form, { grantMinutes: 10 });
    expect(isolation(f, "example-agent")).toBe("auto");
    expect(isolation(f, "Shop")).toBe("auto");
    const keyed = {
      ...keys,
      what: { ...keys.what, keys: "3j H", pay: { site: "shop.example", keys: "H" } },
    };
    const k = questionLine(keyed, { grantMinutes: 10 });
    expect(isolation(k, "H")).toBe("ltr");
    expect(isolation(k, "shop.example")).toBe("ltr");
    const followed = {
      ...keys,
      what: { ...keys.what, keys: "fsd", pay: { text: "Pay", site: "s.example" } },
    };
    expect(isolation(questionLine(followed, { grantMinutes: 10 }), "fsd")).toBe("ltr");
  });

  test("a click that pays shows no keys; a sent field's name and a total are cut at their end", () => {
    const pay = {
      tool: "vimma_activate",
      label,
      what: {
        keys: "x",
        pay: { text: "Pay", site: "shop.example", total: `Total ${"9".repeat(50)} €` },
        submit: { method: "post", action: "https://shop.example/", host: "shop.example" },
        sent: { fields: [{ name: "n".repeat(30), value: "v" }], hidden: 0, more: 0 },
      },
    };
    const line = text(questionLine(pay, { grantMinutes: 10 }));
    expect(line).not.toContain("keys");
    expect(line).toContain(` · the page says "Total ${"9".repeat(33)}…"`);
    expect(line).toContain(`  ${"n".repeat(23)}… "v"`);
  });

  test("a form's detail of what it sends that is not an object is not listed: the count is", () => {
    const form = {
      tool: "vimma_activate",
      label,
      what: {
        title: "Shop",
        submit: { method: "post", action: "https://a.example/", host: "a.example", fields: 2 },
        sent: true,
      },
    };
    expect(text(questionLine(form, { grantMinutes: 10 }))).toBe(
      '▲ example-agent wants to send a form: "Shop" → POST a.example (2 fields)',
    );
  });

  test("a step that followed no link is named as itself; :control on needs on first", () => {
    expect(stepText({ tool: "vimma_elements", what: { title: "T", followed: "x.example" } })).toBe(
      'listed the buttons and fields of "T"',
    );
    expect(parseControlCommand("at 15").kind).toBe("refuse");
  });
});
