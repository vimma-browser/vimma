/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The agent's page work in one frame (docs/specs/mcp-forms.md, docs/specs/mcp-checkpoints.md;
// security.md section 12, M25 to M30): its listed elements, its clicks, fills and submissions
// after the reply with their re-checks, the wait for the page to settle, and its console read.
// VimmaChild owns one per actor and hands it the `Vimma:Agent*` messages; it reads only the
// actor's document, window and manager. An agent's click is the child's press (shared with the
// user's hints), handed in as a callback with the check that the element is still on the page.

import { isSensitiveAutocomplete } from "../core/agent-element.mjs";
import {
  AGENT_CONSOLE,
  consoleArgsText,
  newestEntries,
  scriptErrorLevel,
  scriptErrorSource,
} from "../core/agent-act.mjs";
import { cutTo } from "../core/agent-keys.mjs";
import { isConsequential, mayAllowHere, parseSentFields } from "../core/agent-checkpoint.mjs";
import { quietVerdict } from "../core/agent-wait.mjs";
import {
  actTargetOf,
  cardFieldShown,
  defaultSubmitOf,
  fillField,
  fillTargetOf,
  formOf,
  pageChanges,
  pageMarks,
  payInfoOf,
  sensitiveValueShown,
  sentFieldsOf,
  totalBefore,
} from "./agent-fields.mjs";

const lazy = /** @type {Lazy<"setTimeout">} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/**
 * @param {unknown} n
 * @returns {n is number}
 */
const isIndex = (n) => Number.isSafeInteger(n) && /** @type {number} */ (n) >= 0;

/** The parent's number for an agent's step, or -1 without one. @param {{ step?: unknown }} asked */
const stepOf = (asked) => (isIndex(asked.step) ? asked.step : -1);

/**
 * An agent's step that runs after the child's reply (AgentPage #afterReply): the element of
 * the agent's list it acts on, the parent's number for the step (-1 for a fill, which the
 * parent does not number), and its outcome so far.
 * @template {string} T
 * @typedef {{ gen: number, id: number, step: number, outcome: "pending" | "skipped" | T }} AgentStep
 */

/**
 * @typedef {object} AgentPageHooks  what the helper needs of the child's private parts
 * @property {(el: Element | null | undefined) => el is Element} onPage  whether `el` is still in the
 *   frame's document, and that document still the frame's (VimmaChild #onPage, security.md M25)
 * @property {(el: Element, still?: () => boolean) => boolean} press  the child's click, as the
 *   user's hints make it (M26); `still` is checked after the mouse events, and when false
 *   nothing is clicked
 * @property {() => string | null} beforeSubmitCheck  the name of the page function the child's
 *   test hook names, read only in automation (M28); null otherwise
 */

export class AgentPage {
  /** @type {JSWindowActorChild} */
  #actor;
  /** @type {AgentPageHooks} */
  #hooks;
  /**
   * An agent's last `vimma_elements` in this frame (docs/specs/mcp-forms.md F4): beside the
   * user's collection, never in its place, so neither voids the other.
   */
  #agentEls = { gen: -1, els: /** @type {WeakRef<Element>[]} */ ([]) };
  /**
   * The agent's last click here (docs/specs/mcp-forms.md F8), or its fill's submission (F15): its
   * element and whether it ran or was skipped because the page changed the element before it,
   * or went away.
   * @type {AgentStep<"clicked"> | null}
   */
  #agentClick = null;
  /**
   * The page as it was just before the agent's last click here (#510), for `changes`: what
   * changed in place when the click loaded no page.
   * @type {{ gen: number, id: number, before: ReturnType<typeof pageMarks> } | null}
   */
  #agentWatch = null;
  /**
   * The agent's last fill of one field here (docs/specs/mcp-forms.md F12): its element and
   * whether it is still to run, kept its value, was put back by the page, or was skipped because
   * the field changed or its page went away before it.
   * @type {AgentStep<"kept" | "reset"> | null}
   */
  #agentFill = null;
  /**
   * How to skip each agent step that is still to run after its reply here (#afterReply): the
   * page's trusted `pagehide` skips them all.
   * @type {Set<() => void>}
   */
  #toRun = new Set();
  /**
   * The requests this document had open just before the agent's last click or submission here
   * (issue #579): only the ones the step started keep its wait going, not a page's long poll.
   */
  #netBase = 0;
  /**
   * The changes to this document since the agent's last step here began (`#startStepWatch`).
   * @type {{ doc: Document, at: number, last: number | null, observer: MutationObserver | null } | null}
   */
  #stepWatch = null;

