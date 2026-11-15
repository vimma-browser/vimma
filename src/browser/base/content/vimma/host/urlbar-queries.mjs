/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The address bar's queries, for `state.urlbar` (docs/specs/m0-control-protocol-and-vimma-ctl.md,
 * "state"; #1006): whether its suggestion list draws all it will for the text last searched.
 * Firefox starts a query on each key typed in the field and draws each one's results as they
 * come; this follows the query under way through the controller's own notifications, which
 * reach the list first (it listens from the field's start), so the flag turns once the list
 * has drawn the end of the query. It finds the field by its id, never through `gURLBar`: that
 * getter, read before the field exists, leaves the window without one. It starts listening at
 * window init when the field is there, else at the first focus or `state` read; one that starts
 * late counts the field's last query as under way until that query's promise settles, since the
 * notification of its start was missed.
 */
export class UrlbarQueries {
  /** @param {BrowserWindow} win */
  constructor(win) {
    this.win = win;
    /** @type {UrlbarInput | null} the address bar, once found */
    this.bar = null;
    /** @type {UrlbarInput["controller"] | null} the controller listened to (one per field) */
    this.controller = null;
    /** @type {unknown} the id of the query under way (LATE: one begun before listening) */
    this.running = null;
    /** @type {UrlbarQueryListener} */
    this.listener = {
      onQueryStarted: (context) => {
        this.running = context.id;
      },
      onQueryFinished: (context) => this.ended(context.id),
      onQueryCancelled: (context) => this.ended(context.id),
    };
    // A query starts from a focused field: listening from the first focus misses none, unless
    // the field had focus before this window's init (handled in attach).
    this.onFocus = () => this.attach();
    win.addEventListener("focusin", this.onFocus, true);
    this.attach();
  }

  /** Listens to the field's controller, once it exists. */
  attach() {
    if (this.controller) return;
    this.bar ??= /** @type {UrlbarInput | null} */ (this.win.document.getElementById("urlbar"));
    const controller = this.bar?.controller;
    if (!this.bar || !controller) return;
    controller.addListener(this.listener);
    this.controller = controller;
    this.win.removeEventListener("focusin", this.onFocus, true);
    // A query begun before now announced its start unheard: it is under way until the field's
    // last query promise settles (at once when none ran), or until a newer query starts.
    this.running = LATE;
    const done = () => this.ended(LATE);
    this.bar.lastQueryContextPromise.then(done, done);
  }

  /** @param {unknown} id */
  ended(id) {
    if (id === this.running) this.running = null;
  }

  /**
   * `null` while the list is closed; else whether no query is under way and the results it
   * draws are those of the text last searched (`lastSearchString` is set as the query starts,
   * before the controller hears of it: a query held back for the search engines has not
   * started yet).
   * @returns {{ settled: boolean } | null}
   */
  drawn() {
    this.attach();
    const bar = this.bar;
    if (!bar?.view.isOpen) return null;
    const searched = bar.view.queryContext?.searchString === bar.lastSearchString;
    return { settled: this.running === null && searched };
  }

  destroy() {
    this.win.removeEventListener("focusin", this.onFocus, true);
    this.controller?.removeListener(this.listener);
    this.controller = null;
  }
}

/** UrlbarQueries' mark for a query that began before it listened. */
const LATE = Symbol("late");
