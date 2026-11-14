/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Issue #1028: an agent's click, fill or submission runs in the page's process after the child's
// reply (docs/specs/mcp-forms.md F8, F12, F15; security.md M26-M28), and a navigation can take
// the page away in between. Then nothing is clicked, set or sent, the step is skipped and the
// parent is told before it sees the next document, so the agent is never told of a click that
// did not happen and the submission the question allowed is withdrawn at once. The same holds
// for the user's own hint click. Each task makes the frame's child answer only as its page is
// hidden by a same-site navigation the test starts there, so the order is fixed: the reply, the
// page hidden, then the step. Without the back-forward cache the page's window is no longer
// current from then on, while the child's actor and its document are still the old page's; with
// it, the hidden page stays current in its own browsing context.
//
// What each task proves. The fix has three parts: (a) an element counts as on the page only while
// the actor's window is current, and nothing is pressed without a window (#onPage, #press); (b)
// a step still to run when its page fires its trusted pagehide is skipped then, in the system
// group, and said to the parent while the child can still send (#afterReply); (c) the parent
// reads that skip by the step's own number at the moment it asks (agentClickOutcome).
// - test_a_click_a_navigation_overtakes_is_skipped_and_said: (b) and (c); with (a) alone the
//   parent sees a new window and says the click ran.
// - test_a_click_on_a_page_going_into_the_bfcache_is_skipped,
//   test_a_fill_on_a_page_going_into_the_bfcache_sets_nothing and
//   test_a_hint_click_after_the_page_was_replaced_clicks_nothing: (a); they pass with it alone.
// - test_a_skipped_submit_in_a_frame_withdraws_the_allowance: (b), for the allowance.
// - test_a_page_that_stops_its_pagehide_still_has_the_click_skipped: (b) is out of the page's
//   reach (system group).
// - test_an_outcome_asked_as_the_page_goes_away_reads_the_skip: (c), the skip read when the
//   question fails, not when it was sent.
// - test_a_late_skip_of_an_earlier_step_is_not_the_next_ones: (c), by the step's number.

"use strict";

/* global Client, tidyTask -- from head_vimma_control.js */
/* global focusContent -- from head.js */
/* global requestLongerTimeout -- the browser-chrome harness (browser-test.js) */

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_control.js", this);
// Seven agent steps, each with its question and a page load, and a hint click.
requestLongerTimeout(2);

const { VimmaControl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);
const { AgentGate } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/AgentGate.sys.mjs",
);
const { MCP_ENABLED_PREF } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/mcp-ops.mjs",
);
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { VimmaActors } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/actors/VimmaActors.sys.mjs",
);

const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const RACE = `${DIR}file_vimma_agent_click_race.html`;
const FRAMED = `${DIR}file_vimma_agent_click_race_frame.html`;
const NEXT = `${RACE}?next`;
/** No page goes into the back-forward cache: a navigation replaces the frame's window in place. */
const NO_BFCACHE = "browser.sessionhistory.max_total_viewers";
/** What the child tells the test about the message it held (see `holdInChild`). */
const PROBE = "VimmaTest:RaceProbe";
const SKIPPED = "the element changed as it was clicked; nothing was clicked";

const agent = () => /** @type {any} */ (WorkspaceStore.agent);
const agentTabs = () =>
  gBrowser.tabs.filter((t) => t.userContextId === agent().userContextId && !t.closing);
const idOf = (/** @type {any} */ tab) => String(tab.linkedBrowser.browserId);
const ww = () => /** @type {LiveWorkspaces} */ (WindowWorkspaces.get(window));
const mainId = () =>
  /** @type {string} */ (
    ww().model.workspaces.find((/** @type {WorkspaceState} */ w) => w.name === "main")?.id
  );

/** @param {() => unknown} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 20, 250);

/** @param {boolean} on */
async function mcp(on) {
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, on);
  await VimmaControl.settled();
}

/** The connections the running task opened. @type {any[]} */
const clients = [];

