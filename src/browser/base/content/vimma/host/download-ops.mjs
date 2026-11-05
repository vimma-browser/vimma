/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The window's downloads for the status bar's `↓` segment (docs/specs/downloads.md, Behaviour 12
// and decision 9): a view on the window's Firefox download list, read into core
// DownloadRecords. Read only: nothing here starts, opens or changes a download.

import { downloadSegment, downloadSummary } from "../core/downloads.mjs";

/** @import { DownloadRecord, DownloadSegment } from "../core/downloads.mjs" */

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

/** docs/specs/downloads.md decision 20; removed by the sub-PR that turns the feature on. */
export const DOWNLOADS_FEATURE_PREF = "vimma.feature.downloads";

/** A per-session id for each Firefox `Download` object, so a row keeps its download. */
const ids = new WeakMap();
let nextId = 1;

/** @param {any} download */
function idOf(download) {
  let id = ids.get(download);
  if (id === undefined) {
    id = nextId++;
    ids.set(download, id);
  }
  return id;
}

/** @param {any} error  a Downloads.Error, or null */
function errorOf(error) {
  if (!error) return null;
  /** @type {"parental" | "reputation" | "contentAnalysis" | "failed"} */
  const kind = error.becauseBlockedByParentalControls
    ? "parental"
    : error.becauseBlockedByReputationCheck
      ? "reputation"
      : error.becauseBlockedByContentAnalysis
        ? "contentAnalysis"
        : "failed";
  return {
    kind,
    verdict: String(error.reputationCheckVerdict ?? ""),
    reason: String(error.message ?? ""),
  };
}

/**
 * A Firefox `Download` (toolkit/components/downloads/DownloadCore.sys.mjs) as a core record.
 * @param {any} d
 * @returns {DownloadRecord}
 */
export function recordOf(d) {
  const referrer = d.source?.referrerInfo?.originalReferrer?.spec ?? null;
  return {
    id: idOf(d),
    name: PathUtils.filename(d.target.path),
    url: d.source.url,
    path: d.target.path,
    referrer,
    stopped: d.stopped,
    succeeded: d.succeeded,
    canceled: d.canceled,
    deleted: !!d.deleted,
    hasProgress: d.hasProgress,
    hasPartialData: d.hasPartialData,
    hasBlockedData: d.hasBlockedData,
    currentBytes: d.currentBytes,
    totalBytes: d.totalBytes,
    size: d.target.size ?? 0,
    speed: d.speed,
    targetExists: !!d.target.exists,
    partFileExists: !!d.target.partFileExists,
    error: errorOf(d.error),
    startTime: d.startTime ? d.startTime.getTime() : 0,
    endTime: d.endTime ? new Date(d.endTime).getTime() : null,
    viewsInternally: false,
    // The segment counts every download of the window's kind; which workspace a row belongs to
    // and whether it is an agent's matter only to the picker's rows.
    workspace: null,
    agent: false,
  };
}

/**
 * One window's view on its download list: the private session's in a private window, the
 * profile's otherwise (decision 3), so a private download is never counted in a normal window.
 */
export class DownloadWatch {
  /**
   * @param {Window} win
   * @param {() => void} emit  the segment changed
   */
  constructor(win, emit) {
    this.win = win;
    this.emit = emit;
    /** @type {Set<any>} */
    this.downloads = new Set();
    /** @type {any} */
    this.list = null;
    this.view = null;
    /** @type {DownloadSegment | null} */
    this.current = null;
    this.text = "null";
    this.destroyed = false;
    this.observe = () => void this.sync().catch(console.error);
    Services.prefs.addObserver(DOWNLOADS_FEATURE_PREF, this.observe);
    this.observe();
  }

  get on() {
    return Services.prefs.getBoolPref(DOWNLOADS_FEATURE_PREF, false);
  }

  /** @private Attach to the list while the feature is on; detach while it is off. */
  async sync() {
    if (this.on && !this.view) {
      const view = {
        /** @param {any} d */
        onDownloadAdded: (d) => (this.downloads.add(d), this.changed()),
        onDownloadChanged: () => this.changed(),
        /** @param {any} d */
        onDownloadRemoved: (d) => (this.downloads.delete(d), this.changed()),
      };
      this.view = view;
      const priv = lazy.PrivateBrowsingUtils.isWindowPrivate(this.win);
      const list = await lazy.Downloads.getList(
        priv ? lazy.Downloads.PRIVATE : lazy.Downloads.PUBLIC,
      );
      if (this.view !== view || this.destroyed) return;
      this.list = list;
      await list.addView(view);
    } else if (!this.on && this.view) {
      this.detach();
      this.changed();
    }
  }

  /** @private */
  detach() {
    if (this.list && this.view) this.list.removeView(this.view);
    this.list = null;
    this.view = null;
    this.downloads.clear();
  }

  /** @private Progress fires on every chunk; the bar hears only of a change it shows. */
  changed() {
    this.current = this.compute();
    const text = JSON.stringify(this.current);
    if (text === this.text) return;
    this.text = text;
    this.emit();
  }

  /**
   * The segment as last computed: the bar asks on every host change, downloads change it rarely.
   * @returns {DownloadSegment | null}
   */
  segment() {
    return this.current;
  }

  /** @private */
  compute() {
    if (!this.view || !this.on) return null;
    const records = [...this.downloads].map(recordOf);
    // The end states (`done`, `failed`, `blocked`) clear when the picker opens, so they come
    // with it (Delivery 3).
    return downloadSegment(downloadSummary(records), null, Date.now());
  }

  destroy() {
    this.destroyed = true;
    Services.prefs.removeObserver(DOWNLOADS_FEATURE_PREF, this.observe);
    this.detach();
  }
}
