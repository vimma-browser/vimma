/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The setup page (docs/specs/setup-v2.md): the welcome screen, one step at a time and a stop
// screen after each chapter. core/setup.mjs keeps the state;
// SetupHost reads the values in force and saves each step on its `enter`. A step is drawn by
// the renderer named after it in RENDERERS, else as a list of choices, so that a later step is
// a row of the step table, its id in BUILT_STEPS and, when it needs more, a renderer here.

/** @import { AddonEntry, FlowContext, FlowEffect, FlowState } from "../core/setup.mjs" */
/** @import { WindowSketch } from "../core/setup-steps.mjs" */

const { ThemeHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ui/theme-host.mjs",
);
const { SetupHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/setup/SetupHost.sys.mjs",
);
const { flowAdvance, flowChapters, flowKey, flowStep, formatUsers, initialFlow } =
  ChromeUtils.importESModule("chrome://browser/content/vimma/core/setup.mjs");
const { HINT_LAYOUTS, actionOutcome, hintRow, rememberKey } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/setup-steps.mjs",
);

const root = document.documentElement;
const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const search = /** @type {HTMLInputElement} */ ($("v2-search"));
/** The page's own browser: the host's key for what this page was sent, and the prompt anchor. */
const browser = () => SetupHost.browserFor(window);

/**
 * @typedef {object} StepView  what SetupHost.stepView returns
 * @property {string} id
 * @property {"setting" | "action"} kind
 * @property {string} title
 * @property {string} question
 * @property {{ tag: "kbd" | "code" | null, text: string }[]} text
 * @property {{ label: string, keep: boolean, lines: string[], note: string | null,
 *   window: WindowSketch | null, run: boolean }[]} choices  `run`: an action step's choice that
 *   acts at `enter`
 * @property {number} selected
 * @property {string[][] | null} prefixKeys  the prefix step's, per choice
 * @property {(string | null)[] | null} layouts  the hint step's letters per choice, null for Keep
 * @property {string | null} blocked
 * @property {string} status  what an action step found (Vimma is the default browser now)
 * @property {number} serial  the host's serial of this list, sent back with `enter`
 */

/** Stop screen headings by chapter; another chapter reads "<name>: done". */
const STOP_TITLES = /** @type {Record<string, string>} */ ({
  essentials: "The essentials are saved",
});

let state = initialFlow({ chapters: flowChapters() });
/** @type {StepView | null} the open step as the host last drew it */
let view = null;
/** Bumped by each request for a view: an older answer is dropped. */
let viewSerial = 0;
/**
 * A load that selects the value in force (an arrival, a refusal) has not been drawn yet: a
 * redraw that supersedes it selects too, so that it never leaves the cursor on a row the user
 * has not come back to.
 */
let freshPending = false;
/** A view is being read: its list may change under the cursor, so `enter` waits. */
let loading = false;
/** "busy" while a save, an install or a search runs: keys wait. */
let busy = false;
/** What the last `enter` wrote, for the footer (behaviour 12): null before one. */
/** @type {{ title: string, lines: string[], action?: boolean, on?: boolean } | null} */
let last = null;
/**
 * The physical key and the character of the letter keys pressed on this page, for the hint
 * step's layout guess (decision 10): kept in this page's memory only, never sent to the host,
 * written or kept after the page closes; rememberKey keeps the latest PRESSED_MAX.
 * @type {import("../core/setup-steps.mjs").PressedKey[]}
 */
let pressed = [];
/**
 * The letters of the layout typed on, guessed once when the hint step opens, so that j and k
 * pressed on the step neither move the guess nor change the note under the list; null when
 * the step opened on the value in force.
 * @type {string | null}
 */
let guessed = null;
/** The content blocker's lists. @type {AddonEntry[]} */
let curated = [];
/** @type {AddonEntry[]} */
let addons = [];
/** The curated list's one load, shared by every visit to the content blocker. */
/** @type {Promise<void> | null} */
let curatedLoad = null;
/** @type {string[]} chapters finished before (welcome ticks) */
let finished = [];

/** @param {string} tag @param {Record<string, string>} attrs @param {...(Node | string)} kids */
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}

/**
 * Step text as nodes, never as HTML (textParts); a line break in the text starts a new line, as
 * the agents step's two lines do (behaviour 28).
 * @param {StepView["text"]} parts
 */
