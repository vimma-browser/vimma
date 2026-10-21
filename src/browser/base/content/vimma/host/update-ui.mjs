/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// How an update offer reaches the user (docs/specs/update-notices.md), after VimmaUpdates found
// it. The first time a version is offered, a message shows for a few seconds in the focused
// window, once per version (vimma.update.announced). A security update also asks, once per
// session and per version, `Show the update command? (y/N)` on a question line built as the
// agent question's (ui/agent-prompt.mjs): it opens by itself only in a focused normal window,
// out of fields, after 1,500 ms without a key and with nothing else open (core
// mayOpenByItself); it never takes focus; VimmaHost hands it the keys from its capture listener,
// and a key counts only once it is armed (security.dialog_enable_delay, as Firefox's security
// dialogs), so a key a page made the user press as it appeared never answers it.

import { mayOpenByItself } from "../core/agent-prompt.mjs";
import { chordFromEvent, formatKey } from "../core/keys.mjs";
import {
  QUESTION_HINT,
  announcement,
  questionAnswer,
  securityQuestion,
  shouldAsk,
} from "../core/update-notices.mjs";
import { VimmaUpdates } from "../updates/VimmaUpdates.sys.mjs";

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/** The last version the message was shown for. */
export const ANNOUNCED_PREF = "vimma.update.announced";
/** Firefox's own arming delay for security dialogs (modules/libpref/init/all.js). */
const ARMING_PREF = "security.dialog_enable_delay";
/** How long the message stays: long enough to read, short enough not to linger. */
export const ANNOUNCE_MS = 6000;
/** How often a waiting message or question checks whether it may show now, with a Vimma window
 * focused; slower while none is, so a session spent in another application costs few wakeups. */
const POLL_MS = 500;
const POLL_AWAY_MS = 5000;
/** Window events after which the line must arm again, as the agent question's. */
const REARM_EVENTS = ["activate", "deactivate", "focus", "blur"];

/**
 * What the host tells the update notices about one window.
 * @typedef {object} UpdateWindow
 * @property {import("../ui/agent-prompt.mjs").AgentPrompt} prompt  the question line
 * @property {() => boolean} inField  focus is in an editable field (insert mode)
 * @property {() => boolean} otherOpen  a picker, prompt, panel, the command line or the agent
 *   question is open
 * @property {() => boolean} pending  a key sequence is under way (after ctrl+b)
 * @property {(text: string) => boolean} notice  the message; false when it cannot show (full
 *   screen)
 * @property {(text: string) => void} hideNotice  hides the notice if it shows `text`: the
 *   question says what the message said
 * @property {() => void} openSteps  what `:update` opens: about:vimma's Updates section
 */

/** @type {Map<Window, UpdateWindow>} */
const windows = new Map();
/** When each window last had a key, or came to the front. @type {WeakMap<Window, number>} */
const lastKey = new WeakMap();
/** @type {WeakMap<Window, (e: Event) => void>} */
const rearmers = new WeakMap();
/** The versions asked about in this session, answered either way. @type {string[]} */
let asked = [];
/** The question on screen. @type {{ win: Window, version: string } | null} */
let current = null;
let poll = /** @type {any} */ (null);
/** The delay of the pending poll. */
let pollMs = POLL_MS;
let listening = false;
/** @type {(() => boolean) | null} */
let removeListener = null;

const armMs = () => Services.prefs.getIntPref(ARMING_PREF, 1000);

/** @param {Window} win */
const isFocused = (win) => /** @type {any} */ (Services.focus).activeWindow === win;

/** @param {Window} win */
const isPrivate = (win) => lazy.PrivateBrowsingUtils.isWindowPrivate(win);

/** @param {Window} win */
const isFullscreen = (win) => win.document.documentElement.hasAttribute("inDOMFullscreen");

/** The focused browser window Vimma runs in, if any. */
function focusedWindow() {
  const top = Services.wm.getMostRecentWindow("navigator:browser");
  return top && windows.has(top) && isFocused(top) ? top : null;
}

function offerState() {
  const status = VimmaUpdates.status();
  return {
    enabled: status.enabled,
    offer: status.offer,
    installType: VimmaUpdates.installType,
    stage: status.stage,
  };
}

/** The last message shown, so the question hides that one and no other notice. */
let lastMessage = "";

/** The message for a version not announced yet, in the focused window; true while one waits. */
function announce() {
  const { enabled, offer, installType, stage } = offerState();
  if (!installType || !offer) return false;
  const announced = Services.prefs.getStringPref(ANNOUNCED_PREF, "");
  const text = announcement({ enabled, installType, offer, announced, stage });
  if (!text) return false;
  const win = focusedWindow();
  const w = win && windows.get(win);
  if (!w || !w.notice(text)) return true;
  lastMessage = text;
  Services.prefs.setStringPref(ANNOUNCED_PREF, offer.displayVersion);
  return false;
}

/** @param {Window} win @param {string} version @param {string} question */
function open(win, version, question) {
  const w = windows.get(win);
  if (!w) return false;
  const line = { parts: [{ text: question }], hint: QUESTION_HINT, label: question };
  if (!w.prompt.show(line, armMs())) return false;
  if (lastMessage) w.hideNotice(lastMessage);
  current = { win, version };
  return true;
}

/** Back to waiting: the line closes, the question stays due. */
function close() {
  if (!current) return;
  windows.get(current.win)?.prompt.hide();
  current = null;
}

