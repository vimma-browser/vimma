/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// `:control on <minutes>` and `:control off` (docs/specs/vimma-mcp.md decision 29 D): full
// control (the control socket's `full` role, `vimma.control.enabled`) for a while. The end time
// is a pref, so a restart inside the window keeps it and one after it turns control off at
// startup. Turning control on in about:config sets no end time and is left alone.

import {
  controlEnd,
  controlOnQuestion,
  controlStatus,
  parseControlCommand,
} from "../core/agent-prompt.mjs";

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

export const CONTROL_ENABLED_PREF = "vimma.control.enabled";
/**
 * When `:control on <minutes>` ends: ms since the epoch, as a string (no 2038 limit); absent:
 * no end. Anything else turns control off (security.md S13; core controlEnd).
 */
export const CONTROL_UNTIL_PREF = "vimma.control.enabledUntilMs";

let timer = /** @type {any} */ (null);
let watching = false;

/** The end time, read back: none, off (passed or not a valid one), or until when. */
function end() {
  const raw = Services.prefs.prefHasUserValue(CONTROL_UNTIL_PREF)
    ? Services.prefs.getStringPref(CONTROL_UNTIL_PREF, "")
    : undefined;
  return controlEnd(raw, Date.now());
}

/** The end time in ms, or null. */
function untilMs() {
  const e = end();
  return e.kind === "until" ? e.until : null;
}

/** Off now, and the end time gone. */
function turnOff() {
  if (timer) lazy.clearTimeout(timer);
  timer = null;
  Services.prefs.clearUserPref(CONTROL_UNTIL_PREF);
  Services.prefs.setBoolPref(CONTROL_ENABLED_PREF, false);
}

/** Arm the timer for the end time, or end it now when it has passed. */
function arm() {
  if (timer) lazy.clearTimeout(timer);
  timer = null;
  const e = end();
  if (e.kind === "none") return;
  if (!Services.prefs.getBoolPref(CONTROL_ENABLED_PREF, false)) {
    Services.prefs.clearUserPref(CONTROL_UNTIL_PREF);
    return;
  }
  if (e.kind === "off") {
    turnOff();
    return;
  }
  const left = e.until - Date.now();
  // Timers past 2^31 ms overflow; 1440 minutes is far below that.
  timer = lazy.setTimeout(arm, Math.min(left, 60 * 60 * 1000));
}

export const ControlHost = {
  /** At startup (vimma.js) and in tests: an end time in the past turns control off. */
  init() {
    if (!watching) {
      watching = true;
      Services.prefs.addObserver(CONTROL_UNTIL_PREF, arm);
      Services.prefs.addObserver(CONTROL_ENABLED_PREF, arm);
    }
    arm();
  },

  /** Full control's state, for `:control`, `:mcp` and about:vimma. */
  status() {
    return controlStatus({
      enabled: Services.prefs.getBoolPref(CONTROL_ENABLED_PREF, false),
      until: untilMs(),
      now: Date.now(),
    });
  },

  /**
   * `:control [on <minutes> | off]`: the notice's text, or null while its y/N is open.
   * @param {string | undefined} text
   * @param {(question: string, yes: () => void) => void} ask
   * @param {(text: string) => void} say  after the answer
   * @param {() => string | null} [agentWorkspace]  while MCP is on, the agent workspace's name,
   *   which the question says full control reaches beyond (mcp-drive D22); null while it is off
   * @returns {string | null}
   */
  run(text, ask, say, agentWorkspace = () => null) {
    const command = parseControlCommand(text);
    switch (command.kind) {
      case "refuse":
        return command.text;
      case "status":
        return this.status();
      case "off":
        turnOff();
        return "full control off";
      case "on": {
        const { minutes } = command;
        const asked = agentWorkspace();
        ask(controlOnQuestion(minutes, asked), () => {
          // MCP went on or off while it asked: the yes was to a question that no longer says
          // what full control reaches (mcp-drive D22).
          if (agentWorkspace() !== asked) {
            say(
              "full control stays off: agents were turned on or off meanwhile; run :control on again",
            );
            return;
          }
          // On first: the end time's observer clears an end time while control is off.
          Services.prefs.setBoolPref(CONTROL_ENABLED_PREF, true);
          Services.prefs.setStringPref(CONTROL_UNTIL_PREF, String(Date.now() + minutes * 60_000));
          arm();
          say(this.status());
        });
        return null;
      }
    }
    return null;
  },
};