const textNodes = (parts) =>
  parts.flatMap((p) =>
    p.tag
      ? [el(p.tag, {}, p.text)]
      : p.text.split("\n").flatMap((line, i) => (i ? [el("br"), line] : [line])),
  );

/** @type {FlowContext} */
const ctx = {
  get count() {
    const step = flowStep(state);
    if (step?.id === "content_blocker") return addons.length;
    return view?.choices.length ?? 0;
  },
  // The value in force is the host's to say; a step opens on row 0 until its view arrives.
  selected: () => 0,
  get addons() {
    return addons;
  },
  // `enter` names a row only of the list the host sent for this step and the page drew.
  get ready() {
    return !loading && view !== null && view.id === flowStep(state)?.id;
  },
};

/** The footer's place in the chapter (behaviour 11). */
function place() {
  const chapter = state.chapters[state.chapter];
  if (!chapter) return "";
  if (state.screen === "stop") return `${chapter.digit}. ${chapter.name} · done`;
  return `${chapter.digit}. ${chapter.name} · step ${state.step + 1} of ${chapter.steps.length}`;
}

/** @param {string} id @returns {string} */
const titleOf = (id) =>
  state.chapters.flatMap((c) => c.steps).find((s) => s.id === id)?.title ?? id;

/** An action step's saved lines are what it did, in words; a setting step's are TOML. */
const isAction = (/** @type {string} */ id) =>
  state.chapters.flatMap((c) => c.steps).find((s) => s.id === id)?.kind === "action";

/** @param {string} id @param {string} line */
const savedLine = (id, line) => (isAction(id) ? line : el("code", {}, line));

/** @param {import("../core/setup.mjs").FlowSaved[]} list */
function savedList(list) {
  return list.flatMap((x) =>
    x.lines.map((line) =>
      el("li", {}, el("span", { class: "what" }, titleOf(x.step)), savedLine(x.step, line)),
    ),
  );
}

function drawFooter() {
  const footer = $("v2-footer");
  footer.hidden = state.screen !== "step" && state.screen !== "stop";
  $("v2-place").textContent = place();
  $("v2-last").replaceChildren(
    ...(last
      ? [
          `${last.title}: `,
          ...(last.action
            ? [last.lines.join(", ")]
            : last.lines.length
              ? last.lines.flatMap((l, i) => [...(i ? [", "] : []), el("code", {}, l)])
              : [last.on ? "nothing written" : "nothing written, it was already so"]),
          // The agents step's "on" ends `:mcp off` for the session, written or not.
          ...(last.on ? ["; agents are on"] : []),
        ]
      : []),
  );
  $("v2-saved").replaceChildren(
    state.saved.length ? "Saved this run: " : `Nothing saved this run${state.done ? "" : " yet"}.`,
    ...state.saved.flatMap((x, i) => [
      ...(i ? ["; "] : []),
      ...x.lines.flatMap((l, j) => [...(j ? [", "] : []), savedLine(x.step, l)]),
    ]),
  );
  const step = flowStep(state);
  /** @type {(Node | string)[]} */
  const keys = [];
  /** @param {string[]} ks @param {string} what */
  const add = (ks, what) => {
    if (keys.length) keys.push(" · ");
    ks.forEach((k, i) => keys.push(...(i ? ["/"] : []), el("kbd", {}, k)));
    keys.push(` ${what}`);
  };
  if (state.screen === "stop") {
    add(["enter"], state.done ? "close" : "go on");
    add(["h"], "back");
    add(["q"], "leave");
  } else {
    add(["j", "k"], "choose");
    if (step?.id === "content_blocker") {
      add(["space"], "mark");
      add(["/"], "search");
      add(["enter"], "install and go on");
    } else if (view?.blocked) {
      add(["enter"], "cannot save here");
    } else if (step?.kind === "action") {
      add(["enter"], view?.choices[state.cursor]?.run ? "do it and go on" : "go on");
    } else {
      add(["enter"], "save and go on");
    }
    add(["s"], "skip");
    add(["h"], "back");
    add(["q"], "leave");
  }
  $("v2-keys").replaceChildren(...keys);
}

