/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The always-visible status bar (spec: docs/specs/m2-statusbar-whichkey.md; the which-key strip
// was dropped: only prefix+? lists the bindings).
// vimma-core decides what it says (statusbar.mjs); this module gathers the inputs from the
// window and the host, renders at most once per frame, and never reads layout on the render
// path: the bar's width comes from a ResizeObserver.

import {
  fitStatus,
  securityFromState,
  sharingCues,
  statusAnnouncement,
  statusSegments,
} from "../core/statusbar.mjs";
import { HIDDEN_ATTR as TOOLBAR_HIDDEN_ATTR } from "./toolbar.mjs";

/** @import { Mode } from "../core/modes.mjs" */
/** @import { FindStatus } from "../core/find.mjs" */
/** @import { Announced, Segment, StatusInput } from "../core/statusbar.mjs" */

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserUIUtils: "resource:///modules/BrowserUIUtils.sys.mjs",
});

export const STATUSBAR_ID = "vimma-statusbar";
const STYLESHEET = "chrome://browser/skin/vimma/statusbar.css";
const HTML_NS = "http://www.w3.org/1999/xhtml";
/** Characters in the probe that measures one column of the bar's font. */
const PROBE_CHARS = 10;
// SSTabRestoring: a restored tab's rename (m2-picker-rename) arrives with its session data.
const TAB_EVENTS = [
  "TabSelect",
  "TabOpen",
  "TabClose",
  "TabMove",
  "TabAttrModified",
  "TabShow",
  "SSTabRestoring",
];
/** @type {WeakSet<Window>} windows our sheets are loaded into (loading one twice throws) */
const styled = new WeakSet();

/**
 * The slice of tabbrowser this module reads (browser/components/tabbrowser/content/tabbrowser.js).
 * @typedef {Element & { label: string, linkedBrowser: BrowserElement }} Tab
 * @typedef {Element & { contentTitle: string, currentURI: { spec: string } }} BrowserElement
 * @typedef {{
 *   selectedTab: Tab,
 *   visibleTabs: Tab[],
 *   addProgressListener(l: object): void,
 *   removeProgressListener(l: object): void,
 * }} Tabbrowser
 * @typedef {Window & { gBrowser: Tabbrowser, ResizeObserver: typeof ResizeObserver }} BrowserWindow
 */

/** @import { ConfigError } from "../core/config.mjs" */

/**
 * @typedef {object} StatusBarHost  what the bar needs from VimmaHost, as plain functions
 * @property {() => { mode: Mode, pending: readonly string[], find?: FindStatus | null,
 *   pane?: { index: number, count: number } | null,
 *   workspace?: { name: string, index: number, color?: string } | null,
 *   configErrors?: readonly ConfigError[], configFile?: string,
 *   alerts?: readonly string[],
 *   agent?: { waiting: number, minutes: number | null, ran: boolean,
 *     builtin?: string | null } | null,
 *   update?: import("../core/updates.mjs").UpdateNotice | null,
 *   element?: import("../core/statusbar.mjs").ElementStatus | null }} status
 * @property {(fn: () => void) => () => void} subscribe  host state changes; returns unsubscribe
 * @property {(tab: Element) => string | null} [labelFor]  a user's tab rename (tab rename spec)
 */

export class StatusBar {
  /**
   * @param {Window} win  a browser window, possibly before its body exists
   * @param {StatusBarHost} host
   */
  constructor(win, host) {
    this.win = /** @type {BrowserWindow} */ (win);
    this.host = host;
    /** @type {HTMLElement | null} */
    this.bar = null;
    /** @type {HTMLElement | null} */
    this.left = null;
    /** @type {HTMLElement | null} */
    this.right = null;
    /** @type {HTMLElement | null} */
    this.live = null;
    /** @type {HTMLElement | null} */
    this.probe = null;
    /** bar content width in CSS px, from the ResizeObserver */
    this.width = 0;
    /** one column of the bar's font in CSS px; 0 until measured */
    this.column = 0;
    this.frame = 0;
    this.lastBar = "";
    /** @type {Announced} what the live region last said */
    this.announced = { mode: null, notFound: null };
    /** @type {ResizeObserver | null} */
    this.resize = null;
    /** @type {MutationObserver | null} the address bar's "in use" icons (toolbar-toggle 12) */
    this.identity = null;
    /** @type {(() => void) | null} */
    this.unsubscribe = null;
    this.update = () => this.schedule();
    this.start = () => this.build();
    // The identity box (not secure, toolbar-toggle 12) follows the security state.
    this.progress = {
      onLocationChange: () => this.schedule(),
      onSecurityChange: () => this.schedule(),
    };
  }

