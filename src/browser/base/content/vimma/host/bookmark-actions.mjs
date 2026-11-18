/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What the bookmark keys do (docs/specs/bookmarks.md): `ctrl+b a` / `:bookmark`, the
// bookmarks panel's effects (open, add, rename, move, delete, copy) and `:bookmarkopen` /
// `:bookmarktab` (docs/specs/bookmark-open.md), over the rename prompt, the notice, the split
// code and bookmark-ops.mjs (Places).

import { bookmarkOpenItems, bookmarkOpenTarget } from "../core/bookmark-open.mjs";
import {
  bookmarkletDecision,
  completeWorkspacePath,
  folderPath,
  formatBookmarkPath,
  rootLabel,
} from "../core/bookmarks.mjs";
import {
  addBookmark,
  addFolder,
  bookmarkletsSetting,
  currentPage,
  MIRRORED_REFUSAL,
  fetchBookmark,
  findBookmark,
  isMirrored,
  loadAllBookmarks,
  loadScope,
  moveItem,
  placeBookmark,
  removeItem,
  renameItem,
  runBookmarklet,
} from "./bookmark-ops.mjs";
import { splitPane } from "./pane-ops.mjs";

/** @import { BookmarksEffect, Folder } from "../core/bookmarks.mjs" */
/** @import { Scope } from "./bookmark-ops.mjs" */
/** @import { RenamePrompt } from "../ui/rename-prompt.mjs" */
/** @import { WindowState } from "./VimmaHost.sys.mjs" */
/** @import { BookmarksPanel } from "../ui/bookmarks-panel.mjs" */
/** @import { BookmarkItem } from "../core/bookmark-open.mjs" */

/**
 * @typedef {object} BookmarkContext
 * @property {BrowserWindow} win
 * @property {RenamePrompt} prompt
 * @property {BookmarksPanel} panel
 * @property {(text: string) => void} say  the notice
 */

const NOT_BOOKMARKABLE = "bookmark: only http, https, file and about: pages";

/**
 * Runs a Places change and says its outcome (or its error) on the notice.
 * @param {BookmarkContext} ctx
 * @param {() => Promise<string | null | void>} change
 */
function apply(ctx, change) {
  change()
    .then((said) => said && ctx.say(said))
    .catch((e) => {
      console.error("vimma: bookmark change failed", e);
      ctx.say(`bookmark: ${e?.message ?? e}`);
    });
}

/**
 * Tab completion of a path from folder `base` of the scope's tree; `@` completes workspace
 * names, then their folders (spec decision 11).
 * @param {Scope} scope
 * @param {string} base
 */
const completer = (scope, base) => (/** @type {string} */ before) =>
  completeWorkspacePath({ current: scope.tree, workspaces: scope.workspaces }, base, before);

/**
 * How the notice names the top of the tree: "@work", "the bookmarks toolbar".
 * @param {Folder} tree
 */
const topName = (tree) => (tree.root === "workspace" ? rootLabel(tree) : `the ${rootLabel(tree)}`);

/**
 * `ctrl+b a` and `:bookmark [path]`: files the selected page under a typed path from the
 * tree's top, the current workspace's folder by default (a trailing `/`: under its own title;
 * `@name/…`: another workspace's). Already bookmarked, it says where and offers to move or
 * rename that bookmark instead (spec decision 7); one outside every workspace folder is
 * offered at the top under its title.
 * @param {BookmarkContext} ctx
 * @param {string} [text]
 */
export async function quickAdd(ctx, text) {
  const page = currentPage(ctx.win);
  if (!page) {
    ctx.say(NOT_BOOKMARKABLE);
    return;
  }
  const [existing, scope] = await Promise.all([
    findBookmark(ctx.win, page.url),
    loadScope(ctx.win),
  ]);
  const complete = completer(scope, scope.tree.guid);
  if (existing && (await isMirrored(existing.guid))) {
    // docs/specs/bookmarks-file.md Behaviour 11: no move/rename prompt for the file's bookmark.
    ctx.say(`already bookmarked: ${existing.path}; ${MIRRORED_REFUSAL}`);
    return;
  }
  if (existing) {
    ctx.say(
      existing.outside
        ? `already bookmarked outside ${topName(scope.tree)}: ${existing.path}`
        : `already bookmarked: ${existing.path}`,
    );
    ctx.prompt.prompt({
      label: "move/rename: ",
      value: text || existing.value,
      complete,
      submit: (t) => apply(ctx, () => placeBookmark(ctx.win, existing.guid, t)),
    });
    return;
  }
  if (text) {
    apply(ctx, () => addBookmark(ctx.win, text, page));
    return;
  }
  ctx.prompt.prompt({
    label: scope.current ? `bookmark in ${rootLabel(scope.tree)}: ` : "bookmark: ",
    value: page.title,
    caret: 0,
    placeholder: "folder/folder/title",
    complete,
    submit: (t) => apply(ctx, () => addBookmark(ctx.win, t, page)),
  });
}

