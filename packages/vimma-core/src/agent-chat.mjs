/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The built-in agent's chat window, pure (docs/specs/builtin-agent.md B9, B19, Behaviour 6,
// 12-17, 34-35): the transcript, the header, the status bar's text, `:agent` and the window's
// keys in normal mode. The transcript is built from the model loop's task events (a reply, a
// call, its result) and the gate's events for the conversation (asked, answered, ran under the
// grant), never from a tool's own result format, so a step reads the same whatever the tool
// returns and page text never reaches it except as the gate's notice words name a tab or a
// button. Every value is plain text; the browser's ui/agent-chat.mjs sets it as text.

import { closest } from "./actions.mjs";
import { AGENT_GLYPH } from "./agent.mjs";
import { budgetLimitText } from "./agent-budget.mjs";
import { checkpointText, isCheckpoint, stepText } from "./agent-prompt.mjs";
import { LOCAL_SERVERS } from "./agent-setup.mjs";
import { formatConfigError } from "./config.mjs";

/**
 * @typedef {import("./agent-loop.mjs").TaskEvent} TaskEvent
 * @typedef {import("./agent-budget.mjs").Exceeded} Exceeded
 * @typedef {import("./agent-providers.mjs").ToolCall} ToolCall
 * @typedef {{ kind: "user" | "agent" | "step" | "checkpoint" | "notice" | "end", text: string,
 *   outcome?: string, warn?: boolean }} Entry
 *   `outcome`: a step's or a checkpoint's, as it changes; `warn`: an end the user should read
 * @typedef {{ kind: "asked" | "ran" | "timeout" | "answered", tool: string,
 *   what: Record<string, any>, answer?: string }} ConvGateEvent
 *   one of AgentGate's events about this conversation's connection
 * @typedef {{ outcome: string, after?: ToolCall | null, exceeded?: Exceeded, error?: string }}
 *   TaskEnd
 * @typedef {{ steps: number, maxSteps: number, tokens: number, estimated: boolean,
 *   cost: number | null }} BudgetStatus
 * @typedef {{ name: string, kind: string, endpoint: string, model: string }} HeaderProvider
 */

/** The label above the agent's replies (B19): a reply never starts at the window's edge. */
export const AGENT_LABEL = "agent";
export const USER_LABEL = "you";

/**
 * C0 and C1 controls but tab and line feed, and the bidi controls, which could make a line of
 * the model's read in another order than it is stored (security.md M4).
 */
// eslint-disable-next-line no-control-regex -- the control characters are what it removes
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/**
 * The user's or the model's text as the window shows it: line breaks and tabs kept, `\r\n` as
 * a line break, every other control and bidi character removed.
 * @param {unknown} text
 */
export function chatText(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(UNSAFE, "");
}

/** What the gate's answers make of a step (Behaviour 12). */
/** @type {Readonly<Record<string, string>>} */
const ANSWERS = Object.freeze({
  once: "asked → yes",
  grant: "asked → yes, granted",
  deny: "denied",
  mute: "denied (muted)",
});

/** Columns a tool's name keeps in a step's line. */
const NAME_COLUMNS = 40;

/**
 * A tool's name as the model sent it, on one line and cut (security.md M42): a made-up name with
 * line breaks would otherwise draw lines at the window's edge, where Vimma's own start.
 * @param {unknown} name
 */
const toolName = (name) => {
  const one = chatText(name).replace(/\s+/g, " ").trim();
  const chars = [...one];
  return chars.length > NAME_COLUMNS ? `${chars.slice(0, NAME_COLUMNS).join("")}…` : one;
};

export class Transcript {
  constructor() {
    /** @type {Entry[]} */
    this.entries = [];
    /** The step running now: the gate's events while it runs are about it. @type {Entry | null} */
    this.step = null;
    /** Every change raises it, so a window redraws only when it moved. */
    this.version = 0;
  }

  /** @param {Entry} entry */
  push(entry) {
    this.entries.push(entry);
    this.version++;
    return entry;
  }

  /**
   * A message the user sent; `during`: while a task ran (Behaviour 15).
   * @param {string} text @param {{ during?: boolean }} [opts]
   */
  user(text, { during = false } = {}) {
    this.push({ kind: "user", text: chatText(text) + (during ? " (added during the task)" : "") });
  }

