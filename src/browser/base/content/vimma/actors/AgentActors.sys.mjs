/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Sends the agent's requests to the Vimma actor of a page's frames and checks their answers, for
// the agent commands of ctl/ (docs/specs/mcp-forms.md, mcp-checkpoints.md; security.md M26-M28).
// The actor pair itself is registered by VimmaActors.sys.mjs, which sends the host's requests.

import { parseActTarget, parseFillTarget } from "../core/agent-act.mjs";
import { parsePayInfo, parseSentFields } from "../core/agent-checkpoint.mjs";
import { ACTIVATE_CHANGES } from "../core/control.mjs";
import { actorFor } from "./actor-for.mjs";
import { markOf, nextStep, noteSkipped, saidSkipped, setMark, whereOf } from "./submit-marks.mjs";

/** @import { HintTarget } from "./VimmaActors.sys.mjs" */

// System modules have no timer globals; Firefox's actors import them the same way.
const { clearTimeout, setTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs",
);

export const AgentActors = {
  /**
   * Whether the element of a target from an agent's `vimma_elements` is still in its document
   * (docs/specs/mcp-forms.md F4): false when its frame shows another document, the page removed
   * or replaced it, or the frame did not answer.
   * @param {HintTarget} target
   * @returns {Promise<boolean>}
   */
  async agentElementAlive(target) {
    if (target.bc.currentWindowGlobal !== target.wg) return false;
    try {
      const reply = await actorFor(target.bc)?.sendQuery("Vimma:AgentElement", {
        op: "alive",
        gen: target.gen,
        id: target.id,
      });
      return reply === true;
    } catch {
      return false; // the frame navigated or its process went away
    }
  },

  /**
   * What the element of a target from an agent's `vimma_elements` is now, just before a click
   * (docs/specs/mcp-forms.md F4, F9, F10, F15), checked like any reply from a content process;
   * `{ alive: false }` when it is gone, its frame shows another document or did not answer.
   * @param {HintTarget} target
   * @returns {Promise<import("../core/agent-act.mjs").ActTarget | null>} null: a malformed reply
   */
  async agentInspect(target) {
    if (target.bc.currentWindowGlobal !== target.wg) return { alive: false };
    try {
      const raw = await actorFor(target.bc)?.sendQuery("Vimma:AgentElement", {
        op: "inspect",
        gen: target.gen,
        id: target.id,
      });
      return raw === undefined ? { alive: false } : parseActTarget(raw);
    } catch {
      return { alive: false }; // the frame navigated or its process went away
    }
  },

  /**
   * Clicks the element of a target from an agent's `vimma_elements` with the child's `click()`
   * (docs/specs/mcp-forms.md F8; security.md M26), once the child has seen it is still what the
   * user was asked about: a submit only when `submit`, to the method and destination it names,
   * and the same link. The child answers before it clicks, so a dialog the click opens never
   * holds the reply.
   * @param {HintTarget} target
   * @param {{ submit: { method: string, action: string } | null, href: string | null,
   *   until: number }} asked  `until`: ms since the epoch; the child clicks nothing later
   * @returns {Promise<"ok" | "gone" | "changed">}
   */
  async agentActivate(target, { submit, href, until }) {
    if (target.bc.currentWindowGlobal !== target.wg) return "gone";
    try {
      const reply = await actorFor(target.bc)?.sendQuery("Vimma:AgentElement", {
        op: "activate",
        gen: target.gen,
        id: target.id,
        step: nextStep(target),
        submit,
        href,
        until,
      });
      return reply === "ok" || reply === "changed" ? reply : "gone";
    } catch {
      return "gone";
    }
  },

  /**
   * An agent is about to act in the browser's page (docs/specs/mcp-forms.md F16; security.md
   * M28): from now until the user's own activation or another page, a form submission there is
   * cancelled, but for `allowed`, the one the question named, once, during this call. The
   * user's activation from before the step is consumed in every frame first, so that only their
   * input after it counts as theirs.
   * @param {MozBrowser} browser
   * @param {{ method: string, action: string } | null} allowed
   * @returns {Promise<boolean>} false when the page has no document to mark
   */
  async agentMark(browser, allowed) {
    const top = browser.browsingContext;
    const doc = top?.currentWindowGlobal?.innerWindowId ?? 0;
    if (!top || !doc) return false;
    /** @type {CanonicalBrowsingContext[]} */
    let contexts;
    try {
      contexts = top.getAllBrowsingContextsInSubtree();
    } catch {
      return false;
    }
    await Promise.all(
      contexts.map((bc) =>
        actorFor(bc)
          ?.sendQuery("Vimma:AgentElement", { op: "consume" })
          .catch(() => {}),
      ),
    );
    setMark(top, doc, allowed);
    return true;
  },

  /**
   * Opens the one submission a question allowed, on a tab already marked (docs/specs/
   * mcp-forms.md F15, F16): a fill marks the tab before its first field and allows the
   * submission only for its last step, so a page that submits the form while it is being
   * filled sends nothing in its place.
   * @param {MozBrowser} browser
   * @param {{ method: string, action: string }} allowed
   * @returns {boolean} false when the tab has no mark of this page
   */
  agentAllow(browser, allowed) {
    const mark = markOf(browser);
    const top = browser.browsingContext;
    if (!top || !mark || top.currentWindowGlobal?.innerWindowId !== mark.doc) return false;
    try {
      mark.allowed = { method: allowed.method, where: whereOf(Services.io.newURI(allowed.action)) };
    } catch {
      return false;
    }
    return true;
  },

  /**
   * The child skipped the agent's click or submission (VimmaParent, `Vimma:AgentSkipped`): the
   * submission the question allowed is withdrawn at once, before the call ends, so the page cannot
   * send it by itself (docs/specs/mcp-forms.md F16; security.md M28). The mark stays. The number
   * of the step it names is kept for that document alone (agentClickOutcome), only when it is the
   * last step sent there: a frame that sends a forged one can only make its own click read as
   * skipped, as its outcome reply already could.
   * @param {CanonicalBrowsingContext | null | undefined} bc  the frame that skipped it
   * @param {WindowGlobalParent | null} wg  its window global, the sender's own
   * @param {unknown} data  `{ gen, id, step }`: `step` is the number the parent sent it with
   */
  agentSkipped(bc, wg, data) {
    noteSkipped(bc, wg, data);
  },

  /**
   * The submission a question allowed is withdrawn before the call ends (security.md M28): a
   * step that started no load within a second has none of its own to make, and a page that
   * keeps the call's wait going must not keep the allowance open with it. The mark and the
   * hosts of the submissions stopped stay for the call's result.
   * @param {MozBrowser} browser
   */
  agentWithdraw(browser) {
    const mark = markOf(browser);
    if (mark) mark.allowed = null;
  },

  /**
   * The agent's call is over: the allowed submission is no longer allowed, and the hosts of the
   * submissions stopped since the mark are returned (the mark stays).
   * @param {MozBrowser} browser
   * @returns {string[]}
   */
  agentSettle(browser) {
    const mark = markOf(browser);
    if (!mark) return [];
    mark.allowed = null;
    const blocked = mark.blocked;
    mark.blocked = [];
    return blocked;
  },

  /**
   * Whether any frame of `browser` shows a sensitive field with a value in its viewport, just
   * before and just after an agent's screenshot is drawn (docs/specs/mcp-forms.md F21). Every
   * frame is asked in its own process: `shown` when one says so or fails; `unchecked` when a
   * frame has no actor (a data: or blob: document) or does not answer within `ms`, which refuses
   * too; else `clear`.
   * @param {MozBrowser} browser
   * @param {number} ms
   * @returns {Promise<"shown" | "unchecked" | "clear">}
   */
  async agentSensitiveShown(browser, ms) {
    const frames = browser.browsingContext?.getAllBrowsingContextsInSubtree() ?? [];
    /** @type {number | undefined} */
    let timer;
    /** @type {Promise<"late">} */
    const late = new Promise((resolve) => {
      timer = setTimeout(resolve, ms, "late");
    });
    try {
      const answers = await Promise.all(
        frames
          .filter((bc) => bc.currentWindowGlobal)
          .map(async (bc) => {
            const actor = actorFor(bc);
            if (!actor) return "unchecked";
            try {
              const r = await Promise.race([actor.sendQuery("Vimma:AgentSensitiveShown"), late]);
              if (r === "late") return "unchecked";
              return r === false ? "clear" : "shown";
            } catch {
              return "shown"; // the frame navigated or its process went away mid-check
            }
          }),
      );
      if (answers.includes("shown")) return "shown";
      return answers.includes("unchecked") ? "unchecked" : "clear";
    } finally {
      clearTimeout(timer);
    }
  },

  /**
   * Each frame's own script errors and console errors and warnings, for an agent's
   * `vimma_console` (docs/specs/mcp-forms.md F22, F24): the first `frames` frames are asked, each
   * in its own process, for its newest `max` entries after `since` and how many more it holds.
   * The answer is the child's, which the caller checks entry by entry. A frame that has no actor
   * (a data: or blob: document), fails or does not answer within `ms` answers nothing.
   * @param {MozBrowser} browser
   * @param {number} ms
   * @param {{ since: number, max: number, frames?: number }} ask
   * @returns {Promise<{ entries: unknown[], omitted: number }[]>}
   */
  async agentConsole(browser, ms, { since, max, frames: most = 100 }) {
    const frames = (browser.browsingContext?.getAllBrowsingContextsInSubtree() ?? []).slice(
      0,
      most,
    );
    /** @type {number | undefined} */
    let timer;
    /** @type {Promise<null>} */
    const late = new Promise((resolve) => {
      timer = setTimeout(resolve, ms, null);
    });
    try {
      return await Promise.all(
        frames.map(async (bc) => {
          const none = { entries: [], omitted: 0 };
          const actor = actorFor(bc);
          if (!actor) return none;
          try {
            const r = await Promise.race([
              actor.sendQuery("Vimma:AgentConsole", { since, max }),
              late,
            ]);
            if (!r || typeof r !== "object" || !("entries" in r)) return none;
            const { entries } = r;
            if (!Array.isArray(entries)) return none;
            const more = "omitted" in r ? r.omitted : undefined;
            const omitted = typeof more === "number" && Number.isSafeInteger(more) && more > 0;
            return { entries: entries.slice(0, max), omitted: omitted ? more : 0 };
          } catch {
            return none; // the frame navigated or its process went away
          }
        }),
      );
    } finally {
      clearTimeout(timer);
    }
  },

  /**
   * Whether the agent's last click on `target` ran, or was skipped because the page changed
   * the element under the mouse events (docs/specs/mcp-forms.md F8). A frame that went away ran
   * it (the click loaded a page), unless its child said it skipped it: the child skips a step
   * whose page is hidden before it runs, and says so as the page is hidden, ahead of the next
   * document over the same IPC channel (issue #1028).
   * @param {HintTarget} target
   * @returns {Promise<"clicked" | "skipped" | "pending">}
   */
  async agentClickOutcome(target) {
    const gone = () => (saidSkipped(target) ? "skipped" : "clicked");
    if (target.bc.currentWindowGlobal !== target.wg) return gone();
    try {
      const reply = await actorFor(target.bc)?.sendQuery("Vimma:AgentElement", {
        op: "outcome",
        gen: target.gen,
        id: target.id,
      });
      return reply === "skipped" || reply === "pending" ? reply : "clicked";
    } catch {
      // The frame went away mid-question: its skip, if it said one, arrived before this.
      return gone();
    }
  },

  /**
   * Whether the frame of `target` has a load under way, as its own process sees it (issue #579):
   * a load its page's handlers started reaches the parent's progress a moment later.
   * @param {HintTarget} target
   * @returns {Promise<boolean>}
   */
  async agentLoading(target) {
    if (target.bc.currentWindowGlobal !== target.wg) return true; // it navigated already
    try {
      const reply = await actorFor(target.bc)?.sendQuery("Vimma:AgentElement", { op: "loading" });
      return reply === true;
    } catch {
      return true; // the frame went away mid-question: a load took it
    }
  },

  /**
   * Waits in a frame's own process until its page has settled after an agent's step (issue
   * #579; docs/specs/mcp-forms.md F11): `ready`, from its DOMContentLoaded; `net`, until no
   * request the step started is open; then a quiet period, bounded (core AGENT_WAITS). The
   * answer is checked like any reply from a content process.
   * @param {CanonicalBrowsingContext | null} bc  none (a browser without a frame loader): null
   * @param {{ ready?: boolean, net?: boolean, quiet: number, still: number, max: number,
   *   until: number }} ask  `until`: ms since the epoch, past which the child stops waiting
   * @returns {Promise<{ settled: "quiet" | "busy", state: string } | null>} null: the frame
   *   has no actor, its document went away, or the reply was malformed
   */
  async agentQuiet(bc, ask) {
    const actor = actorFor(bc);
    if (!actor) return null;
    try {
      const r = await actor.sendQuery("Vimma:AgentQuiet", ask);
      if (!r || typeof r !== "object" || !("settled" in r) || !("state" in r)) return null;
      const { settled, state } = r;
      if (settled !== "quiet" && settled !== "busy") return null;
      if (state !== "loading" && state !== "interactive" && state !== "complete") return null;
      return { settled, state };
    } catch {
      return null; // the frame navigated or its process went away
    }
  },

  /**
   * Which parts of the page changed in place since the agent's last click on `target` (#510),
   * in core's fixed words (ACTIVATE_CHANGES), checked like any reply from a content process;
   * null when the frame has another document, did not watch that click, or answered wrongly.
   * @param {HintTarget} target
   * @returns {Promise<string[] | null>}
   */
  async agentChanges(target) {
    if (target.bc.currentWindowGlobal !== target.wg) return null;
    try {
      const reply = await actorFor(target.bc)?.sendQuery("Vimma:AgentElement", {
        op: "changes",
        gen: target.gen,
        id: target.id,
      });
      if (!Array.isArray(reply) || new Set(reply).size !== reply.length) return null;
      if (!reply.every((w) => ACTIVATE_CHANGES.includes(w))) return null;
      return ACTIVATE_CHANGES.filter((w) => reply.includes(w));
    } catch {
      return null;
    }
  },

  /**
   * What the field of a target from an agent's `vimma_elements` is now, for a fill with `value`
   * (docs/specs/mcp-forms.md F4, F6, F12, F13), checked like any reply from a content process;
   * `{ alive: false }` when it is gone, its frame shows another document or did not answer.
   * @param {HintTarget} target @param {string | boolean} value
   * @returns {Promise<import("../core/agent-act.mjs").FillTarget | null>} null: a malformed reply
   */
  async agentInspectFill(target, value) {
    if (target.bc.currentWindowGlobal !== target.wg) return { alive: false };
    try {
      const raw = await actorFor(target.bc)?.sendQuery("Vimma:AgentElement", {
        op: "inspect-fill",
        gen: target.gen,
        id: target.id,
        value,
      });
      return raw === undefined ? { alive: false } : parseFillTarget(raw);
    } catch {
      return { alive: false };
    }
  },

  /**
   * Sets the field of a target from an agent's `vimma_elements` to `value` (docs/specs/
   * mcp-forms.md F12; security.md M27), once the child has seen it is still what the user was
   * asked about and not sensitive. The child answers before it sets the field, so a dialog the
   * page opens never holds the reply; `agentFillOutcome` says how it went.
   * @param {HintTarget} target
   * @param {{ value: string | boolean, expect: { field: string, type: string | null },
   *   until: number }} asked  `until`: ms since the epoch; the child sets nothing later
   * @returns {Promise<"ok" | "gone" | "changed">}
   */
  async agentFill(target, { value, expect, until }) {
    if (target.bc.currentWindowGlobal !== target.wg) return "gone";
    try {
      const reply = await actorFor(target.bc)?.sendQuery("Vimma:AgentElement", {
        op: "fill",
        gen: target.gen,
        id: target.id,
        value,
        expect,
        until,
      });
      return reply === "ok" || reply === "changed" ? reply : "gone";
    } catch {
      return "gone";
    }
  },

  /**
   * How the agent's last fill of `target`'s field went (docs/specs/mcp-forms.md F12): still to
   * run, the field kept its value, the page put it back, or it was skipped because the field
   * changed. A frame that went away is `gone`.
   * @param {HintTarget} target
   * @returns {Promise<"pending" | "kept" | "reset" | "skipped" | "gone">}
   */
  async agentFillOutcome(target) {
    if (target.bc.currentWindowGlobal !== target.wg) return "gone";
    try {
      const reply = await actorFor(target.bc)?.sendQuery("Vimma:AgentElement", {
        op: "fill-outcome",
        gen: target.gen,
        id: target.id,
      });
      return reply === "pending" || reply === "kept" || reply === "reset" || reply === "skipped"
        ? reply
        : "gone";
    } catch {
      return "gone";
    }
  },

  /**
   * Submits the form of `target`'s field with its default button (docs/specs/mcp-forms.md F15;
   * security.md M28), once the child has seen that it still goes to the method and destination
   * the question named; the child answers before it submits.
   * @param {HintTarget} target
   * @param {{ submit: { method: string, action: string }, until: number }} asked
   * @returns {Promise<"ok" | "gone" | "changed">}
   */
  async agentSubmit(target, { submit, until }) {
    if (target.bc.currentWindowGlobal !== target.wg) return "gone";
    try {
      const reply = await actorFor(target.bc)?.sendQuery("Vimma:AgentElement", {
        op: "submit",
        gen: target.gen,
        id: target.id,
        step: nextStep(target),
        submit,
        until,
      });
      return reply === "ok" || reply === "changed" ? reply : "gone";
    } catch {
      return "gone";
    }
  },

  /**
   * Whether any frame of `browser` shows a payment card field (docs/specs/mcp-checkpoints.md C6),
   * payment providers' frames of other sites included: each frame answers in its own process.
   * A frame that fails or does not answer within `ms` counts as one, so that a doubt asks; one
   * that navigated away mid-check, or has no actor (a data: or blob: document), does not.
   * @param {MozBrowser} browser
   * @param {number} ms
   * @returns {Promise<boolean>}
   */
  async agentCards(browser, ms) {
    const frames = browser.browsingContext?.getAllBrowsingContextsInSubtree() ?? [];
    /** @type {number | undefined} */
    let timer;
    /** @type {Promise<"late">} */
    const late = new Promise((resolve) => {
      timer = setTimeout(resolve, ms, "late");
    });
    try {
      const answers = await Promise.all(
        frames
          .filter((bc) => bc.currentWindowGlobal)
          .map(async (bc) => {
            const actor = actorFor(bc);
            if (!actor) return false;
            try {
              const r = await Promise.race([actor.sendQuery("Vimma:AgentCards"), late]);
              return r !== false;
            } catch {
              return false; // the frame navigated or its process went away
            }
          }),
      );
      return answers.includes(true);
    } finally {
      clearTimeout(timer);
    }
  },

  /**
   * What a payment's question needs of the control an agent's step presses (docs/specs/
   * mcp-checkpoints.md C6, C7): its words and the total the page states before it, checked like
   * any reply from a content process; null when it is gone or the reply is malformed.
   * @param {HintTarget} target  an element of the agent's `vimma_elements`
   * @param {"click" | "form"} by  `form`: its form's default button is pressed
   * @returns {Promise<{ texts: string[], total?: string } | null>}
   */
  async agentPayInfo(target, by) {
    if (target.bc.currentWindowGlobal !== target.wg) return null;
    try {
      const raw = await actorFor(target.bc)?.sendQuery("Vimma:AgentElement", {
        op: "pay",
        gen: target.gen,
        id: target.id,
        by,
      });
      return parsePayInfo(raw);
    } catch {
      return null;
    }
  },

  /**
   * The total the top page of `browser` states last (docs/specs/mcp-checkpoints.md C7), for a
   * key step, which presses no control; null when none, or the reply is malformed.
   * @param {MozBrowser} browser
   * @returns {Promise<string | null>}
   */
  async agentPageTotal(browser) {
    try {
      const raw = await actorFor(browser.browsingContext)?.sendQuery("Vimma:AgentTotal");
      return parsePayInfo({ texts: [], total: raw ?? undefined })?.total ?? null;
    } catch {
      return null;
    }
  },

  /**
   * What a submission by the control an agent's step presses sends (docs/specs/
   * mcp-checkpoints.md Behaviour 4): the form's fields by name and value, no sensitive value,
   * hidden ones counted, but for `skip`, the fields of that frame's list the same call fills.
   * Checked like any reply from a content process; null when it is gone or malformed.
   * @param {HintTarget} target @param {"click" | "form"} by @param {number[]} skip
   * @returns {Promise<import("../core/agent-checkpoint.mjs").SentFields | null>}
   */
  async agentSent(target, by, skip) {
    if (target.bc.currentWindowGlobal !== target.wg) return null;
    try {
      const raw = await actorFor(target.bc)?.sendQuery("Vimma:AgentElement", {
        op: "sent",
        gen: target.gen,
        id: target.id,
        by,
        skip,
      });
      return parseSentFields(raw);
    } catch {
      return null;
    }
  },
};