/**
 * Opens a prompt over the window's scope, read fresh (the `@name/` folders included).
 * @param {BookmarkContext} ctx
 * @param {(scope: Scope) => void} fn
 */
function withScope(ctx, fn) {
  loadScope(ctx.win)
    .then((scope) => {
      if (ctx.panel.isOpen) fn(scope);
    })
    .catch((e) => console.error("vimma: bookmarks could not be read", e));
}

/**
 * A folder's path for a prompt's label: `work/docs/`, or "" for the tree's top.
 * @param {Folder} tree
 * @param {string} guid
 */
function where(tree, guid) {
  const names = folderPath(tree, guid);
  return names.length ? `${formatBookmarkPath(names)}/` : "";
}

/**
 * Loads `url` in the panel's window (spec decision 6): this tab, a background tab (the
 * workspace's container, by the m3 routing), or a new split pane. `foreground`: the new tab is
 * selected, as `:tabnew`'s is (bookmark-open decision 3).
 * @param {BookmarkContext} ctx
 * @param {string} url
 * @param {"current" | "tab" | "vertical" | "horizontal"} at
 * @param {boolean} [foreground]
 */
function openBookmark(ctx, url, at, foreground = false) {
  const win = ctx.win;
  if (at === "tab") {
    win.openTrustedLinkIn(url, "tab", { inBackground: !foreground });
    if (foreground) ctx.panel.close();
    return;
  }
  ctx.panel.close();
  if (at !== "current") {
    const id = at === "vertical" ? "pane.split_vertical" : "pane.split_horizontal";
    const refused = splitPane(ctx.win, { id });
    if (refused) {
      ctx.say(refused);
      return;
    }
  }
  win.openTrustedLinkIn(url, "current", {});
  win.gBrowser.selectedBrowser.focus();
}

/**
 * Opens or runs a stored bookmark the user picked (docs/specs/bookmarklets.md B10): read again
 * from Places by its guid, decided by core `bookmarkletDecision` as the user at the level in
 * force, then loaded (decision 6) or, a bookmarklet, run in the selected tab's page (B7, B8).
 * The bookmarks panel's Enter and l come here, and so do `:bookmarkopen` and `:bookmarktab`
 * (`from: "command"`, docs/specs/bookmark-open.md) with the guid of the bookmark the user
 * picked: typed text picks a stored bookmark and never becomes the URL.
 * @param {BookmarkContext} ctx
 * @param {string} guid
 * @param {"current" | "tab" | "vertical" | "horizontal"} where
 * @param {{ from?: "panel" | "command", listed?: string, page?: PageSeen }} [options]
 *   `from: "command"`: the new tab is in front and the refusals name the command; `listed`: the
 *   bookmark's URL when its row was listed, refused if it changed since;
 *   `page`: the tab and page the command was given on, which a bookmarklet must still run on
 *   (bookmark-open decision 6)
 */
export async function openUserBookmark(ctx, guid, where, { from = "panel", listed, page } = {}) {
  const bm = await fetchBookmark(guid);
  if (!bm) {
    ctx.say("bookmark: it is no longer there");
    return;
  }
  if (listed !== undefined && bm.url !== listed) {
    ctx.say("bookmark: it changed since it was listed: pick it again");
    return;
  }
  const d = bookmarkletDecision({
    url: bm.url,
    setting: bookmarkletsSetting(),
    by: "user",
    where,
    from,
  });
  if (d.kind === "refuse") {
    ctx.say(d.text);
    return;
  }
  if (d.kind === "open") {
    openBookmark(ctx, bm.url, where, from === "command");
    return;
  }
  const browser = ctx.win.gBrowser.selectedBrowser;
  if (page && !samePage(page, browser)) {
    ctx.say("bookmark: the page changed: run it again");
    return;
  }
  const refused = runBookmarklet(browser, bm.url, { popups: true });
  if (refused) {
    ctx.say(refused);
    return;
  }
  ctx.panel.close();
  browser.focus();
}

/**
 * The tab and page a command or picker was asked on.
 * @typedef {{ browser: MozBrowser, uri: string }} PageSeen
 */

/**
 * The selected tab's page now, for openUserBookmark's `page`.
 * @param {BrowserWindow} win
 * @returns {PageSeen}
 */
export function pageSeen(win) {
  const browser = win.gBrowser.selectedBrowser;
  return { browser, uri: browser.currentURI?.spec ?? "" };
}

/**
 * Whether `browser` is the tab, still on the page, the command was given on.
 * @param {PageSeen} page
 * @param {MozBrowser} browser
 */
const samePage = (page, browser) =>
  page.browser === browser && (browser.currentURI?.spec ?? "") === page.uri;