  /** A notice of Vimma's: a grant made or ended, a page given (Behaviour 12, 17). @param {string} text */
  notice(text) {
    this.push({ kind: "notice", text: chatText(text) });
  }

  /**
   * One of the loop's events.
   * @param {TaskEvent} e
   */
  task(e) {
    switch (e.type) {
      case "reply":
        this.push({ kind: "agent", text: chatText(e.text) });
        return;
      case "call":
        this.step = this.push({ kind: "step", text: toolName(e.call.name), outcome: "…" });
        return;
      case "refused":
        this.push({
          kind: "step",
          text: toolName(e.call.name),
          outcome: `refused: ${chatText(e.reason)}`,
        });
        return;
      case "result": {
        const step = this.step;
        this.step = null;
        if (!step) return;
        // The gate's outcome stays; a step it never asked about either ran or was refused by
        // the agent commands (a tab that is not the conversation's, arguments out of range).
        if (step.outcome === "…" || step.outcome === "asking you") {
          step.outcome = e.result.isError ? "refused" : "done";
        }
        this.version++;
        return;
      }
      case "server-error":
        this.notice(`the model server failed (${e.error}); it is asked again`);
        return;
      default:
        // `usage` shows in the header and the status bar; `steer` was shown when it was sent.
        return;
    }
  }

  /**
   * One of the gate's events for this conversation, while a step runs.
   * @param {ConvGateEvent} e
   */
  gate(e) {
    const step = this.step;
    if (!step) return;
    const asked = { tool: e.tool, label: null, what: e.what ?? {} };
    if (isCheckpoint(asked)) {
      step.kind = "checkpoint";
      step.text = checkpointText(asked);
      step.outcome =
        e.kind === "asked"
          ? "waiting for you"
          : e.kind === "timeout"
            ? "→ no answer, stopped"
            : e.answer === "once" || e.answer === "grant"
              ? "→ you said yes"
              : "→ you said no";
    } else {
      step.text = stepText(asked);
      step.outcome =
        e.kind === "asked"
          ? "asking you"
          : e.kind === "ran"
            ? "ran under grant"
            : e.kind === "timeout"
              ? "denied (no answer)"
              : (ANSWERS[e.answer ?? ""] ?? "denied");
    }
    this.version++;
  }

  /**
   * The task ended (Behaviour 16, 34).
   * @param {TaskEnd} result
   */
  end(result) {
    const running = this.step;
    this.step = null;
    if (running && (running.outcome === "…" || running.outcome === "asking you")) {
      running.outcome = "withdrawn";
    }
    if (result.outcome === "done") {
      this.push({ kind: "end", text: "done" });
    } else if (result.outcome === "stopped") {
      const last = result.after
        ? [...this.entries].reverse().find((e) => e.kind === "step" || e.kind === "checkpoint")
        : null;
      this.push({ kind: "end", text: last ? `stopped after "${last.text}"` : "stopped" });
    } else if (result.outcome === "budget" && result.exceeded) {
      this.push({ kind: "end", text: budgetLimitText(result.exceeded), warn: true });
    } else {
      const error = chatText(result.error ?? "the task failed");
      this.push({
        kind: "end",
        text: error.startsWith("stopped") ? error : `stopped: ${error}`,
        warn: true,
      });
    }
  }
}

/**
 * How the window draws one entry: the user's messages and the agent's replies under a label,
 * indented, so that no line of the model's starts at the window's edge where Vimma's own lines
 * do (B19); a step on one line after `·`, dimmed; a checkpoint in the warning colour.
 * @param {Entry} entry
 * @returns {{ label: string | null, lines: string[], indent: boolean,
 *   tone: "normal" | "dim" | "warn" }}
 */
export function entryView(entry) {
  if (entry.kind === "user" || entry.kind === "agent") {
    return {
      label: entry.kind === "agent" ? AGENT_LABEL : USER_LABEL,
      lines: entry.text.split("\n"),
      indent: true,
      tone: "normal",
    };
  }
  if (entry.kind === "checkpoint") {
    return {
      label: null,
      lines: [`${entry.text} ${entry.outcome ?? ""}`.trimEnd()],
      indent: false,
      tone: "warn",
    };
  }
  if (entry.kind === "step") {
    return {
      label: null,
      lines: [`· ${entry.text}${entry.outcome ? ` — ${entry.outcome}` : ""}`],
      indent: false,
      tone: "dim",
    };
  }
  return { label: null, lines: [entry.text], indent: false, tone: entry.warn ? "warn" : "dim" };
}

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);
const PROBED_PORTS = new Set(LOCAL_SERVERS.map((s) => String(s.port)));