  /**
   * @param {JSWindowActorChild} actor  the VimmaChild: its document, window, docshell and
   *   manager are read, and its skipped steps sent to the parent
   * @param {AgentPageHooks} hooks
   */
  constructor(actor, hooks) {
    this.#actor = actor;
    this.#hooks = hooks;
  }

  /** The agent's last collection here: the child's hint collection reads and replaces it. */
  get listed() {
    return this.#agentEls;
  }

  set listed(value) {
    this.#agentEls = value;
  }

  /** The page's trusted `pagehide` (#afterReply): every step still to run is skipped. */
  pageHidden() {
    for (const skip of [...this.#toRun]) skip();
  }

  /** @param {{ since?: unknown, max?: unknown }} data */
  consoleEntries(data) {
    // An agent's vimma_console (docs/specs/mcp-forms.md F22, F23): this frame's own errors.
    try {
      return this.#agentConsole(data);
    } catch (e) {
      console.error("vimma agent-console:", e);
      return { entries: [], omitted: 0 };
    }
  }

  cards() {
    // A step that may pay (docs/specs/mcp-checkpoints.md C6): whether this frame shows a
    // payment card field. A failure answers yes, so that a doubt asks.
    const doc = this.#actor.document;
    if (!doc) return false;
    try {
      return cardFieldShown(doc);
    } catch (e) {
      console.error("vimma agent checkpoint: card fields", e);
      return true;
    }
  }

  total() {
    // A key step that may pay (mcp-checkpoints C7) has no control: the page's last total.
    const doc = this.#actor.document;
    try {
      return (doc && totalBefore(doc, null)) || null;
    } catch (e) {
      console.error("vimma agent checkpoint: total", e);
      return null;
    }
  }

  sensitiveShown() {
    // An agent's screenshot is about to be taken (docs/specs/mcp-forms.md F21): whether a
    // sensitive field with a value is in this frame's viewport. A failure answers yes, so
    // that it refuses rather than captures.
    const win = this.#actor.contentWindow;
    if (!win) return true;
    try {
      return sensitiveValueShown(win);
    } catch (e) {
      console.error("vimma agent-screenshot: sensitive fields", e);
      return true;
    }
  }

  /**
   * The agent's listed element `id`, while it is in this frame's document (#onPage).
   * @param {number} id
   */
  #agentListed(id) {
    const el = this.#agentEls.els[id]?.deref();
    return el && this.#hooks.onPage(el) ? el : undefined;
  }

  /**
   * An element of the agent's last `vimma_elements` here (docs/specs/mcp-forms.md F4): `alive`
   * says whether it is still in the document, so a label never names an element the page has
   * replaced since.
   * @param {{ op: string, gen: number, id: number, submit?: unknown, href?: unknown,
   *   until?: unknown, value?: unknown, expect?: unknown, by?: unknown, skip?: unknown }} data
   */
  element(data) {
    const known = isIndex(data?.gen) && isIndex(data?.id) && data.gen === this.#agentEls.gen;
    const el = known ? this.#agentListed(data.id) : undefined;
    switch (data?.op) {
      case "alive":
        return this.#hooks.onPage(el);
      case "inspect":
        return actTargetOf(el);
      case "activate":
        return this.#agentActivate(el, data);
      case "consume":
        // An agent is about to act here (mcp-forms F16): the user's activation from before its
        // step must not count as the user's for what the page does after it.
        this.#actor.document?.consumeTransientUserGestureActivation();
        return true;
      case "outcome": {
        const last = this.#agentClick;
        return last && last.gen === data.gen && last.id === data.id ? last.outcome : "pending";
      }
      case "changes": {
        const watch = this.#agentWatch;
        // Against the same list as before the click: a newer `vimma_elements` here ends it.
        if (!known || !watch || watch.gen !== data.gen || watch.id !== data.id) return null;
        try {
          return pageChanges(watch.before, this.#pageMarks(data.id));
        } catch {
          return null;
        }
      }
      case "inspect-fill":
        return fillTargetOf(el, data.value);
      case "fill":
        return this.#agentFillField(el, data);
      case "loading":
        // After a fill (issue #579): whether the fields' handlers started a load in this frame.
        // Asked after their task, so a submission they queued has started by now.
        return !!this.#actor.docShell?.isLoadingDocument;
      case "fill-outcome": {
        const last = this.#agentFill;
        return last && last.gen === data.gen && last.id === data.id ? last.outcome : "pending";
      }
      case "submit":
        return this.#agentSubmit(el, data);
      case "pay":
        // docs/specs/mcp-checkpoints.md C6, C7: what the pressed control says, the total before it.
        return payInfoOf(el, data.by === "form" ? "form" : "click");
      case "sent": {
        // Behaviour 4: what the form sends, but for the fields the same call fills.
        /** @type {Set<Element>} */
        const skip = new Set();
        for (const id of Array.isArray(data.skip) ? data.skip : []) {
          const field = isIndex(id) ? this.#agentListed(id) : undefined;
          if (field) skip.add(field);
        }
        return sentFieldsOf(el, data.by === "form" ? "form" : "click", skip);
      }
    }
    return false;
  }

  /**
   * An agent's fill of one field (docs/specs/mcp-forms.md F12, F13; security.md M27): the field
   * must still be what the user was asked about and not sensitive, then it is set after this
   * reply, so that a dialog the page opens in its `input` or `change` handler never holds the
   * parent's call. It is checked again just before the set, which is skipped if it changed.
   * @param {Element | undefined} el
   * @param {{ gen: number, id: number, value?: unknown, expect?: unknown, until?: unknown }} asked
   *   `expect`: how the field was to be set (`field`) and its type, when the question was asked
   * @returns {"ok" | "gone" | "changed"}
   */
  #agentFillField(el, asked) {
    if (!this.#hooks.onPage(el)) return "gone";
    if (typeof asked.until !== "number" || Date.now() > asked.until) return "gone";
    const value = asked.value;
    if (typeof value !== "string" && typeof value !== "boolean") return "changed";
    if (!this.#fillAsAsked(el, asked)) return "changed";
    /** @type {AgentStep<"kept" | "reset">} */
    const fill = { gen: asked.gen, id: asked.id, step: -1, outcome: "pending" };
    this.#agentFill = fill;
    const until = asked.until;
    this.#afterReply(fill, false, () => {
      // A busy page can delay this past the parent's wait: then nothing is set.
      if (Date.now() > until || !this.#hooks.onPage(el) || !this.#fillAsAsked(el, asked)) {
        return "skipped";
      }
      return fillField(el, value) ? "kept" : "reset";
    });
    return "ok";
  }

  /**
   * Whether `el` is still the field the agent's question showed: set the same way, of the same
   * type, not sensitive, disabled or read-only, and taking the value.
   * @param {Element} el @param {{ value?: unknown, expect?: unknown }} asked
   */
  #fillAsAsked(el, asked) {
    const now = fillTargetOf(el, asked.value);
    /** @type {{ field?: unknown, type?: unknown }} */
    const expect = asked.expect && typeof asked.expect === "object" ? asked.expect : {};
    if (!now.alive || now.secret || isSensitiveAutocomplete(now.autocomplete)) return false;
    if (now.disabled || now.readonly || now.accepts === false) return false;
    if (!["text", "textarea", "select", "checkbox", "radio"].includes(now.field ?? "")) {
      return false;
    }
    return now.field === expect.field && (now.type ?? null) === (expect.type ?? null);
  }

