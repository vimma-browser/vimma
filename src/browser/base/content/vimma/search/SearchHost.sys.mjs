/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// config.toml's `[search]` applied to Firefox's search engines (spec:
// docs/specs/search-engines.md). One per app. ConfigHost hands over the resolved section on every
// change of the file; this module reads the profile's engines, lets core's planSearch decide the
// steps, runs them on SearchService and records what it did in one pref, so that removing a line
// puts back what was there before. It runs again when engines are added or removed (an add-on's
// engine that loads late can then be named). Templates become user engines with an `@alias` and no
// suggestion URL; installed engines get a user alias; the default is set with reason USER. Problems
// that depend on the profile's engines come back as config errors with their line. It also keeps
// the `@aliases` the URL bar knows, for `:open @` completion.

import {
  appliedAliases,
  parseSearchState,
  planSearch,
  searchCompletions,
} from "../core/search.mjs";
import { formatPath } from "../core/toml.mjs";

/** @import { ConfigError } from "../core/config.mjs" */
/** @import { InstalledEngine, ResolvedSearch, SearchState, SearchStep } from "../core/search.mjs" */
/** @import { Path } from "../core/toml.mjs" */

/**
 * @typedef {"clearTimeout" | "SearchService" | "setTimeout" | "UrlbarSearchUtils"} LazyName
 */
const lazy = /** @type {Lazy<LazyName>} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  UrlbarSearchUtils: "moz-src:///browser/components/urlbar/UrlbarSearchUtils.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/** What Vimma applied last (core's SearchState, JSON); per profile (decision 6). */
const STATE_PREF = "vimma.search.applied";
const ENGINE_TOPIC = "browser-search-engine-modified";
/** Engines added or removed: once they settle (an add-on adds several at once). */
const DEBOUNCE_MS = 500;
/** A search URL's type (SearchUtils.URL_TYPE.SEARCH). */
const SEARCH_TYPE = "text/html";

/** @type {ResolvedSearch | null} */
let config = null;
/** Whether ConfigHost has handed over a config yet: nothing runs before it. */
let configured = false;
/** @type {(path: Path) => number | undefined} the config file's line of a key */
let lineOf = () => undefined;
/** @type {ConfigError[]} */
let errors = [];
/** @type {{ alias: string, engine: string }[]} every `@alias` the URL bar knows */
let tokenAliases = [];
/** @type {Promise<void> | null} */
let running = null;
let again = false;
/** @type {number | null} */
let timer = null;
/** @type {((done: Promise<void>) => void)[]} settled() calls waiting for the timer */
const timerWaiters = [];
/** An engine came or went since the timer started: reconcile, not only re-read the aliases. */
let enginesChanged = false;
let observing = false;
/** @type {() => void} */
let onErrors = () => {};

/** @returns {SearchState | null} */
function readState() {
  const { state, problem } = parseSearchState(Services.prefs.getStringPref(STATE_PREF, ""));
  // Discarded whole: [search] then applies as on a first run, and the next apply rewrites it.
  if (problem) console.warn(`vimma: ${problem}`);
  return state;
}

/** @param {SearchState | null} state */
function writeState(state) {
  if (state) Services.prefs.setStringPref(STATE_PREF, JSON.stringify(state));
  else Services.prefs.clearUserPref(STATE_PREF);
}

/**
 * The profile's engines as core reads them.
 * @param {any[]} engines
 * @returns {InstalledEngine[]}
 */
function describe(engines) {
  return engines.map((e) => {
    const url = e._urls?.find((/** @type {any} */ u) => u.type === SEARCH_TYPE)?.template;
    return {
      id: e.id,
      name: e.name,
      alias: e.alias ?? "",
      aliases: [...(e.aliases ?? [])],
      hidden: !!e.hidden,
      ...(typeof url === "string" ? { url } : {}),
    };
  });
}

/**
 * Runs one step; a failure is logged and the rest go on.
 * @param {Exclude<SearchStep, { created: string }>} step
 * @returns {Promise<string | null>} the id a create or set-default produced
 */
async function run(step) {
  const s = lazy.SearchService;
  const byId = (/** @type {string} */ id) => s.getEngineById(id);
  switch (step.op) {
    case "create": {
      const engine = await s.addUserEngine({
        name: step.name,
        url: step.url,
        alias: `@${step.alias}`,
      });
      return engine.id;
    }
    case "update":
      byId(step.id)?.changeUrl(SEARCH_TYPE, step.url, null);
      return null;
    case "rename":
      if (!byId(step.id)?.rename(step.name)) {
        console.warn(
          `vimma: [search] cannot rename an engine to "${step.name}": the name is taken`,
        );
      }
      return null;
    case "remove": {
      const engine = byId(step.id);
      if (engine) await s.removeEngine(engine, s.CHANGE_REASON.USER);
      return null;
    }
    case "set-alias": {
      const engine = byId(step.id);
      if (engine) engine.alias = step.alias;
      return null;
    }
    case "set-default": {
      const engine = byId(step.id);
      if (engine) await s.setDefault(engine, s.CHANGE_REASON.USER);
      return engine?.id ?? null;
    }
  }
  return null;
}