function drawWelcome() {
  $("v2-chapters").replaceChildren(
    ...state.chapters.map((c) =>
      el(
        "li",
        { "data-chapter": c.id, ...(finished.includes(c.id) ? { "data-finished": "true" } : {}) },
        el("kbd", {}, String(c.digit)),
        el("span", { class: "name" }, c.name),
        el("span", { class: "steps" }, c.steps.map((s) => s.title).join(", ")),
        el(
          "span",
          { class: "tick", "aria-label": finished.includes(c.id) ? "done" : "" },
          finished.includes(c.id) ? "✓" : "",
        ),
      ),
    ),
  );
  $("v2-start").focus();
}

/**
 * A small drawing of the window a choice leaves (Page layout): the tab line, the toolbar with
 * its address field, the page and the status bar, each drawn only when the window has it.
 * Square, in the theme's colours; the choice's label says the same in words.
 * @param {WindowSketch} w
 */
function windowDrawing(w) {
  return el(
    "div",
    {
      class: "window",
      "data-toolbar": w.toolbar,
      "data-tabline": w.tabline,
      "aria-hidden": "true",
    },
    ...(w.tabline === "off"
      ? []
      : [
          // "always" draws the line over a single tab, "auto" only once there are two, so
          // the tab line step's two drawings differ as its choices do.
          el(
            "div",
            { class: "w-tabline" },
            el("span", { class: "w-tab current" }),
            ...(w.tabline === "auto" ? [el("span", { class: "w-tab" })] : []),
          ),
        ]),
    ...(w.toolbar === "hidden"
      ? []
      : [
          el(
            "div",
            { class: "w-toolbar" },
            el("span", { class: "w-buttons" }),
            el("span", { class: "w-url" }),
          ),
        ]),
    el(
      "div",
      { class: "w-page" },
      el("span", { class: "w-line" }),
      el("span", { class: "w-line short" }),
    ),
    el("div", { class: "w-status" }),
  );
}

/** @param {StepView} v */
function drawChoices(v) {
  // An action step has no value in force: its choices are what to do now.
  const inForce = (/** @type {number} */ i) => v.kind === "setting" && i === v.selected;
  $("v2-choices").replaceChildren(
    ...v.choices.map((c, i) => {
      const li = el(
        "li",
        { role: "option", "data-index": String(i), ...(c.keep ? { "data-keep": "true" } : {}) },
        el("span", { class: "mark", "aria-hidden": "true" }, inForce(i) ? "●" : "○"),
        el(
          "span",
          { class: "body" },
          el("span", { class: "name" }, c.label),
          ...(c.window ? [windowDrawing(c.window)] : []),
        ),
        el("span", { class: "meta" }, inForce(i) ? "in force" : ""),
      );
      if (i === state.cursor) li.setAttribute("aria-current", "true");
      return li;
    }),
  );
  // A list longer than the window scrolls in its own box (Page layout): keep the cursor in it.
  $("v2-choices").querySelector("[aria-current]")?.scrollIntoView({ block: "nearest" });
  const choice = v.choices[state.cursor];
  // editLines says "Writes nothing" for Keep or the value in force (behaviour 12).
  const nothing = !choice || choice.lines[0] === "Writes nothing";
  $("v2-writes").replaceChildren(
    ...(nothing
      ? ["Writes nothing"]
      : ["Writes ", ...choice.lines.flatMap((l, i) => [...(i ? [", "] : []), el("code", {}, l)])]),
  );
  // What the choice does besides the line: the agents step's hold and workspace notes.
  const note = $("v2-choice-note");
  note.hidden = !choice?.note;
  note.textContent = choice?.note ?? "";
}

function drawAddons() {
  $("v2-addons").replaceChildren(
    ...addons.map((a, i) => {
      const marked = state.marked.has(a.guid);
      const li = el(
        "li",
        { role: "option", "aria-selected": String(marked), "data-guid": a.guid },
        el(
          "span",
          { class: "mark", "aria-hidden": "true" },
          a.installed ? "✓" : marked ? "●" : "○",
        ),
        el(
          "span",
          { class: "body" },
          el("span", { class: "name" }, a.name, el("span", { class: "by" }, ` by ${a.author}`)),
          el("span", { class: "summary" }, a.summary),
        ),
        el(
          "span",
          { class: "meta" },
          a.installed ? "installed" : a.users ? formatUsers(a.users) : "",
        ),
      );
      if (i === state.cursor) li.setAttribute("aria-current", "true");
      if (a.installed || !a.url) li.classList.add("disabled");
      return li;
    }),
  );
  $("v2-addons").querySelector("[aria-current]")?.scrollIntoView({ block: "nearest" });
}

