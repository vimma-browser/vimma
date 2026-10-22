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
  isCheckpoint,
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
  fillFits,
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
    expect(line.hint).toBe("y once · 15a 15 min, all but forms and paying · n deny · x mute");
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
    expect(line.hint).toBe("y once · 15a 15 min, all but forms and paying · n deny · x mute");
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
  test("a grant names the waiting calls it let run, which the user did not see asked", () => {
    expect(grantNotice(read, { minutes: 15, capped: false }, 2)).toBe(
      "example-agent may use the agent workspace for 15 min; sending a form or paying still asks " +
        "(ctrl+b shift+a ends it) · it also ran 2 waiting calls (:mcp log)",
    );
    expect(grantNotice(read, { minutes: 15, capped: false }, 1)).toMatch(
      / · it also ran 1 waiting call \(:mcp log\)$/,
    );
  });

  test("a grant names its scope, its length, the cap, and the key that ends it", () => {
    expect(grantNotice(read, { minutes: 15, capped: false })).toBe(
      "example-agent may use the agent workspace for 15 min; sending a form or paying still asks " +
        "(ctrl+b shift+a ends it)",
    );
    expect(grantNotice(read, { minutes: 480, capped: true })).toBe(
      "example-agent may use the agent workspace for 480 min, the most [mcp] grant_max_minutes " +
        "allows; sending a form or paying still asks (ctrl+b shift+a ends it)",
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
    expect(checkpointNotice(pay)).toBe("paid on shop.example");
    expect(checkpointNotice(signup)).toBe("sent the form to example.com");
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
    expect(line.hint).toBe("y once · 10a 10 min, all but forms and paying · n deny · x mute");
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
