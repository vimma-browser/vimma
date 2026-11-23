/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The agent's submission blocker and step counts (docs/specs/mcp-forms.md F16; security.md M28;
// issue #1028): the marks of the tabs an agent stepped in, and the http-on-opening-request
// observer that cancels a submission the user was not asked about. One instance per parent
// process: import this module only by its relative path, so that every importer shares the
// marks with the one observer.

/** @import { HintTarget } from "./VimmaActors.sys.mjs" */

/**
 * Agent tabs an agent just stepped in (docs/specs/mcp-forms.md F16; security.md M28), by their
 * browserId, which survives a move to another window: the top document of the step, the one
 * submission a question allowed during the running call (its method and destination without
 * query), and the hosts of the submissions stopped since the step began.
 * @type {Map<number, { doc: number, allowed: { method: string, where: string } | null,
 *   blocked: string[] }>}
 */
const submitMarks = new Map();
/** @type {typeof onRequest | null} */
let submitObserver = null;

/** The number of the agent's last click or submission sent to a child (`nextStep`). */
let stepCount = 0;
/**
 * The agent's last click or submission sent to each frame's document, by its window global:
 * its element and its number, which the child says back if it skips it (issue #1028).
 * @type {WeakMap<WindowGlobalParent, { gen: number, id: number, step: number }>}
 */
const sentSteps = new WeakMap();
/**
 * The number of the last step each frame's document said it skipped (`Vimma:AgentSkipped`), by
 * its window global: once the page has gone, its child can no longer be asked how the step went
 * (issue #1028).
 * @type {WeakMap<WindowGlobalParent, number>}
 */
const skippedSteps = new WeakMap();

/**
 * A new number for the agent's click or submission on `target`, kept as that document's last
 * step: a skip said for an earlier one, however late, is not this one's.
 * @param {HintTarget} target
 */
export function nextStep(target) {
  const step = ++stepCount;
  sentSteps.set(target.wg, { gen: target.gen, id: target.id, step });
  return step;
}

/**
 * Whether the child of `target`'s document said it skipped the last step sent there, and that
 * step was on `target`. Read at the moment of asking: the message can arrive while the parent
 * waits on the child (agentClickOutcome).
 * @param {HintTarget} target
 */
export function saidSkipped(target) {
  const sent = sentSteps.get(target.wg);
  return (
    !!sent &&
    sent.gen === target.gen &&
    sent.id === target.id &&
    skippedSteps.get(target.wg) === sent.step
  );
}

/** A URI's destination as a submission is compared: scheme, host, port and path. @param {nsIURI} uri */
export const whereOf = (uri) => `${uri.prePath}${uri.filePath}`;

/**
 * Every navigating form submission's request passes here, in the parent, whatever started it
 * (a submit button, `requestSubmit`, a later `submit()`, any frame): in a tab an agent stepped
 * in, while its page is the one of the step, a submission without the user's activation is
 * cancelled unless it is the one the question allowed, to the method and destination it named.
 * The request carries its document's transient user activation, which an agent's click never
 * gives, so a submission with it is the user's, and it ends the mark.
 * Checked as the parent opens the request, in the order the page's process started the
 * submissions (issue #1484): `http-on-modify-request` comes only after the proxy lookup and
 * other checks off the main thread, so a page's submission started before the last field could
 * reach it after the allowance for the asked one opened, and be sent in its place.
 * @param {unknown} subject  an nsISupports
 */
function onRequest(subject) {
  let channel;
  try {
    // QueryInterface gives the object as the interface asked or throws, as a subject without it
    // does: either way the catch below.
    const qi = /** @type {{ QueryInterface(iid: unknown): nsIHttpChannel }} */ (subject);
    channel = qi.QueryInterface(Ci.nsIHttpChannel);
  } catch {
    return;
  }
  const info = channel.loadInfo;
  if (!info?.isFormSubmission) return;
  const top = info.browsingContext?.top;
  const id = top?.browserId;
  const mark = id ? submitMarks.get(id) : undefined;
  if (!top || !id || !mark) return;
  if (top.currentWindowGlobal?.innerWindowId !== mark.doc || info.hasValidUserGestureActivation) {
    forgetMark(id);
    return;
  }
  // A redirect of a submission that was let through (the allowed one, or the user's): its first
  // request was checked here, and the server has already received it.
  if (info.redirectChainIncludingInternalRedirects?.length) return;
  const uri = channel.URI;
  const allowed = mark.allowed;
  if (
    allowed &&
    allowed.method === String(channel.requestMethod).toLowerCase() &&
    allowed.where === whereOf(uri)
  ) {
    mark.allowed = null;
    return;
  }
  channel.cancel(Cr.NS_BINDING_ABORTED);
  let host = "";
  try {
    host = String(uri.asciiHost);
  } catch {
    // no host to name
  }
  if (host && mark.blocked.length < 16) mark.blocked.push(host);
}

/** The mark of the tab of `browser`, if any. @param {MozBrowser | null | undefined} browser */
export function markOf(browser) {
  const id = browser?.browsingContext?.browserId;
  return id === undefined ? undefined : submitMarks.get(id);
}

/** @param {number} id  a browserId whose mark ends; the observer goes with the last mark */
export function forgetMark(id) {
  submitMarks.delete(id);
  if (!submitMarks.size && submitObserver) {
    Services.obs.removeObserver(submitObserver, "http-on-opening-request");
    submitObserver = null;
  }
}

/**
 * Marks the tab of `top` at its document `doc` (AgentActors.agentMark, once every frame's
 * activation is consumed), allowing `allowed`, the one submission the question named, if any.
 * @param {CanonicalBrowsingContext} top
 * @param {number} doc  its top document's innerWindowId
 * @param {{ method: string, action: string } | null} allowed
 */
export function setMark(top, doc, allowed) {
  // Marks of tabs that closed or moved to another page are dropped here.
  for (const [id, mark] of submitMarks) {
    const other = BrowsingContext.getCurrentTopByBrowserId(id);
    if (other?.currentWindowGlobal?.innerWindowId !== mark.doc) submitMarks.delete(id);
  }
  if (!submitObserver) {
    submitObserver = onRequest;
    Services.obs.addObserver(submitObserver, "http-on-opening-request");
  }
  let where = null;
  if (allowed) {
    try {
      where = whereOf(Services.io.newURI(allowed.action));
    } catch {
      // not a URL: nothing is allowed
    }
  }
  submitMarks.set(top.browserId, {
    doc,
    allowed: allowed && where ? { method: allowed.method, where } : null,
    blocked: [],
  });
}

/**
 * The child of `wg` skipped a step (AgentActors.agentSkipped): the allowed submission of its tab
 * is withdrawn, and the step's number kept for that document when it is the last one sent there.
 * @param {CanonicalBrowsingContext | null | undefined} bc
 * @param {WindowGlobalParent | null} wg
 * @param {unknown} data
 */
export function noteSkipped(bc, wg, data) {
  const id = bc?.top?.browserId;
  const mark = id ? submitMarks.get(id) : undefined;
  if (mark) mark.allowed = null;
  // Kept only for the last step sent there: a late skip of an earlier one changes nothing.
  const step = data && typeof data === "object" && "step" in data ? data.step : undefined;
  if (wg && typeof step === "number" && step === sentSteps.get(wg)?.step) {
    skippedSteps.set(wg, step);
  }
}