/**
 * Renderers by step id: the content blocker's add-on list; every other step is a list of
 * choices with the line it writes, and, for a step of the window chapter (the address bar, the
 * tab line), a drawing of the window with each choice, from the host's windowSketch. A later
 * step that needs more adds a renderer here.
 * @type {Record<string, (v: StepView) => void>}
 */
const RENDERERS = {
  content_blocker() {
    $("v2-blocker").hidden = false;
    $("v2-choices").hidden = true;
    $("v2-writes-row").hidden = true;
    drawAddons();
  },
  // Each prefix with the key that lists every key under it (behaviour 25).
  prefix_key(v) {
    drawChoices(v);
    for (const li of $("v2-choices").children) {
      const keys = v.prefixKeys?.[Number(li.getAttribute("data-index"))] ?? [];
      if (!keys.length) continue;
      li.querySelector(".body")?.append(
        el(
          "span",
          { class: "hint" },
          ...keys.flatMap((k, i) => [...(i ? [" or "] : []), el("kbd", {}, k)]),
          " lists every key",
        ),
      );
    }
  },
  // Each layout's letters as keys, and where the selected row came from (decision 10).
  hint_letters(v) {
    drawChoices(v);
    const at = guessed === null ? -1 : (v.layouts?.indexOf(guessed) ?? -1);
    const row = at >= 0 ? at : v.selected;
    for (const li of $("v2-choices").children) {
      const i = Number(li.getAttribute("data-index"));
      if (i !== row || i === v.selected) continue;
      li.setAttribute("data-guessed", "true");
      const meta = li.querySelector(".meta");
      if (meta) meta.textContent = "your layout";
    }
    const note = $("v2-guess");
    const name = HINT_LAYOUTS.find((l) => l.chars === v.layouts?.[row])?.name;
    note.hidden = row === v.selected || !name;
    note.textContent = note.hidden
      ? ""
      : `${name} fits the keys you pressed on this page; they are not kept.`;
  },
};

/**
 * The letters of the layout typed on when the hint step's guess moves its cursor off the value
 * in force (hintRow), else null. @param {StepView} v
 */
function guessFor(v) {
  if (!v.layouts) return null;
  const row = hintRow(v.layouts, v.selected, pressed);
  return row === v.selected ? null : (v.layouts[row] ?? null);
}

function drawStep() {
  const step = flowStep(state);
  if (!step) return;
  const chapter = state.chapters[state.chapter];
  $("v2-progress").textContent =
    `${chapter?.name} · ${step.title} · step ${state.step + 1} of ${chapter?.steps.length}`;
  $("v2-question").textContent = step.question;
  root.dataset.stepId = step.id;
  $("v2-blocker").hidden = true;
  $("v2-guess").hidden = true;
  $("v2-choices").hidden = false;
  $("v2-choice-note").hidden = true;
  $("v2-writes-row").hidden = step.kind !== "setting";
  const v = view?.id === step.id ? view : null;
  $("v2-text").replaceChildren(...(v ? textNodes(v.text) : []));
  const notice = $("v2-notice");
  notice.hidden = !v?.blocked;
  notice.textContent = v?.blocked ? `${v.blocked} Press s to skip this step.` : "";
  const status = $("v2-status");
  status.hidden = !v?.status;
  status.textContent = v?.status ?? "";
  if (!v) return;
  (RENDERERS[step.id] ?? drawChoices)(v);
}