/** @param {string} endpoint @returns {URL | null} */
function parse(endpoint) {
  try {
    return new URL(endpoint);
  } catch {
    return null;
  }
}

/**
 * Whether requests to `endpoint` stay on this machine as far as Vimma can see: a loopback
 * address (a local server may still forward them, which the header says).
 * @param {string} endpoint
 */
export function isLocalEndpoint(endpoint) {
  const url = parse(endpoint);
  return !!url && LOOPBACK.has(url.hostname);
}

/**
 * Whether a provider's requests need an API key: Anthropic's always, an OpenAI-compatible
 * endpoint off this machine (a local server takes none).
 * @param {{ kind: string, endpoint: string }} p
 */
export const needsKey = (p) => p.kind === "anthropic" || !isLocalEndpoint(p.endpoint);

/** Who runs an API, for the hosts Vimma knows; another host is named by its address only. */
const VENDORS = Object.freeze({ "api.anthropic.com": "Anthropic" });

/**
 * What the window asks before a conversation's first task to a provider off this machine
 * (Behaviour 5), with `y` and `n`.
 * @param {{ kind: string, endpoint: string }} provider
 */
export function externalNotice(provider) {
  const host = parse(provider.endpoint)?.host ?? chatText(provider.endpoint);
  const vendor = Object.hasOwn(VENDORS, host)
    ? /** @type {Record<string, string>} */ (VENDORS)[host]
    : "";
  return (
    "Page text the agent reads, field values it sees, screenshots and your messages are sent " +
    `to ${host}${vendor ? ` (${vendor})` : ""}. y send · n cancel`
  );
}

/**
 * Where the provider's requests go, as the header says it: a probed local server's model stays
 * on this machine; another local address is named, since Vimma cannot see whether that server
 * forwards to a hosted model; a hosted endpoint receives page text.
 * @param {string} endpoint
 */
export function whereDataGoes(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return "no endpoint";
  }
  if (!LOOPBACK.has(url.hostname)) return `page text sent to ${url.host}`;
  if (url.hostname === "127.0.0.1" && PROBED_PORTS.has(url.port)) return "stays on this machine";
  return `local endpoint ${url.host}`;
}

/**
 * Why no model is set up when config.toml was refused (Behaviour 6): a file with errors applies
 * none of its tables, `[agent]` included, so the setup hint would mislead. The `[agent]` error
 * when there is one, else the file's first, with the count as the status bar gives it. Null when
 * the file was applied.
 * @param {readonly import("./config.mjs").ConfigError[]} errors
 * @param {string} file
 * @returns {string | null}
 */
