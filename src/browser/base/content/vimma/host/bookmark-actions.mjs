/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What the bookmark keys do (docs/specs/bookmarks.md): `ctrl+b a` / `:bookmark` and the
// bookmarks panel's effects (open, add, rename, move, delete, copy), over the rename prompt,
// the notice, the split code and bookmark-ops.mjs (Places).

import {
  completeWorkspacePath,
  folderPath,
  formatBookmarkPath,
  rootLabel,
} from "../core/bookmarks.mjs";
import {
  addBookmark,
  addFolder,
  currentPage,
  findBookmark,
  loadScope,
  moveItem,
  placeBookmark,
  removeItem,
  renameItem,
} from "./bookmark-ops.mjs";
import { splitPane } from "./pane-ops.mjs";

/** @import { BookmarksEffect, Folder } from "../core/bookmarks.mjs" */
/** @import { Scope } from "./bookmark-ops.mjs" */
/** @import { RenamePrompt } from "../ui/rename-prompt.mjs" */
/** @import { WindowState } from "./VimmaHost.sys.mjs" */
/** @import { BookmarksPanel } from "../ui/bookmarks-panel.mjs" */

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
 * workspace's container, by the m3 routing), or a new split pane.
 * @param {BookmarkContext} ctx
 * @param {string} url
 * @param {"current" | "tab" | "vertical" | "horizontal"} at
 */
function openBookmark(ctx, url, at) {
  const win = /** @type {any} */ (ctx.win);
  if (at === "tab") {
    win.openTrustedLinkIn(url, "tab", { inBackground: true });
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
 * One effect of the bookmarks panel's keys.
 * @param {BookmarkContext} ctx
 * @param {BookmarksEffect} effect
 */
export function runBookmarkEffect(ctx, effect) {
  const tree = ctx.panel.tree;
  if (!tree) return;
  switch (effect.type) {
    case "open":
      openBookmark(ctx, effect.url, effect.where);
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
