/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Firefox's own shortcuts that overlap Vimma's keys, off (spec: docs/specs/key-handling-batch.md
// § 1, docs/specs/firefox-keys.md decision 2). No patch: the `<key>` elements of every keyset of
// the window (#mainKeyset, the DevTools' #devtoolsKeyset, the conditional ones) get
// `disabled="true"`, which dom/events/GlobalKeyListener.cpp reads at key time (CanHandle →
// KeyElementIsDisabled), so a disabled shortcut neither runs nor is reserved: the page gets the
// chord. Core firefox-keys.mjs decides which; this reads the elements and writes the attribute.

import { FIREFOX_SHORTCUTS, planFirefoxKeys, xulKeyChord } from "../core/firefox-keys.mjs";

/** @import { FirefoxKeySetting } from "../core/config.mjs" */

/** Firefox's own keyset: a window without it (not a browser window) is left alone. */
const KEYSET_ID = "mainKeyset";
/** Marks a key we disabled, so we only ever re-enable our own. */
const MARK = "vimma-disabled";
/** Attributes whose change can change a key's chord or undo our `disabled`. */
const WATCHED = ["key", "keycode", "modifiers", "disabled"];

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
});

/** @type {FirefoxKeySetting} */
export const DEFAULT_FIREFOX_KEYS = Object.freeze({
  disable: /** @type {"all"} */ ("all"),
  enable: [],
});

/**
 * One `<key>` as about:vimma lists it.
 * @typedef {{ chord: string, id: string, command: string }} FirefoxKeyRow
 * @typedef {{ chord: string, id: string, label: string }} FirefoxOnRow
 */

export class FirefoxKeys {
  /**
   * @param {Window} win  a browser window
   * @param {FirefoxKeySetting} setting
   * @param {ReadonlySet<string>} [bound]  the chords Vimma binds (core boundChords)
   */
  constructor(win, setting, bound = new Set()) {
    this.win = win;
    this.setting = setting;
    /** @type {ReadonlySet<string>} chords Vimma binds: their Firefox keys are off */
    this.bound = bound;
    /** @type {string[]} chords of the setting that no key has */
    this.unmatched = [];
    /** @type {MutationObserver | null} */
    this.observer = null;
    /** Set by destroy(): a late DOMContentLoaded must not start it again. */
    this.destroyed = false;
  }

  get mac() {
    return lazy.AppConstants.platform === "macosx";
  }

  /** The window's main keyset, or null (a window without Firefox's keys). */
  get keyset() {
    return this.win.document.getElementById(KEYSET_ID);
  }

  /** Every keyset of the window: DevTools and others add theirs after startup. */
  keysets() {
    return /** @type {Element[]} */ ([...this.win.document.querySelectorAll("keyset")]);
  }

  /**
   * Applies the setting now and again whenever Fluent or Firefox changes a key. VimmaHost starts
   * in browser.xhtml's <head>, before the keyset is parsed: then it waits for the document.
   */
  init() {
    if (this.win.document.readyState === "loading") {
      this.win.addEventListener("DOMContentLoaded", () => this.init(), { once: true });
      return;
    }
    const keyset = this.keyset;
    if (!keyset || this.observer || this.destroyed) return;
    this.apply();
    const { MutationObserver } = /** @type {typeof globalThis} */ (
      /** @type {unknown} */ (this.win)
    );
    const observer = new MutationObserver((records) => {
      // A keyset added (DevTools hook their keys in late) or re-inserted: watch it too.
      const keysetMoved = records.some(
        (r) =>
          r.type === "childList" &&
          [...r.addedNodes, ...r.removedNodes].some(
            (n) => /** @type {Element} */ (n).localName === "keyset",
          ),
      );
      if (keysetMoved) this.watch(observer);
      // Our own writes come back as records too; apply() writes only what differs, so this ends.
      // The body and the root report every child they gain: only a keyset there matters.
      const { body, documentElement } = this.win.document;
      const keyChange = records.some(
        (r) =>
          r.target !== body &&
          r.target !== documentElement &&
          (r.type === "childList" || r.attributeName !== MARK),
      );
      if (keysetMoved || keyChange) this.apply();
    });
    this.observer = observer;
    this.watch(observer);
  }

