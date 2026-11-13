/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The add-on picker's and `:addon`'s operations (docs/specs/addon-manager.md) over Firefox's
// AddonManager, the way about:addons does them (toolkit/mozapps/extensions/content/). Every op
// looks the add-on up again by id through core's filter, so a system, built-in or hidden add-on
// is never acted on. Chrome-only: VimmaHost runs these from keys and the command line, nothing
// from page content. Each op returns the text for the notice, or null.

import { addonChanged, addonItems, bestAddon, removeAddonQuestion } from "../core/addons.mjs";
import { Toolbar } from "../ui/toolbar.mjs";

/** @import { AddonItem, AddonRecord } from "../core/addons.mjs" */
/** @import { AddonOp } from "../core/picker.mjs" */
/** @import { WindowState } from "./VimmaHost.sys.mjs" */

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  ExtensionPermissions: "resource://gre/modules/ExtensionPermissions.sys.mjs",
});

/** about:addons' "Run in Private Windows" permission (components/addon-card.mjs). */
const PRIVATE_BROWSING_PERM = "internal:privateBrowsingAllowed";

/**
 * The permissions object ExtensionPermissions.add/remove take; a new one each call, because
 * they write into it (`data_collection`).
 */
const privateBrowsingPerms = () => ({ permissions: [PRIVATE_BROWSING_PERM], origins: [] });

export const ADDON_GONE = "that add-on is gone";

/**
 * Every installed extension, as core reads them.
 * @returns {Promise<{ records: AddonRecord[], byId: Map<string, any> }>}
 */
async function readAddons() {
  const { AddonManager } = lazy;
  const [addons, installs] = await Promise.all([
    AddonManager.getAddonsByTypes(["extension"]),
    AddonManager.getAllInstalls(),
  ]);
  const updating = new Set(
    installs.flatMap((/** @type {any} */ i) => (i.existingAddon ? [i.existingAddon.id] : [])),
  );
  const records = await Promise.all(
    addons.map(async (/** @type {any} */ a) => {
      /** @type {AddonRecord} */
      const record = {
        id: a.id,
        name: a.name ?? a.id,
        version: a.version ?? "",
        type: a.type,
        enabled: !a.userDisabled,
        isSystem: !!a.isSystem,
        isBuiltin: !!a.isBuiltin,
        hidden: !!a.hidden,
        privateAllowed: false,
        update: updating.has(a.id) || !!a.pendingUpgrade,
      };
      if (a.incognito !== "not_allowed" && !record.hidden && !record.isSystem) {
        const perms = await lazy.ExtensionPermissions.get(a.id);
        record.privateAllowed = perms.permissions.includes(PRIVATE_BROWSING_PERM);
      }
      return record;
    }),
  );
  return { records, byId: new Map(addons.map((/** @type {any} */ a) => [a.id, a])) };
}

/**
 * The picker's rows.
 * @returns {Promise<AddonItem[]>}
 */
export async function addonPickerItems() {
  return addonItems((await readAddons()).records);
}

/**
 * The listed add-on with `id`, as item and AddonManager wrapper, or null (gone, or never
 * listed: system, built-in, hidden).
 * @param {string} id
 * @returns {Promise<{ item: AddonItem, addon: any } | null>}
 */
async function listed(id) {
  const { records, byId } = await readAddons();
  const item = addonItems(records).find((i) => i.addonId === id);
  return item ? { item, addon: byId.get(id) } : null;
}

/**
 * @param {any} addon
 * @param {string} name  an AddonManager PERM_CAN_* constant's name
 */
function can(addon, name) {
  return !!(addon.permissions & lazy.AddonManager[name]);
}

/** Names of the listed add-ons, for `:addon` Tab completion; kept fresh by a listener. */
/** @type {string[]} */
let names = [];
let watching = false;

async function refreshNames() {
  try {
    names = (await addonPickerItems()).map((i) => i.display);
  } catch (e) {
    console.error("vimma: add-on names", e);
  }
}

/**
 * The names `:addon` completes. The first call starts an AddonManager listener that keeps them
 * current (install, remove, enable, disable).
 * @returns {readonly string[]}
 */
