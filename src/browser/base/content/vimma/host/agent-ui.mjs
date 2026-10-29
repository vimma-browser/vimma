/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The agent question, run (docs/specs/vimma-mcp.md, decisions 13-16, 23-24, 29 C): AgentGate
// holds the questions; this shows the oldest in one window, the most recent normal one. It opens
// by itself only while that window is focused, out of fields, after 1,500 ms without a key and
// with nothing else open (core mayOpenByItself); otherwise it waits as `◇ agent 1?` for
// `ctrl+b shift+a` (`mcp.answer`). It never takes focus, raises the window or switches
// workspace: VimmaHost hands it the keys from its capture listener. A window not in front gets
// getAttention() and a desktop notification once per question, with no URL and no buttons.

import {
  agentAlertText,
  agentState,
  checkpointNotice,
  deniedNotice,
  FULL_CONTROL,
  grantNotice,
  isCheckpoint,
  mayOpenByItself,
  noGrant,
  promptKey,
  questionLine,
  RAN_MS,
  ranNotice,
} from "../core/agent-prompt.mjs";
import { chordFromEvent, formatKey } from "../core/keys.mjs";
import { isBuiltinConn } from "../core/agent.mjs";
import { builtinStatus } from "../core/agent-chat.mjs";
import { AgentGate } from "../ctl/AgentGate.sys.mjs";
import { McpHost } from "./mcp-ops.mjs";

/** @import { Question, GateEvent } from "../ctl/AgentGate.sys.mjs" */

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  // Lazily: AgentChat runs its tools through agent-commands, which imports this module.
  AgentChat: "chrome://browser/content/vimma/agent/AgentChat.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/** Firefox's own arming delay for security dialogs (modules/libpref/init/all.js). */
const ARMING_PREF = "security.dialog_enable_delay";
/** How often a waiting question checks whether it may open now. */
const POLL_MS = 250;
/** How often the status bar's grant minutes are redrawn while a grant runs. */
const TICK_MS = 15_000;
/**
 * A held notice (spec ship-vimma-ctl, decision 9) shows this long after the line is free, so the
 * agent's first question, which follows its hello at once, comes first, and an answer's own
 * notice (NOTICE_MS, ui/notice.mjs) is read before it.
 */
const HELD_DELAY_MS = 1600;
/** How long a held notice stays: as long as an update announcement. */
const HELD_MS = 6000;

/**
 * What the host tells the agent UI about one window.
 * @typedef {object} AgentWindow
 * @property {import("../ui/agent-prompt.mjs").AgentPrompt} prompt
 * @property {() => boolean} inField  focus is in an editable field (insert mode)
 * @property {() => boolean} otherOpen  a picker, prompt, panel or the command line is open
 * @property {() => boolean} pending  a key sequence is under way (after ctrl+b)
 * @property {(text: string, ms?: number) => void} notice  `ms`: how long it stays
 * @property {() => boolean} noticeOpen  a notice is on screen
 * @property {(question: string, yes: () => void) => void} ask  a y/N on the prompt line
 * @property {() => void} emit  redraw the status bar
 * @property {import("../ui/agent-prompt.mjs").AgentPrompt} [slot]  the chat window's prompt
 *   slot (docs/specs/builtin-agent.md Behaviour 27)
 * @property {() => import("../core/agent.mjs").ConnId | null} [slotConn]  the connection of the
 *   conversation the chat window shows, while it is open
 * @property {() => boolean} [chatFocused]  focus is in the chat window
 * @property {() => void} [slotChanged]  the slot opened or closed
 * @property {() => void} [focusChat]  focus the chat window (its question waits there)
 */

/** @type {Map<Window, AgentWindow>} */
const windows = new Map();
/** When each window last had a key. @type {WeakMap<Window, number>} */
const lastKey = new WeakMap();
/**
 * The question on screen: which, where, the digits typed, and whether in a chat window's slot
 * rather than on the question line.
 * @type {{ id: number, win: Window, count: string, question: Question, slot: boolean } | null}
 */
let current = null;
/** Questions a window not in front was told about already (decision 15: once each). */
const alerted = new Set();
let poll = /** @type {any} */ (null);
let tick = /** @type {any} */ (null);
/** A notice that waits until no question waits, and its timer. @type {string | null} */
let held = null;
let heldTimer = /** @type {any} */ (null);
/** Since when no question has waited (0 while one waits). */
let freeSince = 0;
let listening = false;

