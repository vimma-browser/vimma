/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Firefox's navigation toolbar and Bookmarks Toolbar from Vimma's keys and the command line
// (docs/specs/toolbar-toggle.md, docs/specs/bookmarks-toolbar-hidden.md): each sets the state
// for every window and says which in the notice.

import { bookmarksToolbarNotice } from "../core/bookmarks-toolbar.mjs";
import { BookmarksToolbar } from "../ui/bookmarks-toolbar.mjs";
import { Toolbar } from "../ui/toolbar.mjs";
import { BROWSER_KEYS, runKey } from "./browser-ops.mjs";

/** @import { parseBookmarksToolbarCommand, parseToolbarCommand } from "../core/cmdline.mjs" */
/** @import { WindowState } from "./VimmaHost.sys.mjs" */

/**
 * `ctrl+b u`, `:toolbar [show|hide]` (docs/specs/toolbar-toggle.md decisions 1, 2): one state
 * for every window (the pref); the notice says which, through the polite live region.
 * @param {WindowState} s
 * @param {ReturnType<typeof parseToolbarCommand>} command
 */
export function setToolbar(s, command) {
  s.notice.hide();
  if (command.kind === "refuse") {
    s.notice.show(command.text, { error: true });
    return;
  }
  const hidden = command.kind === "toggle" ? !Toolbar.hidden : command.kind === "hide";
  Toolbar.setHidden(hidden);
  s.notice.show(hidden ? "toolbar hidden" : "toolbar shown");
}

/**
 * Firefox's Bookmarks Toolbar (docs/specs/bookmarks-toolbar-hidden.md): one state for every
 * window. Without a word, Firefox's own toggle (its ctrl+shift+b handler, between "always" and
 * "never"); a word sets that state. The notice says which, and "until restart" while
 * config.toml sets the key (decision 4).
 * @param {WindowState} s
 * @param {ReturnType<typeof parseBookmarksToolbarCommand>} command
 */
export function setBookmarksToolbar(s, command) {
  s.notice.hide();
  if (command.kind === "refuse") {
    s.notice.show(command.text, { error: true });
    return;
  }
  if (command.kind === "set") BookmarksToolbar.set(command.setting);
  else if (!runKey(s.win, BROWSER_KEYS["browser.bookmarks_toolbar"])) return;
  s.notice.show(bookmarksToolbarNotice(BookmarksToolbar.visibility, BookmarksToolbar.configured));
}