/**
 * `:bookmarkopen [title]` (`where` "current") and `:bookmarktab [title]` ("tab"), docs/specs/
 * bookmark-open.md: every bookmark is read afresh; one titled exactly `text` opens at once
 * through openUserBookmark, several or a part of a title go to `pick` with the text as its
 * query, none is said on the notice.
 * @param {BookmarkContext} ctx
 * @param {string | undefined} text
 * @param {"current" | "tab"} where
 * @param {(items: BookmarkItem[], query: string, page: PageSeen) => void} pick  opens the
 *   bookmark picker; `page` is where the command was given
 */
export async function openBookmarkByTitle(ctx, text, where, pick) {
  const page = pageSeen(ctx.win);
  const items = bookmarkOpenItems(await loadAllBookmarks());
  const target = bookmarkOpenTarget(items, text);
  if (target.kind === "refuse") ctx.say(target.text);
  else if (target.kind === "pick") pick(items, target.query, page);
  else {
    const listed = items.find((i) => i.bookmarkId === target.id)?.listed;
    await openUserBookmark(ctx, target.id, where, { from: "command", listed, page });
  }
}

/**
 * One effect of the bookmarks panel's keys.
 * @param {BookmarkContext} ctx
 * @param {BookmarksEffect} effect
 */
export function runBookmarkEffect(ctx, effect) {
  const tree = ctx.panel.tree;
  if (!tree) return;
  // In a folder bookmarks.toml mirrors, the panel's changes refuse before their prompt opens
  // (docs/specs/bookmarks-file.md Behaviour 11); bookmark-ops checks again when they run.
  const target =
    effect.type === "add" || effect.type === "add_folder"
      ? effect.folder
      : effect.type === "rename" || effect.type === "move" || effect.type === "delete"
        ? effect.guid
        : null;
  if (target !== null) {
    isMirrored(target)
      .then((fileOwned) => (fileOwned ? ctx.say(MIRRORED_REFUSAL) : runEffect(ctx, effect)))
      .catch((e) => console.error("vimma: bookmarks could not be read", e));
    return;
  }
  runEffect(ctx, effect);
}

/**
 * runBookmarkEffect, once a change is allowed.
 * @param {BookmarkContext} ctx
 * @param {BookmarksEffect} effect
 */
function runEffect(ctx, effect) {
  switch (effect.type) {
    case "open":
      openBookmark(ctx, effect.url, effect.where);
      return;
    case "run":
      openUserBookmark(ctx, effect.guid, "current").catch((e) =>
        console.error("vimma: the bookmarklet could not run", e),
      );
      return;
    case "refuse":
      ctx.say(effect.text);
      return;
    case "yank":
      Cc["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Ci.nsIClipboardHelper)
        .copyString(effect.url);
      ctx.say(`copied ${effect.url}`);
      return;
    case "add": {
      const page = currentPage(ctx.win);
      if (!page) {
        ctx.say(NOT_BOOKMARKABLE);
        return;
      }
      const base = effect.folder;
      withScope(ctx, (scope) =>
        ctx.prompt.prompt({
          label: `add in ${where(scope.tree, base) || `${rootLabel(scope.tree)}/`}: `,
          value: page.title,
          caret: 0,
          placeholder: "folder/title, or folder/ for a folder",
          complete: completer(scope, base),
          submit: (t) =>
            apply(ctx, () => addBookmark(ctx.win, t, page, { base, folderOnly: true })),
        }),
      );
      return;
    }
    case "add_folder": {
      const base = effect.folder;
      withScope(ctx, (scope) =>
        ctx.prompt.prompt({
          label: `new folder in ${where(scope.tree, base) || `${rootLabel(scope.tree)}/`}: `,
          complete: completer(scope, base),
          submit: (t) => apply(ctx, () => addFolder(ctx.win, t, base)),
        }),
      );
      return;
    }
    case "rename":
      ctx.prompt.prompt({
        label: "rename: ",
        value: effect.title,
        submit: (t) => apply(ctx, () => renameItem(effect.guid, t)),
      });
      return;
    case "move":
      withScope(ctx, (scope) =>
        ctx.prompt.prompt({
          label: "move to: ",
          value: where(scope.tree, effect.from),
          placeholder: scope.current ? "folder/folder/, or @workspace/folder/" : "folder/folder/",
          complete: completer(scope, scope.tree.guid),
          submit: (t) => apply(ctx, () => moveItem(ctx.win, effect.guid, t)),
        }),
      );
      return;
    case "delete": {
      const what =
        effect.kind === "folder"
          ? `folder ${effect.title} and its ${effect.count} items`
          : effect.title;
      ctx.prompt.ask(`delete ${what}? y/N`, () => apply(ctx, () => removeItem(effect.guid)));
    }
  }
}

/**
 * What the bookmark effects run with.
 * @param {WindowState} s
 */
export function bookmarkContext(s) {
  return {
    win: s.win,
    prompt: s.rename,
    panel: s.bookmarks,
    say: (/** @type {string} */ text) => s.notice.show(text),
  };
}
