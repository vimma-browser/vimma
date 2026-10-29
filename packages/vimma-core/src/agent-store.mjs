/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The built-in agent's stored conversations, pure (docs/specs/builtin-agent.md B15, Behaviour
// 19-23): what a conversation's file holds, what a reopened one sends the model, Vimma's own
// task summaries, and when `keep_days` deletes one. A record holds the user's messages, the
// agent's replies and the summaries, with the title, the provider and two times; never a tool
// result, an element list, a screenshot or a transcript step line, so no page text a site wrote
// is kept except as the agent chose to quote it in a reply. The browser's AgentStore.sys.mjs
// encrypts each record with OSKeyStore before it is written.

/**
 * @typedef {{ kind: "user" | "agent" | "summary", text: string }} StoredEntry
 * @typedef {{ name: string, kind: "openai" | "anthropic", endpoint: string, model: string,
 *   vision: boolean, priceIn?: number, priceOut?: number }} StoredProvider
 * @typedef {{ v: number, id: string, title: string, created: number, used: number,
 *   provider: StoredProvider, entries: StoredEntry[] }} StoredRecord
 * @typedef {import("./agent-providers.mjs").ChatMessage} ChatMessage
 */

/** The record's format; a file of another version is not read. */
export const STORE_VERSION = 1;

const ENTRY_KINDS = new Set(["user", "agent", "summary"]);
/** A record's id is a file name too: only a UUID. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Hosts a summary names before `and N more`. */
const MAX_HOSTS = 10;
const DAY_MS = 86_400_000;
/**
 * The most UTF-8 bytes a record may take. OSKeyStore's decrypt builds its string with one
 * argument a byte (`String.fromCharCode.apply`, toolkit/modules/OSKeyStore.sys.mjs), which
 * fails above about 500,000, and a file it cannot decrypt would drop out of the list.
 */
export const MAX_RECORD_BYTES = 400_000;

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
/** @param {unknown} v */
const isTime = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
/** @param {unknown} v */
const isPrice = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * The provider as stored: its name, kind, endpoint, model, vision and prices, and nothing else,
 * so no field a caller added (a key above all) is ever written. Null when it is not one.
 * @param {unknown} p
 * @returns {StoredProvider | null}
 */