function drawStop() {
  const chapter = state.chapters[state.chapter];
  if (!chapter) return;
  $("v2-stop-title").textContent = state.done
    ? "The setup is done"
    : (STOP_TITLES[chapter.id] ?? `${chapter.name}: done`);
  const list = state.done ? state.saved : state.saved.filter((x) => x.chapter === chapter.id);
  const items = savedList(list);
  $("v2-stop-saved").replaceChildren(
    ...(items.length
      ? items
      : [el("li", { class: "none" }, "Nothing was written to config.toml.")]),
  );
  const next = state.chapters[state.chapter + 1];
  $("v2-stop-next").replaceChildren(
    ...(state.done
      ? ["Type ", el("code", {}, ":setup"), " to come back to it."]
      : next
        ? [`Next: ${next.digit}. ${next.name}: ${next.steps.map((s) => s.title).join(", ")}.`]
        : []),
  );
  $("v2-go-on").replaceChildren(el("kbd", {}, "enter"), state.done ? " Close" : " Go on");
  $("v2-done").hidden = state.done;
}

/** The chapter and screen last drawn, to know when a new one opens. */
let drawn = "";

function draw() {
  root.dataset.screen = state.screen;
  const shown = state.screen === "step" ? (flowStep(state)?.id ?? "") : state.screen;
  // The boxes are the same on every screen: a new one opens at its top (Page layout).
  const key = `${state.chapter} ${shown}`;
  if (key !== drawn) {
    drawn = key;
    for (const id of ["v2-step", "v2-choices", "v2-addons", "v2-stop", "v2-stop-saved"]) {
      $(id).scrollTop = 0;
    }
  }
  root.dataset.step = shown;
  $("v2-welcome").hidden = state.screen !== "welcome";
  $("v2-step").hidden = state.screen !== "step";
  $("v2-stop").hidden = state.screen !== "stop";
  if (state.screen === "welcome") drawWelcome();
  if (state.screen === "step") drawStep();
  if (state.screen === "stop") drawStop();
  drawFooter();
}

/**
 * Asks the host for the open step, and selects the value in force when the step just opened;
 * read again (`select` false), the cursor stays on the row with the same label, so a list that
 * gained or lost a row (Keep) never moves it to another choice.
 */
async function loadView(select = true) {
  const step = flowStep(state);
  if (!step) return;
  if (select) freshPending = true;
  select = freshPending;
  const serial = ++viewSerial;
  const under = view?.id === step.id ? view.choices[state.cursor]?.label : undefined;
  loading = true;
  delete root.dataset.viewReady;
  // The content blocker is ready once its add-on list has loaded (or the offline list shows).
  const addonsLoaded = step.id === "content_blocker" ? loadAddons() : null;
  const wasInForce = view?.id === step.id ? view.choices[view.selected]?.label : undefined;
  const v = /** @type {StepView | null} */ (
    await SetupHost.stepView(browser(), step.id, { fresh: select })
  );
  if (serial !== viewSerial || flowStep(state)?.id !== step.id) return;
  loading = false;
  freshPending = false;
  view = v;
  // The agents step drawn again with another row in force (`:mcp off` elsewhere): the cursor
  // follows it, so that turning agents on takes `j` and `enter` on a screen showing the hold.
  if (v && !select && step.id === "agents" && v.choices[v.selected]?.label !== wasInForce) {
    select = true;
  }
  state = { ...state, blocked: !!v?.blocked };
  if (v && step.id !== "content_blocker") {
    const kept = select ? -1 : v.choices.findIndex((c) => c.label === under);
    if (select) guessed = guessFor(v);
    const at = guessed === null ? -1 : (v.layouts?.indexOf(guessed) ?? -1);
    state = { ...state, cursor: kept >= 0 ? kept : at >= 0 ? at : v.selected };
  }
  draw();
  if (addonsLoaded) {
    await addonsLoaded.catch(() => {});
    if (serial !== viewSerial || flowStep(state)?.id !== step.id) return;
  }
  root.dataset.viewReady = "true";
}

/** @returns {Promise<void>} once the curated list (or the offline one) is drawn */
function loadAddons() {
  curatedLoad ??= (async () => {
    const r = await SetupHost.curated();
    curated = r.addons;
    $("v2-offline").hidden = !r.offline;
    if (!search.value) addons = curated;
    draw();
  })();
  return curatedLoad;
}

async function runSearch() {
  const terms = search.value.trim();
  search.blur();
  if (!terms) {
    addons = curated;
    state = { ...state, cursor: 0 };
    draw();
    return;
  }
  root.dataset.searching = "true";
  const r = await SetupHost.search(terms);
  delete root.dataset.searching;
  $("v2-offline").hidden = !r.offline;
  addons = r.offline ? curated : r.addons;
  state = { ...state, cursor: 0 };
  draw();
}

