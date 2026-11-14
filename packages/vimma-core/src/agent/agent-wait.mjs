/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// How long an agent's step waits for the page (docs/specs/mcp-forms.md F11, F12; issue #579).
// The frame's child watches its document for changes and the requests the step started, and
// asks quietVerdict when the page counts as settled.

export const AGENT_WAITS = Object.freeze({
  /** A page that changed after a step counts as settled once it has not changed for this long. */
  quiet: 250,
  /**
   * How long a page that has changed nothing yet is waited for: a hidden tab's page timers fire
   * at most once a second (dom.min_background_timeout_value), and an agent's tab is hidden, so a
   * page that updates itself from a timer does so just after a second. A result saying nothing
   * changed when the page was about to is what made agents click twice (#510).
   */
  still: 1300,
  /** The most a step waits for its page to go quiet: one that never does (a ticker) is busy. */
  busy: 2000,
  /** A new page counts as ready once it has not changed for this long after DOMContentLoaded. */
  readyQuiet: 200,
  /** The most that wait after DOMContentLoaded lasts. */
  readyBusy: 1000,
});

/**
 * Whether a frame has settled: "quiet" once it has not changed for `quiet` ms since its last
 * change (or, with no change yet, for `still` ms) and no request the step started is still
 * open; "busy" when `max` ms have passed regardless; null to keep waiting.
 * @param {{ elapsed: number, sinceChange: number | null, netBusy: boolean }} now
 *   `elapsed`: ms since the wait began; `sinceChange`: ms since the last change, null for none
 * @param {{ quiet: number, still: number, max: number }} limits
 * @returns {"quiet" | "busy" | null}
 */
export function quietVerdict({ elapsed, sinceChange, netBusy }, { quiet, still, max }) {
  if (!Number.isFinite(elapsed) || elapsed >= max) return "busy";
  if (netBusy) return null;
  if (sinceChange === null) return elapsed >= still ? "quiet" : null;
  return sinceChange >= quiet ? "quiet" : null;
}