/** The window that asks: the most recent normal (non-private) browser window. */
function askingWindow() {
  let best = null;
  for (const win of /** @type {any} */ (Services.wm).getEnumerator("navigator:browser")) {
    if (!windows.has(win) || lazy.PrivateBrowsingUtils.isWindowPrivate(win)) continue;
    best = win;
  }
  const top = Services.wm.getMostRecentWindow("navigator:browser");
  if (top && windows.has(top) && !lazy.PrivateBrowsingUtils.isWindowPrivate(top)) return top;
  return best;
}

/** @param {Window} win */
const isFocused = (win) => /** @type {any} */ (Services.focus).activeWindow === win;

/** @param {Window} win */
const isFullscreen = (win) => win.document.documentElement.hasAttribute("inDOMFullscreen");

const grantMinutes = () => McpHost.config?.grantMinutes ?? 0;
const armMs = () => Services.prefs.getIntPref(ARMING_PREF, 1000);

/** Window events after which the line must arm again (security.md M4). */
const REARM_EVENTS = ["activate", "deactivate", "focus", "blur"];
/** @type {WeakMap<Window, (e: Event) => void>} */
const rearmers = new WeakMap();

/**
 * The window came to the front or left it, or its page was hidden or shown: a just-focused
 * window counts as one being typed in (no opening by itself for 1.5 s), and an open line arms
 * again, so a key meant for another window never answers it.
 * @param {Window} win @param {Event} e
 */
function onWindowChange(win, e) {
  // focus and blur bubble from every element: only the window's own count.
  if ((e.type === "focus" || e.type === "blur") && e.target !== win) return;
  lastKey.set(win, Date.now());
  if (current?.win === win) promptOf(current)?.rearm(armMs());
}

/**
 * Where a question shows: the line, or the chat window's slot.
 * @param {{ win: Window, slot: boolean }} where
 */
function promptOf({ win, slot }) {
  const w = windows.get(win);
  return slot ? w?.slot : w?.prompt;
}

/**
 * The window whose chat shows the conversation that asks: its questions go to that window's
 * slot, not the line (docs/specs/builtin-agent.md Behaviour 27), one place at a time.
 * @param {import("../core/agent.mjs").ConnId} conn
 * @returns {Window | null}
 */
function slotWindow(conn) {
  for (const [win, w] of windows) {
    if (w.slot && w.slotConn?.() === conn && !lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      return win;
    }
  }
  return null;
}

/** @param {Window} win @param {Question} q @param {boolean} [slot] */
function open(win, q, slot = false) {
  const w = windows.get(win);
  const prompt = slot ? w?.slot : w?.prompt;
  if (!w || !prompt) return false;
  const line = questionLine(q, {
    grantMinutes: grantMinutes(),
    agentWorkspace: McpHost.workspaceName,
  });
  const shown = prompt.show(line, armMs());
  if (!shown) return false;
  current = { id: q.id, win, count: "", question: q, slot };
  if (slot) w.slotChanged?.();
  return true;
}

/** Back to waiting: the line or the slot closes, the question stays queued. */
function close() {
  if (!current) return;
  const was = current;
  promptOf(was)?.hide();
  current = null;
  if (was.slot) windows.get(was.win)?.slotChanged?.();
}

function redraw() {
  for (const w of windows.values()) w.emit();
}

/** Show, hide or wait for the oldest question; mark a window not in front once per question. */
function sync() {
  const waiting = AgentGate.waiting;
  const head = waiting[0] ?? null;
  for (const id of alerted) if (!waiting.some((q) => q.id === id)) alerted.delete(id);
  if (current && current.id !== head?.id) close();
  // A chat window opened or closed on the conversation that asks moves its question.
  const inSlot = head ? slotWindow(head.conn) : null;
  if (current && (current.slot ? current.win !== inSlot : !!inSlot)) close();
  if (head && !current && inSlot) open(inSlot, head, true);
  if (head && !current && !inSlot) {
    const win = askingWindow();
    const w = win && windows.get(win);
    if (win && w) {
      const focused = isFocused(win);
      const now = Date.now();
      if (
        mayOpenByItself({
          focused,
          inField: w.inField(),
          sinceKeyMs: now - (lastKey.get(win) ?? 0),
          otherOpen: w.otherOpen(),
          fullscreen: isFullscreen(win),
        })
      ) {
        open(win, head);
      } else if (!focused && !alerted.has(head.id)) {
        alerted.add(head.id);
        attention(win, head);
      }
    }
  }
  if (head && !current) {
    poll ??= lazy.setTimeout(() => {
      poll = null;
      sync();
    }, POLL_MS);
  }
  if (head) freeSince = 0;
  else freeSince ||= Date.now();
  if (held !== null) {
    heldTimer ??= lazy.setTimeout(showHeld, HELD_DELAY_MS);
  }
  if (AgentGate.grants().length) {
    tick ??= lazy.setTimeout(() => {
      tick = null;
      sync();
    }, TICK_MS);
  }
  redraw();
}