/** Reconciles once: plan, run, record, report. */
async function reconcile() {
  const previous = readState();
  if (!config && !previous) {
    setErrors([]);
    return;
  }
  const s = lazy.SearchService;
  await s.init();
  const plan = planSearch(previous, config, {
    engines: describe(await s.getEngines()),
    defaultId: s.defaultEngine?.id ?? "",
  });
  /** @type {Map<string, string>} */
  const made = new Map();
  for (const step of plan.steps) {
    try {
      if (step.op === "set-default" && "created" in step) {
        const id = made.get(step.created);
        if (id) await run({ op: "set-default", id });
        continue;
      }
      const id = await run(step);
      if (step.op === "create" && id) made.set(step.alias, id);
    } catch (e) {
      console.error(`vimma: [search] ${step.op} failed`, e);
    }
  }
  const state = plan.state;
  if (state) {
    state.created = state.created.flatMap((c) => {
      const id = c.id ?? made.get(c.alias);
      return id ? [{ ...c, id }] : [];
    });
    if (state.default && state.default.set === null) {
      const wanted = config?.default;
      const id = wanted?.kind === "template" ? made.get(wanted.alias) : undefined;
      state.default = id ? { ...state.default, set: id } : (previous?.default ?? null);
    }
  }
  writeState(state);
  setErrors(
    plan.problems.map(({ path, message, suggestion }) => {
      const line = lineOf(path);
      return {
        ...(line === undefined ? {} : { line }),
        path: formatPath(path),
        message,
        ...(suggestion ? { suggestion } : {}),
      };
    }),
  );
}

/** @param {ConfigError[]} next */
function setErrors(next) {
  const same = JSON.stringify(next) === JSON.stringify(errors);
  errors = next;
  if (!same) onErrors();
}

/** The `@aliases` the URL bar knows, with their engines (Firefox's and Vimma's). */
async function refreshAliases() {
  try {
    const list = await lazy.UrlbarSearchUtils.tokenAliasEngines();
    tokenAliases = list.flatMap((/** @type {any} */ { engine, tokenAliases: aliases }) =>
      aliases.map((/** @type {string} */ alias) => ({ alias, engine: engine.name })),
    );
  } catch (e) {
    console.warn("vimma: search aliases not read", e);
  }
}

/** One reconcile at a time; a change during one runs another after it. */
function schedule() {
  if (running) {
    again = true;
    return running;
  }
  running = reconcile()
    .catch((e) => console.error("vimma: [search] not applied", e))
    .then(refreshAliases)
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        schedule();
      }
    });
  return running;
}

/**
 * @param {unknown} _subject
 * @param {string} _topic
 * @param {string | null} data
 */
function onEngine(_subject, _topic, data) {
  if (data !== "engine-added" && data !== "engine-removed" && data !== "engine-changed") return;
  // Only engines coming or going need a reconcile; an alias changed is ours or the user's.
  if (data !== "engine-changed") enginesChanged = true;
  if (timer !== null) lazy.clearTimeout(timer);
  timer = lazy.setTimeout(() => {
    timer = null;
    const reconcileToo = enginesChanged;
    enginesChanged = false;
    const done = reconcileToo ? schedule() : refreshAliases();
    for (const resolve of timerWaiters.splice(0)) resolve(done);
  }, DEBOUNCE_MS);
}

export const SearchHost = {
  /**
   * config.toml's `[search]` (core's resolved form; null without the section), applied now.
   * @param {ResolvedSearch | null} search
   * @param {(path: Path) => number | undefined} [locate]  the line of a key in the file
   * @returns {Promise<void>} settled once applied
   */
  setConfig(search, locate = () => undefined) {
    config = search;
    lineOf = locate;
    configured = true;
    if (!observing) {
      observing = true;
      Services.obs.addObserver(onEngine, ENGINE_TOPIC);
    }
    return schedule();
  },

  /**
   * Called when the problems change (ConfigHost re-reports them).
   * @param {() => void} fn
   */
  set onErrors(fn) {
    onErrors = fn;
  },

  /**
   * Settles once no reconcile is running or waiting for engines to settle, so that a test can
   * act on the engines as Vimma left them.
   * @returns {Promise<void>}
   */
  async settled() {
    while (timer !== null || running) {
      if (timer !== null) await new Promise((resolve) => timerWaiters.push(resolve));
      else await running;
    }
  },

  /** Problems only the profile's engines reveal (decision 9), as config errors. */
  get errors() {
    return configured ? errors : [];
  },

  /** `:open @` completion: every `@alias` with its engine. */
  get completions() {
    return searchCompletions(tokenAliases);
  },

  /**
   * about:vimma's Search line (decision 14): the default and whether the file set it, the
   * aliases that applied with their engines.
   */
  get status() {
    const s = lazy.SearchService;
    const engine = s.isInitialized ? s.defaultEngine : null;
    const state = readState();
    return {
      default: engine?.name ?? null,
      fromConfig: !!config?.default && !!state?.default && state.default.set === engine?.id,
      // An engine Vimma made is named after its template's host: the report names the alias.
      template: state?.created.find((c) => c.id === engine?.id)?.alias ?? null,
      aliases: appliedAliases(config?.aliases ?? [], state).map((a) => ({
        alias: `@${a.alias}`,
        engine: a.kind === "engine" ? a.name : a.host,
        unencrypted: a.kind === "template" && /^http:/i.test(a.url),
      })),
    };
  },
};