export function noModelReason(errors, file) {
  const first = errors.find((e) => /^agent(?:$|[.[])/.test(e.path)) ?? errors[0];
  if (!first) return null;
  const text = formatConfigError(first, file);
  return errors.length > 1 ? `${errors.length} errors: ${text}` : text;
}

/**
 * The notice when an action needs a model and there is none (`:agent`, `n`, `P`, Enter).
 * @param {string | null} refused  noModelReason's text
 */
export function noModelNotice(refused) {
  return refused
    ? `agent: no model: ${refused}`
    : "agent: no model is set up; add one under [agent] in config.toml";
}

/**
 * The window's body with no model: the refused file's error and how it comes into force, or
 * the setup steps when the file was applied.
 * @param {string | null} refused  noModelReason's text
 * @param {string} file  the file it is about
 * @returns {string[]}
 */
export function noModelLines(refused, file) {
  if (!refused) {
    return [
      "No model is set up for the built-in agent.",
      "Add a provider under [agent] in config.toml, or press Esc, then m to look for a " +
        "local model server (Ollama, LM Studio, llama.cpp) on this machine.",
    ];
  }
  return [
    `No model: ${file} has errors, so none of it applies, [agent] included.`,
    refused,
    "Fix it and save the file, then press Esc, then n for a new conversation.",
  ];
}

/**
 * The window's two header lines (Behaviour 6): the provider, the model and where data goes;
 * where the agent works, its grant and, while a task runs, its steps. `asking`: the latest task
 * was sent with ctrl+Enter. Without a grant or such a task the approval is left unsaid, because
 * the next task sent with Enter is itself the grant (Behaviour 24).
 * @param {{ provider: HeaderProvider | null, granted: boolean, asking?: boolean,
 *   localOnly?: boolean, budget?: BudgetStatus | null, refused?: string | null }} o
 *   `refused`: noModelReason's text, shown in place of the setup hint
 * @returns {[string, string]}
 */
export function chatHeader({
  provider,
  granted,
  asking = false,
  localOnly = false,
  budget = null,
  refused = null,
}) {
  const first = provider
    ? `${chatText(provider.name)} · ${chatText(provider.model)} · ${whereDataGoes(provider.endpoint)}`
    : refused
      ? `no model: ${chatText(refused)}`
      : "no model set up";
  const second = [
    "works in: agent workspace",
    ...(granted ? ["granted"] : asking ? ["asks every step"] : []),
    ...(budget ? [`${budget.steps}/${budget.maxSteps} steps`] : []),
  ].join(" · ");
  return [localOnly ? `${first} · local only` : first, second];
}

/** @param {number} n */
function tokens(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/**
 * The status bar's text for the running tasks (Behaviour 35): one task's steps, tokens (`~` an
 * estimate) and cost when prices are set; several, how many. Null with none.
 * @param {BudgetStatus[]} running
 */
export function builtinStatus(running) {
  if (!running.length) return null;
  if (running.length > 1) return `${AGENT_GLYPH} ${running.length} agents`;
  const b = /** @type {BudgetStatus} */ (running[0]);
  const cost = b.cost === null ? "" : ` · ${b.cost.toFixed(2)}`;
  return `${AGENT_GLYPH} built-in ${b.steps}/${b.maxSteps} · ${b.estimated ? "~" : ""}${tokens(
    b.tokens,
  )} tok${cost}`;
}

const WORDS = Object.freeze(["stop", "new", "model", "list", "clear", "give", "forget all"]);

/**
 * `:agent [stop | new | model | list | clear | give | forget all]` (Behaviour 14); without a
 * word it opens the window.
 * @param {string | undefined} text
 * @returns {{ kind: "open" | "stop" | "new" | "model" | "list" | "clear" | "give" | "forget" }
 *   | { kind: "refuse", text: string }}
 */
export function parseAgentCommand(text) {
  const words = (text ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  if (!words) return { kind: "open" };
  if (words === "forget all") return { kind: "forget" };
  if (WORDS.includes(words)) {
    return /** @type {{ kind: "stop" | "new" | "model" | "list" | "clear" | "give" }} */ ({
      kind: words,
    });
  }
  const refusal = `:agent takes ${WORDS.map((w) => `"${w}"`).join(", ")} or nothing`;
  const near = closest(words, [...WORDS]);
  return { kind: "refuse", text: near ? `${refusal}: did you mean "${near}"?` : refusal };
}

/** The window's keys in normal mode (Behaviour 14): fixed, as a picker's are. */
const NORMAL = Object.freeze({
  j: "down",
  k: "up",
  "ctrl+d": "half-down",
  "ctrl+u": "half-up",
  G: "bottom",
  "shift+g": "bottom",
  i: "insert",
  a: "insert",
  s: "stop",
  m: "model",
  n: "new",
  c: "list",
  C: "clear",
  "shift+c": "clear",
  P: "give",
  "shift+p": "give",
  y: "yank",
  q: "close",
});

/**
 * What a key does in the window's normal mode; `g` waits for a second `g`.
 * @param {string} pending  `g` after a first g, else ""
 * @param {string} key  core formatKey
 * @returns {{ kind: "do", what: string } | { kind: "pending", pending: string } | { kind: "none" }}
 */
export function chatKey(pending, key) {
  if (pending === "g") return key === "g" ? { kind: "do", what: "top" } : { kind: "none" };
  if (key === "g") return { kind: "pending", pending: "g" };
  const what = /** @type {Record<string, string>} */ (NORMAL)[key];
  return what ? { kind: "do", what } : { kind: "none" };
}