/** The question when it is due and may open; true while it waits. */
function ask() {
  const { enabled, offer, installType, stage } = offerState();
  /** @param {boolean} privateWindow */
  const due = (privateWindow) =>
    !!installType && shouldAsk({ enabled, installType, offer, asked, privateWindow, stage });
  if (!due(false) || !offer) {
    close();
    return false;
  }
  if (current?.version === offer.displayVersion) return false;
  close();
  // It waits for a focused normal window: never asked in a private one.
  const win = focusedWindow();
  if (!win || !due(isPrivate(win))) return true;
  const w = /** @type {UpdateWindow} */ (windows.get(win));
  const may = mayOpenByItself({
    focused: true,
    inField: w.inField(),
    sinceKeyMs: Date.now() - (lastKey.get(win) ?? 0),
    otherOpen: w.otherOpen(),
    fullscreen: isFullscreen(win),
  });
  return !(may && open(win, offer.displayVersion, securityQuestion(offer)));
}

/** Shows what is due and may show; looks again shortly while something waits. */
function sync() {
  let waiting = false;
  try {
    waiting = [announce(), ask()].some(Boolean);
  } catch (e) {
    // A pref of the wrong type (an about:config edit) must not break the window it runs in.
    console.error("vimma: update notices", e);
  }
  if (!waiting || !windows.size) return;
  const ms = focusedWindow() ? POLL_MS : POLL_AWAY_MS;
  // A window came to the front during a slow wait: look again soon, not 5 s later.
  if (poll && ms < pollMs) {
    lazy.clearTimeout(poll);
    poll = null;
  }
  pollMs = ms;
  poll ??= lazy.setTimeout(() => {
    poll = null;
    sync();
  }, ms);
}

/**
 * The window came to the front or left it: it counts as one being typed in (no question for
 * 1.5 s), and an open line arms again, so a key meant for another window never answers it.
 * @param {Window} win @param {Event} e
 */
function onWindowChange(win, e) {
  if ((e.type === "focus" || e.type === "blur") && e.target !== win) return;
  lastKey.set(win, Date.now());
  if (current?.win === win) windows.get(win)?.prompt.rearm(armMs());
  // A window come to the front may now show what waits, without waiting for the slow poll.
  else if (e.type === "activate") sync();
}

export const UpdateUi = {
  /**
   * A browser window and what the host knows about it (VimmaHost.init).
   * @param {Window} win @param {UpdateWindow} w
   */
  register(win, w) {
    windows.set(win, w);
    const rearm = (/** @type {Event} */ e) => onWindowChange(win, e);
    rearmers.set(win, rearm);
    for (const type of REARM_EVENTS) win.addEventListener(type, rearm, true);
    if (!listening) {
      listening = true;
      removeListener = VimmaUpdates.addListener(sync);
    }
    sync();
  },

  /** @param {Window} win  closing (VimmaHost.uninit) */
  unregister(win) {
    const rearm = rearmers.get(win);
    if (rearm) for (const type of REARM_EVENTS) win.removeEventListener(type, rearm, true);
    const wasAsking = current?.win === win;
    if (wasAsking) current = null;
    windows.get(win)?.prompt.destroy();
    windows.delete(win);
    // The question goes on to the window left in front.
    if (wasAsking && windows.size) sync();
    if (!windows.size) {
      listening = false;
      removeListener?.();
      removeListener = null;
      lazy.clearTimeout(poll);
      poll = null;
    }
  },

  /**
   * Every keydown in `win`, before any binding: the open question's keys (consumed), or a
   * timestamp for the "no key for 1,500 ms" rule. Chords with ctrl, alt or meta go on to the
   * bindings. Nothing counts before the line is armed, and a held key never does.
   * @param {Window} win @param {KeyboardEvent} e
   * @returns {boolean} whether the key was the question's
   */
  onKey(win, e) {
    lastKey.set(win, Date.now());
    if (!current || current.win !== win) return false;
    const w = windows.get(win);
    if (!w?.prompt.isOpen) return false;
    const chord = chordFromEvent(e);
    if (!chord) return false; // a bare modifier: shift for `Y`
    if (chord.ctrl || chord.alt || chord.meta) return false;
    if (w.pending()) return false;
    // Something opened over the line, focus went into a field (a page's focus report can come
    // after the key), or the page went full screen (which hides the line): the key is not the
    // question's, and the question comes back when it may.
    if (w.otherOpen() || w.inField() || isFullscreen(win)) {
      close();
      sync();
      return false;
    }
    e.preventDefault();
    e.stopPropagation();
    // Not armed yet: the delay starts again, so typing on through the line never answers it.
    if (!w.prompt.armed) {
      w.prompt.rearm(armMs());
      return true;
    }
    if (e.repeat) return true;
    const { version } = current;
    close();
    asked.push(version);
    if (questionAnswer(formatKey(chord)) === "yes") w.openSteps();
    return true;
  },

  /**
   * Focus moved in `win`: into a field, the line goes back to waiting, so what is typed there
   * is the field's.
   * @param {Window} win
   */
  onFocusChange(win) {
    if (current?.win !== win) return;
    if (windows.get(win)?.inField()) {
      close();
      sync();
    }
  },

  /** Whether the question line is open in `win`. @param {Window} win */
  isOpen(win) {
    return current?.win === win && !!windows.get(win)?.prompt.isOpen;
  },

  /** Test-only: look now whether something is due. */
  _sync() {
    sync();
  },

  /** Test-only: a new session, as after a restart: nothing asked, no question open. */
  _reset() {
    close();
    asked = [];
  },
};