function storedProvider(p) {
  if (!isObject(p)) return null;
  if (p.kind !== "openai" && p.kind !== "anthropic") return null;
  if (typeof p.name !== "string" || !p.name || typeof p.model !== "string" || !p.model) {
    return null;
  }
  if (typeof p.endpoint !== "string") return null;
  try {
    const url = new URL(p.endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  } catch {
    return null;
  }
  /** @type {StoredProvider} */
  const out = {
    name: p.name,
    kind: p.kind,
    endpoint: p.endpoint,
    model: p.model,
    vision: p.vision === true,
  };
  if (isPrice(p.priceIn) && isPrice(p.priceOut)) {
    out.priceIn = p.priceIn;
    out.priceOut = p.priceOut;
  }
  return out;
}

/** @param {unknown} e @returns {e is StoredEntry} */
const isEntry = (e) => isObject(e) && ENTRY_KINDS.has(e.kind) && typeof e.text === "string";

/**
 * What is written of a conversation: its id, title, times, provider, and its stored entries
 * (messages, replies, summaries). Everything else it holds in memory (the model's messages with
 * their tool results, the transcript's step lines, its gate state) is left out by construction.
 * A conversation longer than MAX_RECORD_BYTES keeps its newest entries.
 * @param {{ uid: string, title: string, created: number, used: number, provider: unknown,
 *   stored: unknown[] }} c
 * @returns {StoredRecord}
 */
export function storedRecord(c) {
  const provider = storedProvider(c.provider);
  if (!provider) throw new Error("the conversation's provider cannot be stored");
  const record = {
    v: STORE_VERSION,
    id: c.uid,
    title: c.title,
    created: c.created,
    used: c.used,
    provider,
    entries: c.stored.filter(isEntry).map((e) => ({ kind: e.kind, text: e.text })),
  };
  const size = (/** @type {unknown} */ v) => new TextEncoder().encode(JSON.stringify(v)).length;
  let over = size(record) - MAX_RECORD_BYTES;
  while (over > 0 && record.entries.length > 1) {
    over -= size(record.entries.shift()) + 1;
  }
  const last = record.entries[0];
  if (over > 0 && last) {
    // One entry alone is too long: its start is kept, cut by characters until it fits.
    const chars = [...last.text];
    const keep = Math.max(0, chars.length - over);
    last.text = chars.slice(0, keep).join("");
    while (size(record) > MAX_RECORD_BYTES && last.text) {
      last.text = [...last.text].slice(0, -1024).join("");
    }
  }
  return record;
}

/**
 * A record read back from its file, checked: null for another version or any field out of
 * shape. Fields it does not know are dropped.
 * @param {unknown} v
 * @returns {StoredRecord | null}
 */
export function readRecord(v) {
  if (!isObject(v) || v.v !== STORE_VERSION) return null;
  if (typeof v.id !== "string" || !UUID.test(v.id)) return null;
  if (typeof v.title !== "string" || !isTime(v.created) || !isTime(v.used)) return null;
  const provider = storedProvider(v.provider);
  if (!provider || !Array.isArray(v.entries) || !v.entries.every(isEntry)) return null;
  return {
    v: STORE_VERSION,
    id: v.id,
    title: v.title,
    created: v.created,
    used: v.used,
    provider,
    entries: v.entries.map((/** @type {StoredEntry} */ e) => ({ kind: e.kind, text: e.text })),
  };
}

/**
 * What a reopened or cleared conversation sends the model (Behaviour 21-22): the user's
 * messages, the agent's replies and Vimma's summaries, which go as the user's notes so that a
 * model never reads them as its own words.
 * @param {StoredEntry[]} entries
 * @returns {ChatMessage[]}
 */
export function modelMessages(entries) {
  return entries.map((e) =>
    e.kind === "agent"
      ? { role: "assistant", text: e.text, toolCalls: [] }
      : {
          role: "user",
          text: e.kind === "summary" ? `(Vimma: an earlier task: ${e.text})` : e.text,
        },
  );
}

/**
 * A reopened conversation's transcript: its messages and replies, and each task's summary as
 * one of Vimma's lines in place of the steps, which are not kept.
 * @param {StoredEntry[]} entries
 * @returns {{ kind: "user" | "agent" | "notice", text: string }[]}
 */
export function restoredEntries(entries) {
  return entries.map((e) => ({ kind: e.kind === "summary" ? "notice" : e.kind, text: e.text }));
}

/** @param {number} n */
function tokens(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** @type {Readonly<Record<string, string>>} */
const OUTCOMES = Object.freeze({
  done: "done",
  stopped: "stopped",
  budget: "stopped at its budget",
  error: "failed",
});

/**
 * A task's summary, written by Vimma rather than the model (B15): its outcome, its step and
 * token counts and the hosts it loaded, so it carries no page text and costs no request.
 * @param {{ outcome: string, checkpoint: boolean, steps: number, tokens: number,
 *   estimated?: boolean, hosts: string[] }} t
 */
export function taskSummary(t) {
  const outcome = t.checkpoint ? "stopped at a checkpoint" : (OUTCOMES[t.outcome] ?? "failed");
  const steps = `${t.steps} step${t.steps === 1 ? "" : "s"}`;
  const count = `${t.estimated ? "~" : ""}${tokens(t.tokens)} tokens`;
  const shown = t.hosts.slice(0, MAX_HOSTS);
  const more = t.hosts.length - shown.length;
  const hosts = shown.length
    ? `hosts: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`
    : "no pages loaded";
  return `task ${outcome} · ${steps} · ${count} · ${hosts}`;
}

/**
 * The hosts of `urls` a task loaded, once each, in order: http and https only, as the URL
 * parser writes them (punycode, no path or query, which may carry what a page put there).
 * @param {unknown[]} urls
 * @returns {string[]}
 */
export function hostsOf(urls) {
  /** @type {Set<string>} */
  const hosts = new Set();
  for (const u of urls) {
    if (typeof u !== "string") continue;
    try {
      const url = new URL(u);
      if ((url.protocol === "http:" || url.protocol === "https:") && url.host) hosts.add(url.host);
    } catch {
      // not a URL: no host to name
    }
  }
  return [...hosts];
}

/**
 * Whether a task's last step was a checkpoint the user did not say yes to, from its
 * transcript entries: the summary says `stopped at a checkpoint`, whatever the model did after.
 * @param {{ kind: string, outcome?: string }[]} entries  the task's
 */
export function stoppedAtCheckpoint(entries) {
  const last = [...entries].reverse().find((e) => e.kind === "step" || e.kind === "checkpoint");
  return last?.kind === "checkpoint" && last.outcome !== "→ you said yes";
}

/**
 * Whether `keep_days` deletes a conversation last used at `used` (Behaviour 20).
 * @param {number} used @param {number} now @param {number | null} keepDays  null: kept
 */
export function expired(used, now, keepDays) {
  return keepDays !== null && now - used > keepDays * DAY_MS;
}

/**
 * The conversation list's last use (Behaviour 19).
 * @param {number} used @param {number} now
 */
export function lastUseText(used, now) {
  const s = Math.max(0, Math.floor((now - used) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const days = Math.floor(s / 86_400);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