  /**
   * Watches every keyset's keys, and where keysets are added (the body, the root element).
   * @param {MutationObserver} observer
   */
  watch(observer) {
    const doc = this.win.document;
    for (const parent of [doc.body, doc.documentElement]) {
      if (parent) observer.observe(parent, { childList: true });
    }
    for (const keyset of this.keysets()) {
      observer.observe(keyset, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: [...WATCHED, MARK],
      });
    }
  }

  /**
   * @param {FirefoxKeySetting} setting
   * @param {ReadonlySet<string>} [bound]  absent keeps the current one
   */
  set(setting, bound) {
    this.setting = setting;
    if (bound) this.bound = bound;
    this.apply();
  }

  /** Every `<key>` of the window's keysets with its chord, as the plan reads them. */
  keys() {
    const els = /** @type {Element[]} */ (
      // Add-on shortcuts are the add-on's, set in about:addons; ExtensionShortcuts.sys.mjs gives
      // each add-on a keyset with the id ext-keyset-id-<add-on id>.
      this.keyset
        ? [...this.win.document.querySelectorAll('keyset:not([id^="ext-keyset-id-"]) key')]
        : []
    );
    return els.map((el) => ({
      el,
      chord: xulKeyChord(
        {
          key: el.getAttribute("key"),
          keycode: el.getAttribute("keycode"),
          modifiers: el.getAttribute("modifiers"),
        },
        { mac: this.mac },
      ),
      internal: el.getAttribute("internal") === "true",
      // Firefox's own disabled keys (key_exitFullScreen until full screen) are not ours to list.
      firefoxOff: el.getAttribute("disabled") === "true" && !el.hasAttribute(MARK),
    }));
  }

  /** Disables the keys the setting turns off; re-enables ours that it no longer turns off. */
  apply() {
    const keys = this.keys();
    const plan = planFirefoxKeys(
      keys.filter((k) => !k.firefoxOff),
      this.setting,
      { bound: this.bound },
    );
    const off = new Set(plan.off.map((k) => k.el));
    for (const { el } of keys) {
      if (off.has(el)) {
        if (!el.hasAttribute(MARK)) el.setAttribute(MARK, "true");
        if (el.getAttribute("disabled") !== "true") el.setAttribute("disabled", "true");
      } else if (el.hasAttribute(MARK)) {
        el.removeAttribute(MARK);
        el.removeAttribute("disabled");
      }
    }
    this.unmatched = plan.unmatched;
  }

  /**
   * What about:vimma and the help overlay show: the keys `[firefox] enable` keeps on, each with
   * what it does (the inventory's words, else its command); the keys off, in keyset order; and
   * the chords of the setting that match none.
   * @returns {{ on: FirefoxOnRow[], off: FirefoxKeyRow[], unmatched: string[] }}
   */
  status() {
    const keys = this.keys();
    const off = keys
      .filter((k) => k.el.hasAttribute(MARK))
      .map((k) => ({
        chord: /** @type {string} */ (k.chord),
        id: k.el.id,
        command: k.el.getAttribute("command") ?? "",
      }));
    const enabled = new Set(this.setting.enable);
    const on = keys
      .filter((k) => k.chord && enabled.has(k.chord) && !k.firefoxOff && !k.internal)
      .map((k) => {
        const chord = /** @type {string} */ (k.chord);
        const row = FIREFOX_SHORTCUTS.find((r) => r.chord === chord && r.id === k.el.id);
        const label = row?.does ?? k.el.getAttribute("command") ?? k.el.id;
        return { chord, id: k.el.id, label };
      });
    return { on, off, unmatched: [...this.unmatched] };
  }

  /**
   * Whether `chord` runs a Firefox shortcut now (not one we turned off), so a text-field key
   * on the same chord gives way to it.
   * @param {string} chord canonical
   */
  fires(chord) {
    return this.keys().some(
      (k) => k.chord === chord && !k.internal && k.el.getAttribute("disabled") !== "true",
    );
  }

  /** Stops watching and gives Firefox its keys back (VimmaHost.uninit). */
  destroy() {
    this.observer?.disconnect();
    this.observer = null;
    this.destroyed = true;
    for (const { el } of this.keys()) {
      if (!el.hasAttribute(MARK)) continue;
      el.removeAttribute(MARK);
      el.removeAttribute("disabled");
    }
  }
}