  init() {
    if (this.win.document.readyState === "loading") {
      // After browser-main.js's own DOMContentLoaded listener, which creates gBrowser.
      this.win.addEventListener("DOMContentLoaded", this.start, { once: true });
    } else {
      this.build();
    }
  }

  uninit() {
    const win = this.win;
    win.removeEventListener("DOMContentLoaded", this.start);
    if (this.frame) win.cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.resize?.disconnect();
    this.resize = null;
    this.identity?.disconnect();
    this.identity = null;
    if (this.bar) {
      for (const type of TAB_EVENTS) win.removeEventListener(type, this.update, true);
      win.removeEventListener("focus", this.update, true);
      win.gBrowser?.removeProgressListener(this.progress);
    }
    this.bar?.remove();
    this.bar = this.left = this.right = this.live = this.probe = null;
  }

  /** Mark dirty; one render per frame however many triggers fire. */
  schedule() {
    if (this.frame || !this.bar) return;
    this.frame = this.win.requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  /** @private */
  build() {
    const win = this.win;
    const doc = win.document;
    const anchor = doc.getElementById("browser");
    if (this.bar || !anchor) return;
    // The theme tokens are ui/theme-host.mjs's sheet (spec m5-omarchy-theme), loaded by vimma.js.
    if (!styled.has(win)) {
      win.windowUtils.loadSheetUsingURIString(STYLESHEET, win.windowUtils.AUTHOR_SHEET);
      styled.add(win);
    }
    /**
     * @param {string} tag
     * @param {string} [className]
     */
    const el = (tag, className) => {
      const node = /** @type {HTMLElement} */ (doc.createElementNS(HTML_NS, tag));
      if (className) node.className = className;
      return node;
    };

    const bar = el("div");
    bar.id = STATUSBAR_ID;
    // role=status is a polite live region; switch it off so title and URL changes stay quiet,
    // and announce the mode through its own region.
    bar.setAttribute("role", "status");
    bar.setAttribute("aria-live", "off");
    bar.setAttribute("aria-label", "Vimma status bar");
    this.left = el("div", "vimma-sb-side vimma-sb-left");
    this.right = el("div", "vimma-sb-side vimma-sb-right");
    this.live = el("span", "vimma-sb-live");
    this.live.setAttribute("aria-live", "polite");
    this.live.setAttribute("aria-atomic", "true");
    this.probe = el("span", "vimma-sb-probe");
    this.probe.setAttribute("aria-hidden", "true");
    this.probe.textContent = "0".repeat(PROBE_CHARS);

    bar.append(this.left, this.right, this.live, this.probe);
    anchor.after(bar);
    this.bar = bar;

    // Layout is fresh inside a ResizeObserver callback: measuring here forces no extra reflow.
    // The probe is observed too, so a font change (`[theme] font`, a zoom) re-measures the
    // column even when the bar keeps its width.
    this.resize = new win.ResizeObserver((entries) => {
      let refit = false;
      for (const entry of entries) {
        if (entry.target === this.bar) {
          this.width = entry.contentBoxSize[0]?.inlineSize ?? entry.contentRect.width;
          refit = true;
        } else if (entry.target === this.probe) {
          const w = entry.contentRect.width / PROBE_CHARS;
          if (w > 0 && w !== this.column) {
            this.column = w;
            refit = true;
          }
        }
      }
      if (refit) this.schedule();
    });
    this.resize.observe(bar);
    this.resize.observe(this.probe);

    for (const type of TAB_EVENTS) win.addEventListener(type, this.update, true);
    // Focus moving into or out of a field changes the mode once the host detects it.
    win.addEventListener("focus", this.update, true);
    win.gBrowser.addProgressListener(this.progress);
    // Location, XR and serial use change no tab attribute; Firefox marks them on the address
    // bar's sharing icons (gPermissionPanel.updateSharingIndicator), for the selected tab.
    const permissionBox = doc.getElementById("identity-permission-box");
    if (permissionBox) {
      this.identity = new /** @type {any} */ (win).MutationObserver(() => this.schedule());
      /** @type {MutationObserver} */ (this.identity).observe(permissionBox, {
        attributes: true,
        subtree: true,
        attributeFilter: ["sharing", "paused"],
      });
    }
    this.unsubscribe = this.host.subscribe(this.update);
    this.schedule();
  }

  /** @private */
  input() {
    const status = this.host.status();
    const { mode, pending, find = null, pane = null, workspace = null } = status;
    const gBrowser = this.win.gBrowser;
    const tab = gBrowser.selectedTab;
    const visible = gBrowser.visibleTabs;
    const browser = tab.linkedBrowser;
    /** @type {StatusInput} */
    const input = {
      mode,
      pending,
      tab: {
        index: visible.indexOf(tab) + 1,
        count: visible.length,
        title: browser.contentTitle || tab.label || null,
        ...barUrl(this.win, browser),
        label: this.host.labelFor?.(tab) ?? null,
      },
      loading: tab.hasAttribute("busy"),
      find,
      pane,
      workspace,
      configErrors: status.configErrors ?? [],
      configFile: status.configFile ?? "config.toml",
      alerts: status.alerts ?? [],
      agent: status.agent ?? null,
      update: status.update ?? null,
      element: status.element ?? null,
    };
    // docs/specs/toolbar-toggle.md decision 12: the hidden toolbar's cues; shown, none.
    const root = this.win.document.documentElement;
    if (root.hasAttribute(TOOLBAR_HIDDEN_ATTR)) {
      input.toolbarHidden = true;
      input.security = securityOf(browser);
      input.privateWindow = root.hasAttribute("privatebrowsingmode");
      input.sharing = sharingCues(/** @type {any} */ (browser)._sharingState);
    }
    return input;
  }

  /** @private */
  render() {
    if (!this.bar) return;
    this.renderBar(this.input());
  }

  /**
   * @private
   * @param {StatusInput} input
   */
  renderBar(input) {
    const all = statusSegments(input);
    const columns = this.column > 0 ? Math.floor(this.width / this.column + 0.01) : 0;
    // A badge (a segment with a background) has half a column of padding on each side.
    const badges = all.filter((s) => s.bg).length;
    const fitted = fitStatus(all, columns - badges);
    const key = JSON.stringify(fitted.map((s) => [s.id, s.text, s.fg, s.bg]));
    if (key !== this.lastBar) {
      this.lastBar = key;
      /** @type {(side: "left" | "right") => HTMLElement[]} */
      const side = (which) => fitted.filter((s) => s.side === which).map((s) => this.segment(s));
      /** @type {HTMLElement} */ (this.left).replaceChildren(...side("left"));
      /** @type {HTMLElement} */ (this.right).replaceChildren(...side("right"));
    }
    // Spoken once, and not where focused UI speaks already (core statusAnnouncement).
    const { text, last } = statusAnnouncement(this.announced, {
      mode: input.mode,
      find: input.find,
      url: input.tab?.url ?? null,
      agentWaiting: input.agent?.waiting ?? 0,
      element: input.element ?? null,
    });
    this.announced = last;
    if (text !== null) /** @type {HTMLElement} */ (this.live).textContent = text;
  }

  /**
   * @private
   * @param {Segment} s
   */
  segment(s) {
    const span = /** @type {HTMLElement} */ (this.win.document.createElementNS(HTML_NS, "span"));
    span.className = "vimma-sb-segment";
    span.dataset.segment = s.id;
    span.textContent = s.text;
    span.style.color = `var(${s.fg})`;
    if (s.bg) {
      span.classList.add("vimma-sb-badge");
      span.style.backgroundColor = `var(${s.bg})`;
    }
    return span;
  }
}

/** @typedef {import("../core/statusbar.mjs").UrlOrigin} UrlOrigin */

/**
 * The host as the bar shows it and its registrable domain, for truncation that never cuts the
 * latter (docs/security.md C3). The base domain is counted in labels from the
 * ASCII form Services.eTLD answers in, then taken from the display form, so an IDN host keeps
 * its Unicode. An IP address, or a host without a public suffix, is its own base.
 * @param {any} uri
 * @returns {UrlOrigin | null}
 */
function originOf(uri) {
  /** @type {string} */
  let host;
  try {
    host = uri.displayHost;
  } catch {
    return null;
  }
  if (!host) return null;
  let base = host;
  try {
    const labels = Services.eTLD.getBaseDomain(uri).split(".").length;
    base = host.split(".").slice(-labels).join(".");
  } catch {
    // An IP address or a single-label host: the whole host stays.
  }
  return { host, base };
}

/**
 * The tab's address for the bar, and its origin. An initial page (about:blank, the start page)
 * shows no address only when Firefox's address bar would show none
 * (BrowserUIUtils.checkEmptyPageOrigin): an about:blank a page opened or wrote into reads
 * `about:blank from <the page that controls it>` (docs/security.md C3).
 * @param {Window} win
 * @param {any} browser
 * @returns {{ url: string | null, origin: UrlOrigin | null }}
 */
function barUrl(win, browser) {
  const uri = browser.currentURI;
  if (!uri) return { url: null, origin: null };
  const initial = /** @type {any} */ (win).isInitialPage?.(uri) ?? uri.spec === "about:blank";
  if (initial || uri.spec === "about:blank") {
    /** @type {boolean} */
    let empty;
    try {
      empty = lazy.BrowserUIUtils.checkEmptyPageOrigin(browser, uri);
    } catch {
      empty = uri.spec !== "about:blank";
    }
    if (empty) return { url: null, origin: null };
    // The page's own principal, inherited from whoever wrote it: never the opener's current
    // one, which may have navigated elsewhere since (C3). Unknown: the address alone.
    const principal = [
      browser.browsingContext?.currentWindowGlobal?.documentPrincipal,
      browser.contentPrincipal,
    ].find((p) => p?.isContentPrincipal);
    if (principal) {
      try {
        const from = Services.io.newURI(principal.originNoSuffix);
        const origin = originOf(from);
        if (origin) return { url: `${uri.spec} from ${origin.host}`, origin };
      } catch {
        // No origin to name: the address alone.
      }
    }
    return { url: uri.spec, origin: null };
  }
  return { url: displaySpec(browser), origin: originOf(uri) ?? innerOrigin(browser, uri) };
}

/**
 * The origin of a URL without a host of its own: a nested one's inner URL (view-source:), else
 * the page's principal (blob:, which carries its creator's origin), so the bar can still keep
 * that origin's domain whole (docs/security.md C3).
 * @param {any} browser
 * @param {any} uri
 * @returns {UrlOrigin | null}
 */
function innerOrigin(browser, uri) {
  try {
    const inner = uri.QueryInterface(Ci.nsINestedURI).innermostURI;
    const origin = originOf(inner);
    if (origin) return origin;
  } catch {
    // Not a nested URL.
  }
  const principal = browser.browsingContext?.currentWindowGlobal?.documentPrincipal;
  if (!principal?.isContentPrincipal) return null;
  try {
    return originOf(Services.io.newURI(principal.originNoSuffix));
  } catch {
    return null;
  }
}

/**
 * The selected page's connection, from the browser's security state as Firefox's identity
 * block reads it (browser-siteIdentity.js), never from the address bar, so an unsent edit in
 * the hidden address bar changes nothing (docs/security.md C3).
 * @param {any} browser
 */
function securityOf(browser) {
  const W = Ci.nsIWebProgressListener;
  const state = browser.securityUI?.state ?? 0;
  const doc = browser.documentURI;
  const errorPage =
    doc?.scheme === "about" &&
    (doc.filePath === "certerror" ||
      doc.filePath === "httpsonlyerror" ||
      (doc.filePath === "neterror" && new URLSearchParams(doc.query).get("e") === "nssFailure2"));
  return securityFromState({
    scheme: browser.currentURI?.scheme ?? "",
    secure: !!(state & W.STATE_IS_SECURE),
    broken: !!(state & W.STATE_IS_BROKEN),
    certOverride: !!(state & W.STATE_CERT_USER_OVERRIDDEN),
    errorPage,
    // As gIdentityHandler._getIsSecureContext: the security UI's own flag (http on the
    // loopback address is a secure context). The parent's WindowGlobal has no isSecureContext.
    secureContext: !!browser.securityUI?.isSecureContext,
  });
}

/**
 * The URL as the user may see it: no credentials (createExposableURI), IDN decoded; none for
 * an empty tab.
 * @param {BrowserElement} browser
 * @returns {string | null}
 */
function displaySpec(browser) {
  const uri = browser.currentURI;
  if (!uri || uri.spec === "about:blank") return null;
  try {
    return Services.io.createExposableURI(uri).displaySpec;
  } catch {
    return uri.spec;
  }
}
