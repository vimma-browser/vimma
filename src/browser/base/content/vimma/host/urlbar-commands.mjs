/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A `:` line in the start page's address bar (docs/specs/start-page-commands.md; #1271). A new tab opens on the start page with the address bar focused, and the
 * page advertises `:` for commands, so a line typed there that starts with `:` is a Vimma command
 * line, never a search: no web address starts with `:`. On any other page the address bar is
 * Firefox's, unchanged.
 *
 * Two hooks, both without an upstream patch:
 * - a result provider for the address bar that, for such a line, outranks every other provider,
 *   so none of them runs: the search engine's suggestion endpoint never sees the line, and the
 *   drop-down offers no "search for" row;
 * - per window, the field's `handleCommand` and `handleNavigation`, through which every Enter,
 *   the go button, Paste & Go and a drop reach a load (UrlbarInputBase.mjs, Firefox 160). A
 *   plain or shift+Enter that the user pressed runs the line, as Enter does on the command line;
 *   anything else (alt, ctrl or meta+Enter, Paste & Go, a drop, a click) only puts it on the
 *   command line, so text a page put on the clipboard or dragged never runs without an Enter.
 */

/**
 * start/StartPage.sys.mjs START_PAGE_URL; `host/` may not import `start/` (ADR-026), so
 * browser_vimma_start_commands.js checks that the two agree.
 */
export const START_PAGE_URL = "chrome://browser/content/vimma/start/start.html";

/** Above every built-in provider's (UrlbarProviderSearchTips, 2, is the highest in 160). */
const PRIORITY = 1000;

/**
 * The command line in `text`, the address bar's value: what follows its first `:`, or null when
 * it does not start with one (leading spaces aside, which Firefox would trim before searching).
 * @param {string} text
 * @returns {string | null}
 */
export function colonLine(text) {
  const m = /^\s*:/.exec(text);
  return m ? text.slice(m[0].length) : null;
}

/**
 * Whether the window's selected tab shows the start page.
 * @param {BrowserWindow | null | undefined} win
 */
export function onStartPage(win) {
  return win?.gBrowser?.selectedBrowser?.currentURI?.spec === START_PAGE_URL;
}

/**
 * Whether `event` is an Enter the user pressed that the command line itself would run: not
 * synthesized by a script, not mid-composition, and with no modifier but shift (the line
 * ignores ctrl, alt and meta+Enter: ui/cmdline.mjs onKeyDown).
 * @param {Event | null | undefined} event
 */
export function runsLine(event) {
  if (!event?.isTrusted || event.type !== "keydown") return false;
  const key = /** @type {KeyboardEvent} */ (event);
  return key.key === "Enter" && !key.isComposing && !key.ctrlKey && !key.altKey && !key.metaKey;
}

let registered = false;

/**
 * Registers the provider once per process: the address bar's providers are shared by every
 * window (UrlbarProvidersManager, one manager per search access point).
 */
function registerProvider() {
  if (registered) return;
  registered = true;
  const { UrlbarProvider } = ChromeUtils.importESModule(
    "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs",
  );
  const { ProvidersManager } = ChromeUtils.importESModule(
    "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs",
  );
  const { UrlbarShared } = ChromeUtils.importESModule(
    "chrome://browser/content/urlbar/UrlbarShared.mjs",
  );
  class VimmaColonLine extends UrlbarProvider {
    get name() {
      return "VimmaColonLine";
    }
    // Heuristic: run first and fast, as the manager awaits these before showing anything.
    get type() {
      return UrlbarShared.PROVIDER_TYPE.HEURISTIC;
    }
    /**
     * @param {{ sapName: string, trimmedSearchString: string }} context
     * @param {{ browserWindow?: BrowserWindow } | null} controller
     */
    async isActive(context, controller) {
      return (
        context.sapName === "urlbar" &&
        context.trimmedSearchString.startsWith(":") &&
        onStartPage(controller?.browserWindow)
      );
    }
    getPriority() {
      return PRIORITY;
    }
    // No results: the drop-down stays closed, and Enter is handled by UrlbarCommands.
    async startQuery() {}
  }
  ProvidersManager.getInstanceForSap("urlbar").registerProvider(new VimmaColonLine());
}

/** A window's address bar hooks. */
export class UrlbarCommands {
  /**
   * @param {BrowserWindow} win
   * @param {(line: string, run: boolean) => void} take  gets the line after its `:`, and whether
   *   to run it (else it only goes on the command line)
   */
  constructor(win, take) {
    this.win = win;
    this.take = take;
    /** @type {UrlbarInput | null} */
    this.bar = null;
    /** @type {{ handleCommand: Function, handleNavigation: Function } | null} ours, to undo */
    this.wrapped = null;
    registerProvider();
    // The field may not exist yet at window init (urlbar-queries.mjs): hook it at first focus.
    this.onFocus = () => this.attach();
    win.addEventListener("focusin", this.onFocus, true);
    this.attach();
  }

  /** Wraps the field's two ways to a load, once it exists. */
  attach() {
    if (this.bar) return;
    const bar = /** @type {UrlbarInput | null} */ (this.win.document.getElementById("urlbar"));
    if (!bar?.handleCommand || !bar.handleNavigation) return;
    this.bar = bar;
    this.win.removeEventListener("focusin", this.onFocus, true);
    const self = this;
    const handleCommand = bar.handleCommand;
    const handleNavigation = bar.handleNavigation;
    // Own properties over the prototype's methods; handleCommand calls this.handleNavigation, so
    // a line that gets past one (it cannot: both decide alike) is still caught by the other.
    /** @type {UrlbarInput["handleCommand"]} */
    bar.handleCommand = function (event = null) {
      // A right click does nothing in Firefox's handleCommand either.
      const rightClick =
        event?.type !== "keydown" && /** @type {MouseEvent} */ (event)?.button === 2;
      if (rightClick || !self.intercept(event)) handleCommand.call(this, event);
    };
    /** @type {UrlbarInput["handleNavigation"]} */
    bar.handleNavigation = function (params) {
      if (!self.intercept(params?.event ?? null)) handleNavigation.call(this, params);
    };
    this.wrapped = { handleCommand: bar.handleCommand, handleNavigation: bar.handleNavigation };
  }

  /**
   * Takes the field's line when it is a `:` line on the start page: empties the field and hands
   * the line over after this event, from outside Firefox's handler. Returns whether it took it.
   * @param {Event | null | undefined} event
   */
  intercept(event) {
    const bar = /** @type {UrlbarInput} */ (this.bar);
    const line = colonLine(bar.value);
    if (line === null || !onStartPage(this.win)) return false;
    const run = runsLine(event);
    event?.preventDefault();
    bar.handleRevert();
    bar.view.close();
    this.win.setTimeout(() => this.take(line, run), 0);
    return true;
  }

  destroy() {
    this.win.removeEventListener("focusin", this.onFocus, true);
    const bar = /** @type {Partial<UrlbarInput> | null} */ (this.bar);
    // Only while ours are still there: a wrapper someone added over them stays.
    if (bar && this.wrapped) {
      if (bar.handleCommand === this.wrapped.handleCommand) delete bar.handleCommand;
      if (bar.handleNavigation === this.wrapped.handleNavigation) delete bar.handleNavigation;
    }
    this.bar = null;
    this.wrapped = null;
  }
}