export function addonNames() {
  if (!watching) {
    watching = true;
    const refresh = () => void refreshNames();
    lazy.AddonManager.addAddonListener({
      onInstalled: refresh,
      onUninstalled: refresh,
      onEnabled: refresh,
      onDisabled: refresh,
      onPropertyChanged: refresh,
    });
    refresh();
  }
  return names;
}

/**
 * Enter in the picker, and `:addon`: the add-on's toolbar button as a click, through Firefox's
 * own keyboard path (the `_execute_action` shortcut's `triggerAction`): its popup, which takes
 * focus, or its `onClicked` command. A button in the Unified Extensions panel opens that panel
 * first and the popup anchors there.
 * @param {Window} win
 * @param {AddonItem} item
 * @returns {string | null}
 */
export function openAddonPopup(win, item) {
  if (!item.enabled) return `${item.display} is disabled (x in ctrl+b e enables it)`;
  const policy = /** @type {any} */ (globalThis).WebExtensionPolicy.getByID(item.addonId);
  const action = policy && /** @type {any} */ (win).gUnifiedExtensions?.browserActionFor(policy);
  if (!action) return `${item.display}: no popup or button`;
  // A hidden toolbar shows in full first, so the popup hangs from its own button or the
  // extensions menu as with the toolbar shown (docs/specs/toolbar-toggle.md decision 10).
  if (action.action?.getPopupUrl?.(/** @type {any} */ (win).gBrowser.selectedTab)) {
    Toolbar.get(win)?.holdForPopup("addon", "full");
  }
  action.triggerAction(win);
  return null;
}

/**
 * `:addon <name>`: the best match's popup.
 * @param {Window} win
 * @param {string} text
 * @returns {Promise<string | null>}
 */
export async function openAddonByName(win, text) {
  const item = bestAddon(await addonPickerItems(), text);
  if (!item) return `no add-on matches "${text}"`;
  return openAddonPopup(win, item);
}

/**
 * Enter in the picker: the add-on with `id`.
 * @param {Window} win
 * @param {string} id
 * @returns {Promise<string | null>}
 */
export async function openAddonById(win, id) {
  const found = await listed(id);
  return found ? openAddonPopup(win, found.item) : ADDON_GONE;
}

/**
 * `o`: the options page in a tab (a tab already showing it is selected), as about:addons'
 * openOptionsInTab, also for an inline options page; without one, about:addons' details.
 * @param {Window} win
 * @param {string} id
 * @returns {Promise<string | null>}
 */
