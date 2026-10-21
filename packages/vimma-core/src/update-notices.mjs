/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// How an update reaches the user without a modal window (docs/specs/update-notices.md): when a
// check is due, the one-time message for a new version, the once-per-session question for a
// security update, and the restart question once one is installed (m6a-updater Behaviour 6). Pure rules; the host (updates/VimmaUpdates.sys.mjs, host/update-ui.mjs)
// brings the clock, the prefs and the windows.

/** @import { InstallType, Offer } from "./updates.mjs" */

/** A failed attempt (host unreachable) is tried again after this, not at every start. */
export const CHECK_RETRY_MS = 600_000;
/** The shortest interval honoured: the timer that asks whether a check is due runs hourly. */
const MIN_INTERVAL_S = 3600;

/** What the question line shows once it takes keys. */
export const QUESTION_HINT = "y show · n or Esc: not this session";
/** What the restart question's line shows once it takes keys. */
export const RESTART_HINT = "y restart · n or Esc: not now";
/** An answered restart question is asked again after this, in a session that runs on
 * (m6a-updater decision 21): rare enough not to train a reflex `n`. */
export const RESTART_REASK_MS = 24 * 3_600_000;

/**
 * Whether a check is due: checks on, not a source build, and no successful check within the
 * interval (`app.update.interval`). A failed attempt does not count as a check, so a host that
 * was unreachable is tried again, but not sooner than CHECK_RETRY_MS after it, so restarting
 * Vimma in a loop sends no burst of requests. A last check in the future (the clock was set
 * back) makes one due, so a wrong clock never stops checks.
 * @param {{ enabled: boolean, installType: InstallType, okAt: number | null,
 *   triedAt: number | null, now: number, intervalSeconds: number }} input
 *   `okAt`: the last check that got a verified answer; `triedAt`: the last attempt of any kind
 */
export function checkDue({ enabled, installType, okAt, triedAt, now, intervalSeconds }) {
  if (!enabled || installType === "source") return false;
  if (triedAt !== null && triedAt <= now && now - triedAt < CHECK_RETRY_MS) return false;
  if (okAt === null || okAt > now) return true;
  return now - okAt >= Math.max(MIN_INTERVAL_S, intervalSeconds) * 1000;
}

/**
 * How far an AppImage got with replacing its own file (spec m6a-updater, decision 19): `none`
 * when it does not (another install type, or the replacement failed), `pending` while it
 * downloads, `staged` once the new file is in place.
 * @typedef {"none" | "pending" | "staged"} Stage
 */

/**
 * The one-time message for an offer whose version was not announced before, or null. An
 * AppImage that is replacing its file waits until it is done, then says to restart.
 * @param {{ enabled: boolean, installType: InstallType, offer: Offer | null,
 *   announced: string, stage?: Stage }} input  `announced`: the last version announced (pref),
 *   "" for none
 * @returns {string | null}
 */
export function announcement({ enabled, installType, offer, announced, stage = "none" }) {
  if (!enabled || installType === "source" || !offer) return null;
  if (offer.displayVersion === announced || stage === "pending") return null;
  const what = offer.urgent ? "fixes security issues" : "is available";
  if (stage === "staged") {
    const done = offer.urgent ? what : "is installed";
    return `Vimma ${offer.displayVersion} ${done} · restart Vimma to use it`;
  }
  return `Vimma ${offer.displayVersion} ${what} · :update shows the command`;
}

/**
 * Whether to ask the security question now: an urgent offer, a version not asked about in
 * this session, checks on, not a source build, and a normal window. An AppImage that replaces
 * its own file has no command to show.
 * @param {{ enabled: boolean, installType: InstallType, offer: Offer | null,
 *   asked: readonly string[], privateWindow: boolean, stage?: Stage }} input
 *   `asked`: the versions asked about in this session
 */
export function shouldAsk({ enabled, installType, offer, asked, privateWindow, stage = "none" }) {
  if (!enabled || installType === "source" || privateWindow || stage !== "none") return false;
  return !!offer?.urgent && !asked.includes(offer.displayVersion);
}

/**
 * Whether to ask the restart question now (m6a-updater Behaviour 6): an urgent update already
 * in place (`staged`), checks on, not a source build, a normal window, and the version not
 * answered in this session, or answered at least RESTART_REASK_MS ago. An answer time in the
 * future (the clock was set back) asks again, so a wrong clock never silences it.
 * @param {{ enabled: boolean, installType: InstallType, offer: Offer | null, stage: Stage,
 *   dismissed: Readonly<Record<string, number>>, now: number, privateWindow: boolean }} input
 *   `dismissed`: when each version's question was answered in this session
 */
export function shouldAskRestart({
  enabled,
  installType,
  offer,
  stage,
  dismissed,
  now,
  privateWindow,
}) {
  if (!enabled || installType === "source" || privateWindow || stage !== "staged") return false;
  if (!offer?.urgent) return false;
  const at = dismissed[offer.displayVersion];
  if (at === undefined || !Object.hasOwn(dismissed, offer.displayVersion)) return true;
  return at > now || now - at >= RESTART_REASK_MS;
}

/**
 * The restart question. A restart closes the private workspace's tabs, which session restore
 * does not bring back, so it says so when there are any; when session restore brings no tab back
 * (core/restart.mjs restartKeepsTabs), it says that instead.
 * @param {Offer} offer @param {{ privateTabs: boolean, tabsKept: boolean }} loses
 */
export function restartQuestion(offer, { privateTabs, tabsKept }) {
  const what = !tabsKept
    ? "Tabs will not come back."
    : privateTabs
      ? "Tabs come back. Private tabs will close."
      : "Tabs come back.";
  return `Security update ${offer.displayVersion} is ready. Restart now? ${what} (y/N)`;
}

/** @param {Offer} offer */
export function securityQuestion(offer) {
  return `Vimma ${offer.displayVersion} fixes security issues. Show the update command? (y/N)`;
}

/**
 * A key as the question reads it (key notation, keys.mjs): `y` shows the steps; any other key
 * says no, as every `y/N` in Vimma.
 * @param {string} key
 * @returns {"yes" | "no"}
 */
export function questionAnswer(key) {
  return key === "y" || key === "Y" || key === "shift+y" ? "yes" : "no";
}