/**
 * The held notice, once no question has waited for HELD_DELAY_MS and no other notice is on
 * screen, so it never cuts short the notice of what an agent just did; until then, it tries
 * again.
 */
function showHeld() {
  heldTimer = null;
  if (held === null || AgentGate.waiting.length) return;
  const win = askingWindow();
  const w = win && windows.get(win);
  const wait = freeSince ? freeSince + HELD_DELAY_MS - Date.now() : HELD_DELAY_MS;
  if (!w || wait > 0 || w.noticeOpen()) {
    heldTimer = lazy.setTimeout(showHeld, Math.max(wait, POLL_MS));
    return;
  }
  w.notice(held, HELD_MS);
  held = null;
}

/**
 * Decision 15: the urgency hint, and a desktop notification with who and what, never a URL or
 * title, and no buttons (an approval outside Vimma's view and its arming delay).
 * @param {Window} win @param {Question} q
 */
function attention(win, q) {
  try {
    /** @type {any} */ (win).getAttention();
  } catch (e) {
    console.error("vimma agent: getAttention", e);
  }
  if (McpHost.config?.notify === false) return;
  try {
    const alert = Cc["@mozilla.org/alert-notification;1"].createInstance(Ci.nsIAlertNotification);
    alert.init(`vimma-agent-${q.id}`, "", "Vimma", agentAlertText(q), false);
    Cc["@mozilla.org/alerts-service;1"].getService(Ci.nsIAlertsService).showAlert(alert);
  } catch (e) {
    console.error("vimma agent: notification", e);
  }
}

/**
 * The notices for what the gate did (decisions 16, 20, 23), in the window that asks.
 * @param {GateEvent | undefined} event
 */
function onGate(event) {
  const win = current?.win ?? askingWindow();
  const w = win && windows.get(win);
  // A built-in conversation's steps under its grant are in its transcript, and its running
  // task in the status bar (docs/specs/builtin-agent.md Behaviour 12, 35): no notice for each.
  const quiet = event?.kind === "ran" && isBuiltinConn(event.conn);
  if (event && w && !quiet) {
    if (event.kind === "answered" && event.answer === "grant" && event.length) {
      w.notice(grantNotice(event.question, event.length, event.released ?? 0));
    } else if (
      event.kind === "answered" &&
      event.answer === "once" &&
      isCheckpoint(event.question)
    ) {
      // mcp-checkpoints Behaviour 6: where the form went, or where the payment was made.
      w.notice(checkpointNotice(event.question));
    } else if (event.kind === "answered" && event.answer === "deny") {
      w.notice(deniedNotice(event.question, "user"));
    } else if (event.kind === "answered" && event.answer === "mute") {
      w.notice(deniedNotice(event.question, "mute"));
    } else if (event.kind === "timeout") {
      w.notice(deniedNotice(event.question, "timeout"));
    } else if (event.kind === "ran") {
      w.notice(ranNotice(event, event.until, Date.now()));
    } else if (event.kind === "notice" && event.hold) {
      held = event.text;
    } else if (event.kind === "notice") {
      w.notice(event.text);
    }
  }
  if (event?.kind === "ran" || (event?.kind === "answered" && event.answer !== "deny")) {
    // `◇ agent ·` for RAN_MS, then back.
    lazy.setTimeout(redraw, RAN_MS + 50);
  }
  sync();
}