export async function openAddonOptions(win, id) {
  const found = await listed(id);
  if (!found) return ADDON_GONE;
  const w = /** @type {any} */ (win);
  const url = found.addon.optionsURL;
  if (url) {
    w.switchToTabHavingURI(url, true, {
      relatedToCurrent: true,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
    return null;
  }
  await w.BrowserAddonUI.manageAddon(id);
  return `${found.item.display} has no options page: its about:addons details`;
}

/**
 * `x`: enable or disable.
 * @param {string} id
 * @returns {Promise<string | null>}
 */
export async function toggleAddon(id) {
  const found = await listed(id);
  if (!found) return ADDON_GONE;
  const { addon, item } = found;
  if (item.enabled) {
    if (!can(addon, "PERM_CAN_DISABLE")) return `${item.display} cannot be disabled (policy)`;
    await addon.disable();
    return `${item.display} disabled`;
  }
  if (!can(addon, "PERM_CAN_ENABLE")) return `${item.display} cannot be enabled (policy)`;
  await addon.enable();
  return `${item.display} enabled`;
}

/**
 * `d`: removes the add-on once the user has answered y. The yes stands for the add-on as asked
 * about: gone, renamed or updated by then, nothing is removed (as closeWorkspace's guard).
 * @param {string} id
 * @param {(question: string, yes: () => void) => void} ask
 * @param {(text: string) => void} say  the notice, after the answer
 * @returns {Promise<string | null>} why not, before asking
 */
export async function removeAddon(id, ask, say) {
  const found = await listed(id);
  if (!found) return ADDON_GONE;
  if (!can(found.addon, "PERM_CAN_UNINSTALL")) return `${found.item.display} cannot be removed`;
  const asked = found.item;
  ask(removeAddonQuestion(asked), async () => {
    try {
      const now = await listed(id);
      if (addonChanged(asked, now?.item)) {
        say(`remove: "${asked.display}" changed since you were asked; nothing was removed`);
        return;
      }
      await /** @type {{ addon: any }} */ (now).addon.uninstall();
      say(`removed "${asked.display}"`);
    } catch (e) {
      say(`remove: ${/** @type {Error} */ (e)?.message ?? e}`);
    }
  });
  return null;
}

/**
 * `u`: asks the add-on's update server, as about:addons' "Check for Updates" does, and says
 * what came back. It never installs: an update that asks for new permissions must go through
 * Firefox's own prompt (background updates, about:addons).
 * @param {string} id
 * @returns {Promise<string>}
 */
export async function checkAddonUpdate(id) {
  const found = await listed(id);
  if (!found) return ADDON_GONE;
  const { addon, item } = found;
  if (!can(addon, "PERM_CAN_UPGRADE")) return `${item.display}: updates are not checked`;
  const { AddonManager } = lazy;
  return new Promise((resolve) => {
    let done = false;
    const finish = (/** @type {string} */ text) => {
      if (!done) resolve(text);
      done = true;
    };
    addon.findUpdates(
      {
        onUpdateAvailable: (/** @type {any} */ _a, /** @type {any} */ install) =>
          finish(`${item.display}: update ${install.version} available (install: about:addons)`),
        onNoUpdateAvailable: () => finish(`${item.display}: no update`),
        onUpdateFinished: (/** @type {any} */ _a, /** @type {number} */ error) =>
          finish(
            error === AddonManager.UPDATE_STATUS_NO_ERROR
              ? `${item.display}: no update`
              : `${item.display}: update check failed`,
          ),
      },
      AddonManager.UPDATE_WHEN_USER_REQUESTED,
    );
  });
}

/**
 * `shift+p`: allow or forbid private windows, as about:addons' radio does: the permission,
 * then a reload of an active add-on so it takes effect.
 * @param {string} id
 * @returns {Promise<string | null>}
 */
export async function togglePrivateAccess(id) {
  const found = await listed(id);
  if (!found) return ADDON_GONE;
  const { addon, item } = found;
  if (!can(addon, "PERM_CAN_CHANGE_PRIVATEBROWSING_ACCESS")) {
    return `${item.display}: private-window access cannot be changed`;
  }
  const extension = /** @type {any} */ (globalThis).WebExtensionPolicy.getByID(id)?.extension;
  const { ExtensionPermissions } = lazy;
  if (item.privateAllowed) {
    await ExtensionPermissions.remove(id, privateBrowsingPerms(), extension);
  } else {
    await ExtensionPermissions.add(id, privateBrowsingPerms(), extension);
  }
  if (addon.isActive) await addon.reload();
  return item.privateAllowed
    ? `${item.display}: not in private windows`
    : `${item.display}: runs in private windows`;
}

/**
 * Shows an add-on op's answer, if any, as the notice; a failure too.
 * @param {WindowState} s
 * @param {Promise<string | null>} op
 * @returns {Promise<void>}
 */
export function sayAddon(s, op) {
  return op.then(
    (text) => {
      if (text) s.notice.show(text);
    },
    (e) => {
      console.error("vimma: add-on", e);
      s.notice.show(`add-on: ${e?.message ?? e}`, { error: true });
    },
  );
}

/**
 * A key in the add-on picker (docs/specs/addon-manager.md): `o` and `d` close it first (a tab,
 * the y/N prompt); `x`, `shift+p` and `u` keep it open and refresh its rows.
 * @param {WindowState} s
 * @param {AddonOp} op
 * @param {string} id
 */
export function addonOp(s, op, id) {
  const refresh = () => s.addonPicker.refresh().catch((e) => console.error("vimma: add-ons", e));
  switch (op) {
    case "options":
      s.addonPicker.close();
      sayAddon(s, openAddonOptions(s.win, id));
      return;
    case "remove":
      s.addonPicker.close();
      sayAddon(
        s,
        removeAddon(
          id,
          (question, yes) => s.rename.ask(question, yes),
          (said) => s.notice.show(said),
        ),
      );
      return;
    case "toggle":
      sayAddon(s, toggleAddon(id)).then(refresh);
      return;
    case "private":
      sayAddon(s, togglePrivateAccess(id)).then(refresh);
      return;
    case "update":
      s.notice.show("checking for updates…");
      sayAddon(s, checkAddonUpdate(id)).then(refresh);
  }
}