  /**
   * An agent's submission of a field's form with its default button (docs/specs/mcp-forms.md
   * F15; security.md M28), after its fill: only to the method and destination the question
   * named, by `requestSubmit`, after this reply. No user activation is given: the parent lets
   * through only the submission the question allowed.
   * @param {Element | undefined} el
   * @param {{ gen: number, id: number, submit?: unknown, until?: unknown, step?: unknown }} asked
   *   `step`: the parent's number for this step, said back if it is skipped
   * @returns {"ok" | "gone" | "changed"}
   */
  #agentSubmit(el, asked) {
    if (!this.#hooks.onPage(el)) return "gone";
    if (typeof asked.until !== "number" || Date.now() > asked.until) return "gone";
    const form = formOf(el);
    const now = form ? defaultSubmitOf(form) : null;
    /** @type {{ method?: unknown, action?: unknown } | null} */
    const named = asked.submit && typeof asked.submit === "object" ? asked.submit : null;
    if (!now || !named || now.method !== named.method || now.action !== named.action) {
      return "changed";
    }
    // The parent's wait for a page counts from when this ran (`outcome`, as for a click).
    /** @type {AgentStep<"clicked">} */
    const sent = { gen: asked.gen, id: asked.id, step: stepOf(asked), outcome: "pending" };
    this.#agentClick = sent;
    const until = asked.until;
    this.#afterReply(sent, true, () => {
      const test = this.#hooks.beforeSubmitCheck();
      if (test) {
        try {
          const page = this.#actor.contentWindow?.wrappedJSObject;
          const hook = page?.[test];
          if (typeof hook === "function") hook.call(page);
        } catch {
          // the test's page function threw: the check below sees what it left
        }
      }
      const again = this.#hooks.onPage(form) ? defaultSubmitOf(form) : null;
      if (
        Date.now() > until ||
        !form ||
        !again ||
        again.method !== named.method ||
        again.action !== named.action
      ) {
        return "skipped";
      }
      sent.outcome = "clicked";
      this.#startStepWatch();
      form.requestSubmit(again.submitter ?? undefined);
      return "clicked";
    });
    return "ok";
  }

  /**
   * An agent's click (docs/specs/mcp-forms.md F8; security.md M26): the element must still be
   * what the user was asked about, then the user's hint sequence runs on it, after this reply,
   * so that a dialog the page opens in its handler never holds the parent's call. The page may
   * change the element in its handlers of the untrusted mouse events, so it is checked again
   * before click(), which is skipped if it changed. Nothing is focused, and no event goes
   * through the widget or nsIDOMWindowUtils, so the page gets no user activation. A request
   * whose time is up (`until`, ms since the epoch) clicks nothing: the parent stopped waiting.
   * @param {Element | undefined} el
   * @param {{ gen: number, id: number, submit?: unknown, href?: unknown, until?: unknown,
   *   step?: unknown }} asked  `submit`: the method and destination the question named, or
   *   null; `step`: the parent's number for this step, said back if it is skipped
   * @returns {"ok" | "gone" | "changed"}
   */
  #agentActivate(el, asked) {
    if (!el || !actTargetOf(el).alive) return "gone";
    if (typeof asked.until !== "number" || Date.now() > asked.until) return "gone";
    if (!this.#asAsked(el, asked)) return "changed";
    /** @type {AgentStep<"clicked">} */
    const click = { gen: asked.gen, id: asked.id, step: stepOf(asked), outcome: "pending" };
    this.#agentClick = click;
    this.#agentWatch = null;
    const until = asked.until;
    this.#afterReply(click, true, () => {
      try {
        if (Date.now() <= until && this.#hooks.onPage(el)) {
          this.#agentWatch = { gen: asked.gen, id: asked.id, before: this.#pageMarks(asked.id) };
        }
      } catch {
        // The page's DOM broke the snapshot: the click and its outcome (M28) go on without it.
      }
      this.#startStepWatch();
      // A busy page can delay this past the parent's wait: then nothing is clicked.
      const ran =
        Date.now() <= until &&
        this.#hooks.onPage(el) &&
        this.#hooks.press(el, () => this.#asAsked(el, asked));
      return ran ? "clicked" : "skipped";
    });
    return "ok";
  }

  /**
   * Runs an agent's step after this reply, so that a dialog the page opens never holds the
   * parent's call, and keeps its outcome in `step` for the parent to ask (`outcome`,
   * `fill-outcome`). No step stays "pending": one that throws is skipped, and so is one whose
   * page is hidden before it runs (a navigation, or the back-forward cache; issue #1028). A
   * navigation in this process can commit between the reply and the step, and from then on the
   * page is no longer the frame's; the skip is decided on the old page's `pagehide`, while this
   * actor can still message the parent, so a skipped click or submission (`tell`) reaches it
   * ahead of the next document (#skipped).
   * @template {string} T
   * @param {AgentStep<T>} step @param {boolean} tell
   * @param {() => T | "skipped"} run  the step; returns its outcome
   */
  #afterReply(step, tell, run) {
    const skipped = () => {
      step.outcome = "skipped";
      if (tell) this.#skipped(step);
    };
    const skip = () => {
      this.#toRun.delete(skip);
      if (step.outcome === "pending") skipped();
    };
    this.#toRun.add(skip);
    Services.tm.dispatchToMainThread(() => {
      // From here on the step is running: a page hidden by what it does was not skipped.
      if (!this.#toRun.delete(skip) || step.outcome !== "pending") return;
      try {
        step.outcome = run();
      } catch {
        // The page broke the step before it ran: nothing more of it runs.
        if (step.outcome === "pending") step.outcome = "skipped";
      }
      if (step.outcome === "skipped" && tell) this.#skipped(step);
    });
  }

  /**
   * Starts watching for changes to this document as the agent's step runs here, for
   * `#agentQuiet`, which the parent asks only once the step has run: the page's handlers may
   * have changed it by then. Also notes the requests open before the step.
   */
  #startStepWatch() {
    this.#endStepWatch();
    this.#netBase = this.#openRequests();
    const doc = this.#actor.document;
    const win = this.#actor.contentWindow;
    if (!doc || !win) return;
    /** @type {{ doc: Document, at: number, last: number | null, observer: MutationObserver | null }} */
    const watch = { doc, at: Date.now(), last: null, observer: null };
    try {
      watch.observer = new win.MutationObserver(() => {
        watch.last = Date.now();
      });
      watch.observer.observe(doc, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    } catch {
      // no observer: the quiet wait sees only later changes
    }
    this.#stepWatch = watch;
  }

  #endStepWatch() {
    this.#stepWatch?.observer?.disconnect();
    this.#stepWatch = null;
  }

  /** How many requests this document has open: its loads, fetches and XHRs (its load group). */
  #openRequests() {
    try {
      // Every request, not `activeCount`: that counts only foreground ones, and fetches and
      // XHRs are background requests (nsLoadGroup::AddRequest, LOAD_BACKGROUND).
      const group = this.#actor.document?.documentLoadGroup;
      return group ? [...group.requests].length : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Waits until this frame's page has settled after an agent's step (docs/specs/mcp-forms.md
   * F11, issue #579), so that the parent's call returns as soon as the page has, instead of
   * after a fixed second. With `ready`, a new page waits for its DOMContentLoaded first, and a
   * page already complete answers at once. Then it waits until the document has not changed
   * for `quiet` ms (`still` ms when it has not changed at all), and, with `net`, until no
   * request the step started is open, for at most `max` ms (core quietVerdict), and never
   * past `until` (ms since the epoch). A MutationObserver sees the changes, which the page
   * cannot hide from it; only whether the page changed is kept, none of what it shows.
   * @param {{ ready?: unknown, net?: unknown, quiet?: unknown, still?: unknown, max?: unknown,
   *   until?: unknown }} data
   * @returns {Promise<{ settled: "quiet" | "busy", state: string } | null>} null: the
   *   document went away, or its time ran out before its DOMContentLoaded
   */
  async quiet(data) {
    /** @param {unknown} v @param {number} cap */
    const ms = (v, cap) => (typeof v === "number" && v >= 0 ? Math.min(v, cap) : 0);
    const limits = {
      quiet: ms(data?.quiet, 5000),
      still: ms(data?.still, 5000),
      max: ms(data?.max, 10000),
    };
    const until = Math.min(typeof data?.until === "number" ? data.until : 0, Date.now() + 30000);
    const doc = this.#actor.document;
    const win = this.#actor.contentWindow;
    if (!doc || !win) return null;
    const gone = () => {
      try {
        return !this.#actor.manager?.isCurrentGlobal || this.#actor.document !== doc;
      } catch {
        return true;
      }
    };
    // Chrome timers: a hidden tab's page timers are held to one a second, these are not.
    const tick = () => new Promise((resolve) => lazy.setTimeout(resolve, 25));
    if (data?.ready && doc.readyState === "complete")
      return { settled: "quiet", state: "complete" };
    while (data?.ready && doc.readyState === "loading") {
      if (gone() || Date.now() > until) return null;
      await tick();
    }
    if (gone()) return null;
    // After a step, its own watch saw what the page did as it was pressed, before this call.
    const step = !data?.ready && this.#stepWatch?.doc === doc ? this.#stepWatch : null;
    this.#endStepWatch();
    const start = step?.at ?? Date.now();
    /** @type {number | null} */
    let last = data?.ready ? start : (step?.last ?? null);
    const observer = new win.MutationObserver(() => {
      last = Date.now();
    });
    observer.observe(doc, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    try {
      for (;;) {
        if (gone()) return null;
        const now = Date.now();
        const netBusy = !!data?.net && this.#openRequests() > this.#netBase;
        const sinceChange = last === null ? null : now - last;
        const verdict = quietVerdict({ elapsed: now - start, sinceChange, netBusy }, limits);
        if (verdict) return { settled: verdict, state: doc.readyState };
        if (now > until) return { settled: "busy", state: doc.readyState };
        await tick();
      }
    } finally {
      observer.disconnect();
    }
  }

  /**
   * This frame's page as a click on the listed element `id` could change it in place (#510).
   * @param {number} id
   */
  #pageMarks(id) {
    const listed = this.#agentEls.els.map((_, i) => this.#agentListed(i));
    return pageMarks(/** @type {Document} */ (this.#actor.document), listed, id);
  }

  /**
   * The agent's click or submission was skipped here: the parent withdraws the one submission
   * the question allowed (security.md M28). Sent in the task that decided it, before any page
   * script runs again, so it reaches the parent ahead of every later navigation or request this
   * process starts for the page: the actor's messages and the page's loads (DocumentChannel)
   * go over the same PContent channel, in order. A page that puts the form back and submits by
   * itself afterwards is then cancelled like any other submission. It names the step, so the
   * parent can tell the agent its click was skipped after the page went away (issue #1028), and
   * by the parent's own number for it, so that a late one is not taken for a later step's.
   * @param {{ gen: number, id: number, step: number }} step
   */
  #skipped({ gen, id, step }) {
    try {
      this.#actor.sendAsyncMessage("Vimma:AgentSkipped", { gen, id, step });
    } catch {
      // The actor is going away with its document. For the top frame the mark goes with the
      // page; for a subframe removed this way the allowance stays open until the call ends,
      // still only for the method and destination the question named.
    }
  }

  /**
   * Whether `el` is still what the agent's question showed: nothing an agent may not click, a
   * submit only if asked as one and to the same method and destination, the same link.
   * @param {Element} el @param {{ submit?: unknown, href?: unknown }} asked
   */
  #asAsked(el, asked) {
    const now = actTargetOf(el);
    if (!now.alive || now.field || now.disabled) return false;
    /** @type {{ method?: unknown, action?: unknown, check?: unknown } | null} */
    const named = asked.submit && typeof asked.submit === "object" ? asked.submit : null;
    if (!now.submit !== !named) return false;
    if (
      now.submit &&
      (now.submit.method !== named?.method || now.submit.action !== named?.action)
    ) {
      return false;
    }
    // mcp-consequence K1, K5: a form a grant runs unasked was judged by what it sent before the
    // click; another call (a fill) may have changed it since, so it is judged again here, just
    // before it is pressed, and skipped when it no longer passes.
    if (now.submit && named?.check) {
      const step = { pay: false, sent: parseSentFields(sentFieldsOf(el, "click", new Set())) };
      if (named.check === "harmless" && isConsequential(step)) return false;
      if (named.check === "allowed" && !mayAllowHere(step)) return false;
    }
    return (now.href ?? null) === (asked.href ?? null);
  }

  /**
   * This frame's script errors and its page's console.error and console.warn calls, for an
   * agent's `vimma_console` (docs/specs/mcp-forms.md F22, F23; security.md M30): read from this
   * process's console service and ConsoleAPIStorage, both of which Firefox fills whether or not
   * anyone asks, by this document's inner window id. Nothing runs in the page: a console call's
   * arguments are read only with `typeof` (consoleArgsText), and of a script error only its text
   * and position, never its exception or stack. Only the newest `max` entries after `since` are
   * answered, each string cut, with how many more there are, so a noisy page cannot make the
   * parent copy everything it logged.
   * @param {{ since?: unknown, max?: unknown }} data
   */
  #agentConsole(data) {
    const since = Number.isSafeInteger(data?.since) ? /** @type {number} */ (data.since) : 0;
    const max = Math.min(
      Number.isSafeInteger(data?.max) ? /** @type {number} */ (data.max) : AGENT_CONSOLE.errors,
      AGENT_CONSOLE.errors,
    );
    /** A count from Firefox's event, else 0. @param {unknown} v */
    const n = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    const id = this.#actor.manager?.innerWindowId;
    if (!id) return { entries: [], omitted: 0 };
    /** @param {unknown} s @param {number} most */
    const cut = (s, most) => cutTo(String(s ?? "").slice(0, 4 * most), most);
    const out = [];
    for (const m of Services.console.getMessageArray() ?? []) {
      if (!(m instanceof Ci.nsIScriptError) || m.innerWindowID !== id) continue;
      const level = scriptErrorLevel(m.flags);
      if (!level) continue;
      out.push({
        level,
        source: scriptErrorSource(m.category),
        message: cut(m.errorMessage, AGENT_CONSOLE.message),
        file: cut(m.sourceName, AGENT_CONSOLE.url),
        line: m.lineNumber,
        column: m.columnNumber,
        time: m.timeStamp,
      });
    }
    const storage = Cc["@mozilla.org/consoleAPI-storage;1"].getService(Ci.nsIConsoleAPIStorage);
    for (const event of storage.getEvents(String(id)) ?? []) {
      // The event is Firefox's own object, made in a privileged scope (dom/console/Console.cpp);
      // only its `arguments` are the page's.
      const level = event?.level;
      if (level !== "error" && level !== "warn") continue;
      out.push({
        level,
        source: "console",
        message: cut(consoleArgsText(event.arguments), AGENT_CONSOLE.message),
        file: typeof event.filename === "string" ? cut(event.filename, AGENT_CONSOLE.url) : "",
        line: n(event.lineNumber),
        column: n(event.columnNumber),
        time: n(event.timeStamp),
      });
    }
    const after = out.filter((e) => e.time > since);
    const entries = newestEntries(after, since, max);
    return { entries, omitted: after.length - entries.length };
  }
}
