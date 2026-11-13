/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The bindings waiting for the page to leave their key alone (docs/specs/firefox-keys.md
 * decision 6). A page-first binding's keydown goes to the page; it runs on the keypress after
 * the page had it, unless the page called preventDefault. A keypress sent to a remote page
 * runs on that page's reply.
 *
 * A reply is paired with its press by the key and the keypress's timeStamp, which the reply
 * keeps (BrowserChild::RecvRealKeyEvent sends back a copy of the event it got). A page that
 * takes the keydown gets no keypress and sends no reply, so pairing by key alone would give
 * that press the next reply on the key, with its own mode and result.
 */

/** @import { Mode } from "./modes.mjs" */

/**
 * @template R
 * @typedef {{ key: string, result: R, mode: Mode, pressed: boolean,
 *   awaiting: boolean, stamp: number | null }} PageFirstEntry
 */

/** The most page-first keys kept waiting (a page that never replies cannot grow the queue). */
export const PAGE_FIRST_MAX = 16;

/** @template R */
export class PageFirstQueue {
  constructor() {
    /** @type {PageFirstEntry<R>[]} oldest first: keys typed fast each wait for their own reply */
    this.entries = [];
  }

  get size() {
    return this.entries.length;
  }

  /**
   * A new keydown: a binding whose keypress never came (the page took the keydown) is dropped.
   * One whose keypress stayed in this process was settled during that keypress.
   */
  keydown() {
    this.entries = this.entries.filter((p) => p.awaiting);
  }

  /**
   * A page-first binding's keydown went to the page.
   * @param {string} key  canonical chord
   * @param {R} result
   * @param {Mode} mode  the mode the key was dispatched in
   */
  defer(key, result, mode) {
    this.entries.push({ key, result, mode, pressed: false, awaiting: false, stamp: null });
    if (this.entries.length > PAGE_FIRST_MAX) this.entries.shift();
  }

  /**
   * The keypress of a deferred binding, before the page. Returns whether to ask the remote page
   * for its reply. A keypress dispatched again at the browser (the page's process cannot take
   * input yet, EventStateManager::PostHandleKeyboardEvent) is sent no further: its press then
   * settles in this process, as `settle`.
   * @param {string} key
   * @param {number} stamp  the keypress's timeStamp
   * @param {boolean} remote  the keypress targets a remote browser
   */
  press(key, stamp, remote) {
    const pending = this.entries.find((p) => !p.pressed && p.key === key);
    if (!pending) {
      const sent = this.entries.find((p) => p.awaiting && p.key === key && p.stamp === stamp);
      if (sent && remote) sent.awaiting = false;
      return false;
    }
    pending.pressed = true;
    pending.stamp = stamp;
    pending.awaiting = remote;
    return remote;
  }

  /**
   * A remote page's reply: the press it answers, or null. A keypress Firefox's own shortcut
   * listener held back (GlobalKeyListener::HandleEventOnCaptureInSystemEventGroup) never came
   * to `press`; its reply settles the oldest unpressed binding on the key.
   * @param {string} key
   * @param {number} stamp  the reply's timeStamp, the keypress's
   * @returns {PageFirstEntry<R> | null}
   */
  reply(key, stamp) {
    let at = this.entries.findIndex((p) => p.awaiting && p.key === key && p.stamp === stamp);
    if (at === -1) at = this.entries.findIndex((p) => !p.pressed && p.key === key);
    if (at === -1) return null;
    return this.entries.splice(at, 1)[0] ?? null;
  }

  /**
   * The keypress after a parent-process page or a chrome field had it: the press `press` just
   * marked as staying in this process, or null.
   * @param {string} key
   * @returns {PageFirstEntry<R> | null}
   */
  settle(key) {
    const at = this.entries.findIndex((p) => p.pressed && !p.awaiting && p.key === key);
    if (at === -1) return null;
    return this.entries.splice(at, 1)[0] ?? null;
  }
}