/**
 * The content blocker's `enter` (behaviour 19): each marked add-on in turn, through Firefox's
 * permission prompt, each result shown before the next step opens.
 * @param {AddonEntry[]} list
 */
async function install(list) {
  const results = $("v2-results");
  results.replaceChildren();
  /** @type {string[]} */
  const report = [];
  /** @type {Set<string>} */
  const installed = new Set();
  for (const a of list) {
    const outcome = await SetupHost.install(browser(), a.guid);
    results.append(el("li", { class: outcome }, el("span", {}, a.name), el("span", {}, outcome)));
    report.push(`${a.name} ${outcome}`);
    if (outcome === "installed") installed.add(a.guid);
  }
  addons = addons.map((a) => (installed.has(a.guid) ? { ...a, installed: true } : a));
  return {
    report,
    saved: list.filter((a) => installed.has(a.guid)).map((a) => `${a.name} installed`),
  };
}

/** @param {{ state: FlowState, effect: FlowEffect | null }} r */
async function settle(r) {
  const before = flowStep(state)?.id ?? state.screen;
  state = r.state;
  const effect = r.effect;
  if (effect?.type === "chapter-done") SetupHost.finishChapter(browser(), effect.chapter);
  if (effect?.type === "close") {
    SetupHost.close(browser());
    return;
  }
  if (effect?.type === "search") {
    search.focus();
    search.select();
    return;
  }
  if (effect?.type === "blur") {
    search.blur();
    return;
  }
  if (effect?.type === "run-search") {
    await runSearch();
    return;
  }
  if (effect?.type === "save" || effect?.type === "install" || effect?.type === "action") {
    busy = true;
    root.dataset.busy = "true";
    try {
      await runEnter(effect);
    } finally {
      busy = false;
      delete root.dataset.busy;
    }
    return;
  }
  const after = flowStep(state)?.id ?? state.screen;
  if (after !== before && state.screen === "step") {
    view = null;
    $("v2-results").replaceChildren();
    draw();
    await loadView();
    return;
  }
  draw();
}

/**
 * `enter` on a Moving in step (behaviours 22 and 23): Make Default, or the import wizard, whose
 * dialog holds the step until it closes. A result that acted is listed as saved; one that could
 * not act keeps the step open, drawn again for what the system allows now.
 * @param {Extract<FlowEffect, { type: "action" }>} effect
 */
async function runAction(effect) {
  const step = flowStep(state);
  if (!step) return;
  const r = await SetupHost.runAction(browser(), effect.step, effect.index, view?.serial);
  if ("stale" in r || "error" in r) {
    await loadView();
    const notice = $("v2-notice");
    notice.hidden = false;
    notice.textContent =
      "error" in r ? `Not done: ${r.error}` : "The choices changed. Choose again.";
    return;
  }
  const o = actionOutcome(step.id, r.result);
  if (!o.advance) {
    await loadView();
    const notice = $("v2-notice");
    notice.hidden = false;
    notice.textContent =
      r.result === "failed"
        ? `${o.said} Press enter to try again or s to skip this step.`
        : `${o.said} Press s to skip this step.`;
    root.dataset.failed = "true";
    return;
  }
  delete root.dataset.failed;
  last = { title: step.title, lines: [o.said], action: true };
  await settle(flowAdvance(state, ctx, o.saved));
}

/** @param {Extract<FlowEffect, { type: "save" } | { type: "install" } | { type: "action" }>} effect */
async function runEnter(effect) {
  const step = flowStep(state);
  if (!step) return;
  if (effect.type === "action") {
    await runAction(effect);
    return;
  }
  if (effect.type === "install") {
    const { report, saved } = await install(effect.addons);
    last = { title: step.title, lines: report, action: true };
    await settle(flowAdvance(state, ctx, saved));
    return;
  }
  const r = await SetupHost.saveStep(browser(), effect.step, effect.index, view?.serial);
  if ("stale" in r) {
    // The list changed since it was drawn: the engine went away (behaviour 20), the file was
    // read again, or the Omarchy theme is gone. Nothing was written; draw the list as it is now.
    await loadView();
    const notice = $("v2-notice");
    notice.hidden = false;
    notice.textContent =
      step.id === "search_engine"
        ? "That engine is no longer installed; nothing was written. Choose again."
        : "The choices changed; nothing was written. Choose again.";
    return;
  }
  if ("error" in r) {
    // The agents step's consent is spent, as a refused yes to `:mcp on` is: drawn again, with
    // what `:mcp` says now and the cursor on the row in force, so that a second `enter` at once
    // turns nothing on.
    if (step.id === "agents") await loadView(true);
    // A failed write keeps the step open and says why (behaviour 16).
    const notice = $("v2-notice");
    notice.hidden = false;
    notice.textContent = `Not saved: ${r.error}`;
    root.dataset.failed = "true";
    return;
  }
  delete root.dataset.failed;
  last = { title: step.title, lines: r.written, ...("turnedOn" in r ? { on: true } : {}) };
  await settle(flowAdvance(state, ctx, r.written));
}