/** What a task leaves when it ends, passed or not (tidyTask): this file's state at its start. */
async function putBack() {
  for (const c of clients.splice(0)) c.close();
  if (ww().model.active !== mainId()) ww().switchTo({ id: mainId() });
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
  for (const t of gBrowser.tabs.slice(1)) BrowserTestUtils.removeTab(t);
  Services.prefs.clearUserPref(MCP_ENABLED_PREF);
  Services.prefs.clearUserPref(NO_BFCACHE);
  await VimmaControl.settled();
}

registerCleanupFunction(putBack);

/** add_task, with putBack after the task however it ends. @param {() => Promise<void>} task */
const addTidyTask = (task) => add_task(tidyTask(task, putBack));

/** A tab in the agent workspace, loaded with `url`, hidden while the window shows `main`. */
async function openAgentTab(url = RACE) {
  const tab = gBrowser.addTab(url, {
    userContextId: agent().userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, true, url);
  await until(() => tab.hidden, "the agent tab is hidden in its workspace");
  return tab;
}

/** An agent connection, after its agent-hello. */
async function agentClient() {
  const c = new Client(/** @type {number} */ (VimmaControl.port));
  clients.push(c);
  await c.handshake({ protocol: 2, role: "agent" });
  await c.call("agent-hello", { client: { name: "example-agent" } });
  return c;
}

/** The oldest waiting question, once there is one. */
async function question() {
  await until(() => AgentGate.waiting.length > 0, "a question waits");
  return /** @type {AskedQuestion} */ (AgentGate.waiting[0]);
}

/** The list's elements by what they say. @param {any} c @param {any} tab */
async function labels(c, tab) {
  const id = c.request("agent-elements", { tab: idOf(tab) });
  AgentGate.answer((await question()).id, { kind: "once" });
  const r = await c.response(id);
  Assert.ok(r.ok, "vimma_elements runs");
  /** @type {Record<string, string>} */
  const by = {};
  for (const line of r.result.elements.split("\n").slice(1, -1)) {
    const e = JSON.parse(line);
    if ("label" in e) by[e.text || e.name || e.caption] = e.label;
  }
  return by;
}

/**
 * `command` on `tab`, answered once.
 * @param {any} c @param {string} command @param {Record<string, unknown>} args
 */
async function askedOnce(c, command, args) {
  const id = c.request(command, args);
  AgentGate.answer((await question()).id, { kind: "once" });
  return c.response(id);
}

/**
 * The script errors reported from here on that name a file of Vimma's content actors: an
 * error the child's step throws in its own process reaches this console too.
 */
function childErrors() {
  /** @type {string[]} */
  const errors = [];
  const listener = {
    /** @param {nsIConsoleMessage} msg */
    observe(msg) {
      if (!(msg instanceof Ci.nsIScriptError)) return;
      const err = /** @type {nsIScriptError} */ (msg);
      if (err.flags & Ci.nsIScriptError.warningFlag) return;
      if (!`${err.sourceName} ${err.errorMessage}`.includes("vimma/actors/")) return;
      errors.push(`${err.errorMessage} (${err.sourceName}:${err.lineNumber})`);
    },
  };
  Services.console.registerListener(listener);
  return {
    errors,
    stop() {
      Services.console.unregisterListener(listener);
    },
  };
}

/**
 * Holds the frame's next `name` message to its Vimma child (with `op`, for an agent's element
 * message), navigates the frame to `next`, and only then lets the child take it: as the old page
 * is hidden (its trusted `pagehide`), so that the child's reply goes first and its step comes
 * after the navigation (`late` false), or after the navigation has replaced the page (`late`).
 * The child's actor is the old page's either way. The next `PROBE` message says whether that
 * actor's window was still current when the child took the message, and what it answered.
 * With `system`, the test's own pagehide listener is in the system group, out of reach of a page
 * that stops its pagehide (`?stop`), as the child's is.
 * @param {any} bc BrowsingContext @param {string} name @param {string | null} op
 * @param {string} next @param {boolean} late @param {boolean} [system]
 */
function holdInChild(bc, name, op, next, late, system = false) {
  /** @type {[string, string | null, string, boolean, string, boolean]} */
  const args = [name, op, next, late, PROBE, system];
  return SpecialPowers.spawn(bc, args, (name, op, next, late, probe, system) => {
    const win = /** @type {any} */ (content);
    const actor = win.windowGlobalChild.getActor("Vimma");
    const receive = actor.receiveMessage;
    /** @param {any} msg */
    actor.receiveMessage = (msg) => {
      if (msg.name !== name || (op && msg.data?.op !== op)) return receive.call(actor, msg);
      actor.receiveMessage = receive;
      return new Promise((resolve, reject) => {
        const take = () => {
          const current = !!actor.manager?.isCurrentGlobal;
          let threw = "";
          let answer;
          try {
            answer = receive.call(actor, msg);
          } catch (e) {
            threw = String(e);
          }
          /** @type {{ cpmm: { sendAsyncMessage(name: string, data: unknown): void } }} */ (
            /** @type {unknown} */ (Services)
          ).cpmm.sendAsyncMessage(probe, {
            current,
            threw,
            answer: JSON.stringify(answer ?? null),
          });
          if (threw) reject(new Error(threw));
          else resolve(answer);
        };
        win.addEventListener(
          "pagehide",
          () => (late ? Services.tm.dispatchToMainThread(take) : take()),
          { once: true, mozSystemGroup: system },
        );
        win.location.href = next;
      });
    };
  });
}

/**
 * The parent's end of every child's process message manager (Services.ppmm).
 * @typedef {{ data: unknown }} ProbeMessage
 * @typedef {{ addMessageListener(name: string, fn: (msg: ProbeMessage) => void): void,
 *   removeMessageListener(name: string, fn: (msg: ProbeMessage) => void): void }} ParentMM
 */
const ppmm = /** @type {{ ppmm: ParentMM }} */ (/** @type {unknown} */ (Services)).ppmm;

/** The next PROBE message from a child. @returns {Promise<unknown>} */
function probed() {
  return new Promise((resolve) => {
    /** @param {ProbeMessage} msg */
    const listener = (msg) => {
      ppmm.removeMessageListener(PROBE, listener);
      resolve(msg.data);
    };
    ppmm.addMessageListener(PROBE, listener);
  });
}

/** Back to the page before, from the back-forward cache. @param {any} browser */
async function goBack(browser) {
  const back = BrowserTestUtils.waitForContentEvent(browser, "pageshow");
  await SpecialPowers.spawn(browser, [], () => content.history.back());
  await back;
}

/** The clicks the tab's session storage counted. @param {any} browser */
const storedClicks = (browser) =>
  SpecialPowers.spawn(browser, [], () => content.sessionStorage.getItem("clicks"));

/** The page's own count of clicks and its field's value. @param {any} browser */
const pageState = (browser) =>
  SpecialPowers.spawn(browser, [], () => ({
    clicks: content.document.body.dataset.clicks ?? null,
    name: /** @type {HTMLInputElement} */ (content.document.getElementById("name")).value,
  }));

addTidyTask(async function test_a_click_a_navigation_overtakes_is_skipped_and_said() {
  Services.prefs.setIntPref(NO_BFCACHE, 0);
  await mcp(true);
  const tab = await openAgentTab();
  const browser = tab.linkedBrowser;
  const c = await agentClient();
  const by = await labels(c, tab);
  const bc = browser.browsingContext;
  const errors = childErrors();
  try {
    await holdInChild(bc, "Vimma:AgentElement", "activate", NEXT, false);
    const probe = probed();
    const loaded = BrowserTestUtils.browserLoaded(browser, false, NEXT);
    const r = await askedOnce(c, "agent-activate", { tab: idOf(tab), label: by.Go });
    await loaded;
    Assert.deepEqual(
      await probe,
      { current: true, threw: "", answer: '"ok"' },
      "the child answered before the navigation",
    );
    Assert.equal(browser.browsingContext, bc, "the page was replaced in its own frame");
    Assert.equal(r.error?.message, SKIPPED, "the agent is told nothing was clicked");
    Assert.equal(await storedClicks(browser), null, "the page never got the click");
    Assert.deepEqual(errors.errors, [], "and the child threw nothing");
  } finally {
    errors.stop();
  }
});

addTidyTask(async function test_a_click_on_a_page_going_into_the_bfcache_is_skipped() {
  await mcp(true);
  const tab = await openAgentTab();
  const browser = tab.linkedBrowser;
  const c = await agentClient();
  const by = await labels(c, tab);
  const bc = browser.browsingContext;
  const errors = childErrors();
  try {
    await holdInChild(bc, "Vimma:AgentElement", "activate", NEXT, false);
    const probe = probed();
    const loaded = BrowserTestUtils.browserLoaded(browser, false, NEXT);
    const r = await askedOnce(c, "agent-activate", { tab: idOf(tab), label: by.Go });
    await loaded;
    Assert.deepEqual(
      await probe,
      { current: true, threw: "", answer: '"ok"' },
      "the child answered before the navigation",
    );
    Assert.notEqual(browser.browsingContext, bc, "the old page went into the back-forward cache");
    Assert.equal(r.error?.message, SKIPPED, "the agent is told nothing was clicked");
    await goBack(browser);
    Assert.equal((await pageState(browser)).clicks, null, "the hidden page never got the click");
    Assert.deepEqual(errors.errors, [], "and the child threw nothing");
  } finally {
    errors.stop();
  }
});

addTidyTask(async function test_a_fill_on_a_page_going_into_the_bfcache_sets_nothing() {
  await mcp(true);
  const tab = await openAgentTab();
  const browser = tab.linkedBrowser;
  const c = await agentClient();
  const by = await labels(c, tab);
  const errors = childErrors();
  try {
    await holdInChild(browser.browsingContext, "Vimma:AgentElement", "fill", NEXT, false);
    const probe = probed();
    const loaded = BrowserTestUtils.browserLoaded(browser, false, NEXT);
    const r = await askedOnce(c, "agent-fill", {
      tab: idOf(tab),
      fields: [{ label: by.Name, value: "Ada" }],
    });
    await loaded;
    Assert.deepEqual(
      await probe,
      { current: true, threw: "", answer: '"ok"' },
      "the child answered before the navigation",
    );
    Assert.ok(!r.ok, "the agent is not told the field was filled");
    await goBack(browser);
    Assert.equal((await pageState(browser)).name, "", "the hidden page's field was not set");
    Assert.deepEqual(errors.errors, [], "and the child threw nothing");
  } finally {
    errors.stop();
  }
});

addTidyTask(async function test_a_skipped_submit_in_a_frame_withdraws_the_allowance() {
  Services.prefs.setIntPref(NO_BFCACHE, 0);
  await mcp(true);
  const tab = await openAgentTab(FRAMED);
  const browser = tab.linkedBrowser;
  const c = await agentClient();
  const by = await labels(c, tab);
  const frame = browser.browsingContext.children[0];
  const errors = childErrors();
  try {
    // The frame's next page sends the form the question allows, by itself, as it loads.
    await holdInChild(frame, "Vimma:AgentElement", "activate", `${RACE}?auto`, false);
    const probe = probed();
    const sent = requestStatus(`${RACE}?sent=`);
    const r = await askedOnce(c, "agent-activate", { tab: idOf(tab), label: by.Send });
    Assert.deepEqual(
      await probe,
      { current: true, threw: "", answer: '"ok"' },
      "the child answered before the navigation",
    );
    Assert.equal(r.error?.message, SKIPPED, "the agent is told nothing was clicked");
    Assert.equal(await sent, Cr.NS_BINDING_ABORTED, "the page's own submission was cancelled");
    Assert.deepEqual(errors.errors, [], "and the child threw nothing");
  } finally {
    errors.stop();
  }
});

addTidyTask(async function test_a_page_that_stops_its_pagehide_still_has_the_click_skipped() {
  Services.prefs.setIntPref(NO_BFCACHE, 0);
  await mcp(true);
  const stopping = `${RACE}?stop`;
  const tab = await openAgentTab(stopping);
  const browser = tab.linkedBrowser;
  const c = await agentClient();
  const by = await labels(c, tab);
  const errors = childErrors();
  try {
    await holdInChild(browser.browsingContext, "Vimma:AgentElement", "activate", NEXT, false, true);
    const probe = probed();
    const loaded = BrowserTestUtils.browserLoaded(browser, false, NEXT);
    const r = await askedOnce(c, "agent-activate", { tab: idOf(tab), label: by.Go });
    await loaded;
    Assert.deepEqual(
      await probe,
      { current: true, threw: "", answer: '"ok"' },
      "the child answered before the navigation",
    );
    Assert.equal(r.error?.message, SKIPPED, "the page could not keep its pagehide from the child");
    Assert.equal(await storedClicks(browser), null, "the page never got the click");
    Assert.deepEqual(errors.errors, [], "and the child threw nothing");
  } finally {
    errors.stop();
  }
});

/**
 * The target `agent-activate` would click for `label`, without clicking it: the call is
 * answered "changed" in the parent, before any message to the child.
 * @param {any} c @param {any} tab @param {string} label
 * @returns {Promise<any>} HintTarget
 */
async function targetOf(c, tab, label) {
  const activate = VimmaActors.agentActivate;
  /** @type {any} */
  let target = null;
  VimmaActors.agentActivate = async (/** @type {any} */ t) => {
    target = t;
    return "changed";
  };
  try {
    const r = await askedOnce(c, "agent-activate", { tab: idOf(tab), label });
    Assert.ok(!r.ok, "the call that found the target clicked nothing");
  } finally {
    VimmaActors.agentActivate = activate;
  }
  Assert.ok(target, "the target was found");
  return target;
}

addTidyTask(async function test_an_outcome_asked_as_the_page_goes_away_reads_the_skip() {
  // The order the parent can meet when the skip and the commit are already on their way: it
  // asks the child how the click went before the skip arrives, and the question fails as the
  // page goes away, after the skip arrived. The child holds the click until the question has
  // come, never answers the question, and only then navigates; the click is taken as the page
  // is hidden, so the child replies, skips it and says so, and its actor is destroyed.
  Services.prefs.setIntPref(NO_BFCACHE, 0);
  await mcp(true);
  const tab = await openAgentTab();
  const browser = tab.linkedBrowser;
  const c = await agentClient();
  const by = await labels(c, tab);
  const target = await targetOf(c, tab, by.Go);
  await SpecialPowers.spawn(browser.browsingContext, [NEXT], (next) => {
    const win = /** @type {any} */ (content);
    const actor = win.windowGlobalChild.getActor("Vimma");
    const receive = actor.receiveMessage;
    /** @type {any} */
    let held = null;
    /** @param {any} msg */
    actor.receiveMessage = (msg) => {
      if (msg.name !== "Vimma:AgentElement") return receive.call(actor, msg);
      if (msg.data?.op === "activate") {
        return new Promise((resolve) => {
          held = () => resolve(receive.call(actor, msg));
        });
      }
      if (msg.data?.op === "outcome" && held) {
        actor.receiveMessage = receive;
        win.addEventListener("pagehide", held, { once: true });
        win.location.href = next;
        return new Promise(() => {});
      }
      return receive.call(actor, msg);
    };
  });
  const loaded = BrowserTestUtils.browserLoaded(browser, false, NEXT);
  const sent = VimmaActors.agentActivate(target, {
    submit: null,
    href: null,
    until: Date.now() + 10000,
  });
  const outcome = VimmaActors.agentClickOutcome(target);
  Assert.equal(await sent, "ok", "the child took the click");
  Assert.equal(await outcome, "skipped", "the outcome is the skip that came before the failure");
  await loaded;
  Assert.equal(await storedClicks(browser), null, "the page never got the click");
});

addTidyTask(async function test_a_late_skip_of_an_earlier_step_is_not_the_next_ones() {
  // An earlier step on the same element is refused, as a busy frame's late answer would be; its
  // skip arrives only after the next step was sent, which clicks and loads a page. That click
  // happened: the agent is not told nothing was clicked (it might add to a basket twice).
  Services.prefs.setIntPref(NO_BFCACHE, 0);
  await mcp(true);
  const tab = await openAgentTab();
  const browser = tab.linkedBrowser;
  const c = await agentClient();
  const by = await labels(c, tab);
  await SpecialPowers.spawn(browser.browsingContext, [NEXT], (next) => {
    const win = /** @type {any} */ (content);
    const actor = win.windowGlobalChild.getActor("Vimma");
    const receive = actor.receiveMessage;
    /** @type {any} */
    let first = null;
    /** @param {any} msg */
    actor.receiveMessage = (msg) => {
      if (msg.name !== "Vimma:AgentElement" || msg.data?.op !== "activate") {
        return receive.call(actor, msg);
      }
      if (!first) {
        first = msg.data;
        return "changed";
      }
      actor.receiveMessage = receive;
      const answer = receive.call(actor, msg);
      actor.sendAsyncMessage("Vimma:AgentSkipped", {
        gen: first.gen,
        id: first.id,
        step: first.step,
      });
      // After the click, which runs in a task the child queued as it answered.
      Services.tm.dispatchToMainThread(() => (win.location.href = next));
      return answer;
    };
  });
  const refused = await askedOnce(c, "agent-activate", { tab: idOf(tab), label: by.Go });
  Assert.ok(!refused.ok, "the first step was refused");
  const loaded = BrowserTestUtils.browserLoaded(browser, false, NEXT);
  const r = await askedOnce(c, "agent-activate", { tab: idOf(tab), label: by.Go });
  await loaded;
  Assert.ok(r.ok, `the agent is told its click ran (${r.error?.message ?? "ok"})`);
  Assert.equal(await storedClicks(browser), "1", "the page got the click");
});

/**
 * The status of the next request whose address starts with `prefix`, once it is decided.
 * @param {string} prefix
 * @returns {Promise<number>}
 */
function requestStatus(prefix) {
  return new Promise((resolve) => {
    const observe = (/** @type {any} */ subject) => {
      const channel = subject.QueryInterface(Ci.nsIHttpChannel);
      if (!channel.URI.spec.startsWith(prefix)) return;
      Services.obs.removeObserver(observe, "http-on-modify-request");
      Services.tm.dispatchToMainThread(() => resolve(channel.status));
    };
    Services.obs.addObserver(observe, "http-on-modify-request");
  });
}

add_task(async function test_a_hint_click_after_the_page_was_replaced_clicks_nothing() {
  Services.prefs.setIntPref(NO_BFCACHE, 0);
  const errors = childErrors();
  try {
    await BrowserTestUtils.withNewTab(RACE, async (browser) => {
      await focusContent(browser);
      await until(() => VimmaHost._browserMode(browser) === "normal", "normal mode");
      EventUtils.synthesizeKey("f");
      await until(() => VimmaHost._hints(window)?.hints.length, "hints are up");
      const centre = await SpecialPowers.spawn(browser, [], () => {
        const r = /** @type {Element} */ (content.document.getElementById("go"));
        const box = r.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      });
      const hint = VimmaHost._hints(window)?.hints.find(
        (/** @type {any} */ h) =>
          centre.x >= h.target.rect.x &&
          centre.x <= h.target.rect.x + h.target.rect.width &&
          centre.y >= h.target.rect.y &&
          centre.y <= h.target.rect.y + h.target.rect.height,
      );
      Assert.ok(hint, "the button has a label");
      await holdInChild(browser.browsingContext, "Vimma:ActivateHint", null, NEXT, true);
      const probe = probed();
      const loaded = BrowserTestUtils.browserLoaded(browser, false, NEXT);
      for (const k of hint.label) EventUtils.synthesizeKey(k);
      await loaded;
      Assert.deepEqual(
        await probe,
        { current: false, threw: "", answer: "false" },
        "the old page's child clicked nothing once its page was replaced, and threw nothing",
      );
      Assert.equal(await storedClicks(browser), null, "the page never got the click");
    });
    Assert.deepEqual(errors.errors, [], "no error from the child");
  } finally {
    errors.stop();
    Services.prefs.clearUserPref(NO_BFCACHE);
  }
});
