/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// about:vimma's last key events (spec: docs/specs/m5-about-vimma.md): the host records each key
// it dispatches, with what the dispatcher made of it; about:vimma reads them. One per app.
// Text typed in insert mode or on the command line is not kept: a plain key there is recorded
// as "·", so a password or a URL typed into a field never reaches the page or a `:bug` report.

import { describeOutcome } from "../core/report.mjs";
import { formatKey } from "../core/keys.mjs";

/** @import { Chord } from "../core/keys.mjs" */
/** @import { DispatchResult } from "../core/dispatcher.mjs" */

export const KEY_LOG_SIZE = 20;

/** @typedef {{ key: string, mode: string, outcome: string }} KeyEvent */

/** @type {KeyEvent[]} oldest first */
const events = [];

export const KeyLog = {
  /**
   * @param {string} mode  the mode the key was dispatched in
   * @param {Chord} chord
   * @param {DispatchResult} result
   */
  record(mode, chord, result) {
    const typed =
      (mode === "insert" || mode === "command") &&
      !chord.ctrl &&
      !chord.alt &&
      !chord.meta &&
      [...chord.key].length === 1;
    events.push({ key: typed ? "·" : formatKey(chord), mode, outcome: describeOutcome(result) });
    if (events.length > KEY_LOG_SIZE) events.shift();
  },

  /**
   * Something the host did on its own that explains what keys did next (the toolbar shown
   * again because the address bar could not be revealed, docs/specs/toolbar-toggle.md 13).
   * @param {string} text
   */
  note(text) {
    events.push({ key: "—", mode: "host", outcome: text });
    if (events.length > KEY_LOG_SIZE) events.shift();
  },

  /** @returns {KeyEvent[]} the last KEY_LOG_SIZE events, oldest first */
  entries() {
    return events.map((e) => ({ ...e }));
  },
};