/** @param {KeyboardEvent} e */
function keyName(e) {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  if (/^[1-9]$/.test(e.key)) return e.key;
  return (
    {
      Enter: "enter",
      Escape: "esc",
      " ": "space",
      ArrowDown: "down",
      ArrowUp: "up",
      j: "j",
      k: "k",
      s: "s",
      h: "h",
      q: "q",
      "/": "/",
    }[e.key] ?? null
  );
}

/** @param {string} key */
function onKey(key) {
  if (busy) return;
  settle(flowKey(state, key, ctx));
}

/** Wires the page. */
function start() {
  ThemeHost.attachDocument(document);
  document.addEventListener("keydown", (e) => {
    // Only the user's own keys drive the page (behaviour 29, Security "Trusted input only").
    if (!e.isTrusted) return;
    pressed = rememberKey(
      pressed,
      { code: e.code, key: e.key },
      { ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey },
    );
    if (e.target === search) {
      // In the field only enter and esc are the page's; `q` and the rest are typed (behaviour 7).
      if (e.key !== "Enter" && e.key !== "Escape") return;
      e.preventDefault();
      onKey(e.key === "Enter" ? "enter" : "esc");
      return;
    }
    // Tab and the buttons stay the browser's own.
    if (e.key === "Enter" && e.target instanceof HTMLButtonElement) return;
    const key = keyName(e);
    if (!key) return;
    e.preventDefault();
    onKey(key);
  });

  // A click into the field is the same as `/`: its keys are typed until enter or esc.
  search.addEventListener("focus", () => {
    if (!state.searching) state = { ...state, searching: true };
  });
  search.addEventListener("blur", () => {
    if (state.searching) state = { ...state, searching: false };
  });

  $("v2-start").addEventListener("click", (e) => e.isTrusted && onKey("enter"));
  $("v2-skip").addEventListener("click", (e) => e.isTrusted && onKey("q"));
  $("v2-go-on").addEventListener("click", (e) => e.isTrusted && onKey("enter"));
  $("v2-done").addEventListener("click", (e) => e.isTrusted && onKey("q"));

  // config.toml read again while a step is open: draw its line from the new value in force
  // (behaviour 12), keeping the row under the cursor.
  const onConfigRead = () => {
    if (state.screen === "step") loadView(false);
  };
  Services.obs.addObserver(onConfigRead, SetupHost.CONFIG_READ_TOPIC);
  // `:mcp on|off` changes the agents step's value in force, and what its `enter` is checked
  // against: draw it again.
  Services.obs.addObserver(onConfigRead, SetupHost.MCP_CHANGED_TOPIC);
  window.addEventListener("unload", () => {
    Services.obs.removeObserver(onConfigRead, SetupHost.CONFIG_READ_TOPIC);
    Services.obs.removeObserver(onConfigRead, SetupHost.MCP_CHANGED_TOPIC);
  });

  SetupHost.flowStart(browser()).then((s) => {
    finished = s.finished;
    state = { ...state, blocked: s.private || !!s.problem };
    const notice = $("v2-config-error");
    notice.hidden = !s.problem && !s.private;
    notice.textContent = s.private
      ? "This is a private window: setting steps cannot save here and can only be skipped."
      : s.problem
        ? `${s.problem}. Setting steps save nothing until it loads; add-ons still install.`
        : "";
    draw();
    root.dataset.ready = "true";
  });
  draw();
}

start();