export const AgentUi = {
  /**
   * A browser window's prompt and what the host knows about it (VimmaHost.init).
   * @param {Window} win @param {AgentWindow} w
   */
  register(win, w) {
    windows.set(win, w);
    const rearm = (/** @type {Event} */ e) => onWindowChange(win, e);
    rearmers.set(win, rearm);
    for (const type of REARM_EVENTS) win.addEventListener(type, rearm, true);
    win.document.addEventListener("visibilitychange", rearm, true);
    if (!listening) {
      listening = true;
      AgentGate.addListener(onGate);
    }
  },

  /** @param {Window} win  closing (VimmaHost.uninit) */
  unregister(win) {
    const rearm = rearmers.get(win);
    if (rearm) {
      for (const type of REARM_EVENTS) win.removeEventListener(type, rearm, true);
      win.document.removeEventListener("visibilitychange", rearm, true);
    }
    if (current?.win === win) current = null;
    windows.get(win)?.prompt.destroy();
    windows.delete(win);
    if (!windows.size && listening) {
      listening = false;
      AgentGate.removeListener(onGate);
    }
    sync();
  },

  /**
   * Every keydown in `win`, before any binding: the open question's keys (consumed), or a
   * timestamp for the "no key for 1,500 ms" rule. Chords with ctrl, alt or meta go on to the
   * bindings. A held key never counts; nothing counts before the line is armed.
   * @param {Window} win @param {KeyboardEvent} e
   * @returns {boolean} whether the key was the question's
   */
  onKey(win, e) {
    lastKey.set(win, Date.now());
    if (!current || current.win !== win) return false;
    const w = windows.get(win);
    const prompt = promptOf(current);
    if (!w || !prompt?.isOpen) return false;
    // The slot takes keys only while focus is in its chat window (Behaviour 27).
    if (current.slot && !w.chatFocused?.()) return false;
    const chord = chordFromEvent(e);
    if (!chord) return false; // a bare modifier: shift for `Y`
    if (chord.ctrl || chord.alt || chord.meta) return false;
    // The rest of a sequence (the g of ctrl+b g) is the bindings' (security.md M4).
    if (w.pending()) return false;
    // Another prompt, picker or the command line opened over the line takes the keys; the line
    // goes back to waiting and comes back when it closes.
    if (!current.slot && w.otherOpen()) {
      close();
      sync();
      return false;
    }
    e.preventDefault();
    e.stopPropagation();
    // Not armed yet: the delay starts again, so typing on through the line never answers it.
    if (!prompt.armed) {
      prompt.rearm(armMs());
      return true;
    }
    if (e.repeat) return true;
    const q = current.question;
    const result = promptKey({ count: current.count }, formatKey(chord), {
      full: q.tool === FULL_CONTROL,
      noGrant: noGrant(q),
      dangerous: !!(/** @type {any} */ (q.what)?.danger),
    });
    if (result.kind === "count") {
      current.count = result.count;
      prompt.setCount(result.count);
    } else if (result.kind === "answer") {
      const { id } = current;
      close();
      AgentGate.answer(id, result.answer);
    }
    return true;
  },

  /**
   * Focus moved in `win`: into a field, the line goes back to waiting (decision 14), so what
   * is typed there is never an answer.
   * @param {Window} win
   */
  onFocusChange(win) {
    if (current?.win !== win || current.slot) return;
    if (windows.get(win)?.inField()) {
      close();
      sync();
    }
  },

  /**
   * `ctrl+b shift+a` (`mcp.answer`): the waiting question opens here, whatever the guards say;
   * with none, every grant ends at once (docs/specs/mcp-grants.md G4: ending is the safe
   * direction, so it takes no second key).
   * @param {Window} win
   */
  answer(win) {
    const w = windows.get(win);
    if (!w) return;
    if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      w.notice("agent requests are answered in a normal window");
      return;
    }
    const head = AgentGate.waiting[0];
    if (head) {
      // Its conversation's chat window shows it: it is answered there (Behaviour 27).
      if (current?.slot) {
        windows.get(current.win)?.focusChat?.();
        return;
      }
      if (current?.win === win) return;
      close();
      if (!open(win, head)) w.notice("agent request: leave full screen to answer it");
      redraw();
      return;
    }
    // The built-in agent's running tasks stop too (docs/specs/builtin-agent.md Behaviour 16).
    lazy.AgentChat.stopAll();
    const ended = AgentGate.revoke();
    w.notice(
      ended
        ? `mcp: ended ${ended} agent grant${ended === 1 ? "" : "s"}`
        : "no agent requests waiting and no grants",
    );
  },

  /**
   * The status bar's agent segment (decision 24), or null, with the built-in agent's running
   * tasks (docs/specs/builtin-agent.md Behaviour 35).
   */
  status() {
    const state = agentState({
      connections: AgentGate.connections.length,
      waiting: AgentGate.waiting.length,
      grants: AgentGate.grants(),
      ranAt: AgentGate.ranAt,
      now: Date.now(),
    });
    if (!state) return null;
    const running = lazy.AgentChat.list().filter((/** @type {any} */ c) => c.running && c.budget);
    return { ...state, builtin: builtinStatus(running.map((/** @type {any} */ c) => c.budget)) };
  },

  /** A chat window opened, closed or switched conversation: its question may move. */
  refresh() {
    sync();
  },

  /**
   * The window that asks and shows the notices: where the user answers (mcp-drive D6 names
   * another window that a show switched).
   * @returns {Window | null}
   */
  askingWindow() {
    return askingWindow();
  },

  /** Test-only: the question on screen. */
  get _current() {
    return current;
  },
};
