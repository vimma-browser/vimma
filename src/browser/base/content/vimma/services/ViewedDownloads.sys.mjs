/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A download Firefox shows in a tab of its own (a PDF a site serves as an attachment) opens no
// downloads panel (issue #677). The panel opens a moment after that tab and focuses its list
// (browser/components/downloads/content/downloads.js, _focusPanel, again after
// security.dialog_enable_delay), so focus left the page and Vimma's keys went to the panel until
// a click. The new tab is the notice; the downloads button still animates.

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
});

let initialised = false;

const view = {
  /**
   * DownloadsCommon announces a download's start and end from the list's change events, which
   * come after every view has seen it added, and opens the panel only while
   * `openDownloadsListOnStart` is true (DownloadsCommon.sys.mjs, _notifyDownloadEvent); a
   * blocked download (`error`) opens it whatever the flag says, as Firefox's warning.
   * `handleInternally` is final by now: DownloadLegacy starts a download before adding it to
   * the list, and the start runs the integration's shouldBlockForParentalControls at once, where
   * AgentDownloads clears it for an agent's download, which no tab ever shows.
   * @param {any} download
   */
  onDownloadAdded(download) {
    if (download.handleInternally) download.openDownloadsListOnStart = false;
  },
};

export const ViewedDownloads = {
  /** Once per process, before the first download. */
  init() {
    if (initialised) return;
    initialised = true;
    lazy.Downloads.getList(lazy.Downloads.ALL)
      .then((/** @type {any} */ list) => list.addView(view))
      .catch(console.error);
  },
};
