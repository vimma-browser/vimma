/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// `:route` (spec docs/specs/workspace-routing.md, decision 7): without text, the rules and the
// one matching this tab, in about:vimma; `:route add [workspace]` writes a `domain` rule for
// the tab's site into config.toml; `:route move` moves the tab to the workspace its rule names.

import { describeRoute, matchRoute, routeDomainFor } from "../core/routes.mjs";
import { findWorkspace, workspaceRefFor } from "../core/workspaces.mjs";
import { WindowWorkspaces } from "../workspaces/WindowWorkspaces.sys.mjs";
import { WorkspaceRouter } from "../workspaces/WorkspaceRouter.sys.mjs";
import { WorkspaceStore } from "../workspaces/WorkspaceStore.sys.mjs";
import { openUrl } from "./tab-ops.mjs";

export const ROUTE_USAGE = ":route, :route add [workspace], :route move";

/**
 * `:route [add [workspace] | move]`.
 * @param {Window} win
 * @param {string} text  the command's argument, "" without one
 * @param {(text: string) => void} say  the notice, for what is known only later
 * @returns {string | null} the notice to show now, or null
 */
export function runRoute(win, text, say) {
  const [verb = "", ...rest] = text.trim().split(/\s+/);
  const ww = WindowWorkspaces.get(win);
  const gBrowser = /** @type {any} */ (win).gBrowser;
  const tab = gBrowser.selectedTab;
  if (verb === "") {
    const id = ww?.model ? ww.idOf(tab) : "";
    openUrl(win, `about:vimma?tab=${encodeURIComponent(id)}#routes`, "tab");
    return null;
  }
  if (!ww?.model) return "no workspaces in this window";
  if (verb === "add") return addRoute(win, tab, rest.join(" "), say);
  if (verb === "move") return moveByRoute(win, tab);
  return `:route ${verb}: unknown; ${ROUTE_USAGE}`;
}

/**
 * @param {Window} win
 * @param {any} tab
 * @param {string} name  the workspace, "" for the current one
 * @param {(text: string) => void} say
 */
function addRoute(win, tab, name, say) {
  const ww = /** @type {any} */ (WindowWorkspaces.get(win));
  const domain = routeDomainFor(tab.linkedBrowser.currentURI?.spec ?? "");
  if (!domain) return ":route add: only for http and https pages";
  const model = ww.model;
  const target = name ? findWorkspace(model, workspaceRefFor(model, name)) : null;
  const workspace = name
    ? target?.name
    : model.workspaces.find((/** @type {{ id: string }} */ w) => w.id === model.active)?.name;
  if (!workspace) return `:route add: no workspace "${name}"`;
  const url = `https://${domain.includes(":") ? `[${domain}]` : domain}/`;
  const earlier = matchRoute(WorkspaceRouter.routes, { url });
  if (earlier) {
    return earlier.workspace === workspace
      ? `:route add: ${domain} already goes to "${workspace}" (route ${earlier.index})`
      : `:route add: route ${earlier.index} already sends ${domain} to "${earlier.workspace}" ` +
          `(${describeRoute(earlier)}); edit it in config.toml (:config)`;
  }
  // ConfigHost imports VimmaHost, which imports this: imported on use, as the host does with
  // CONFIG_RELOAD_TOPIC, so module evaluation never runs in a cycle.
  const { ConfigHost } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
  );
  ConfigHost.addRoute({ domain, workspace }).then(
    (/** @type {string | null} */ refused) =>
      say(refused ? `:route add: ${refused}` : `added: ${domain} → "${workspace}" (config.toml)`),
    (/** @type {unknown} */ e) => say(`:route add: ${/** @type {Error} */ (e).message}`),
  );
  return null;
}

/**
 * @param {Window} win
 * @param {any} tab
 */
function moveByRoute(win, tab) {
  const ww = /** @type {any} */ (WindowWorkspaces.get(win));
  const hit = WorkspaceRouter.match(tab.linkedBrowser.currentURI?.spec ?? "");
  if (!hit) return ":route move: no rule matches this page";
  if (hit.workspace.userContextId === tab.userContextId) {
    return `:route move: already in "${hit.workspace.name}"`;
  }
  const def = WorkspaceStore.definitions.workspaces.find((d) => d.id === hit.workspace.id);
  if (!def) return `:route move: no workspace "${hit.workspace.name}"`;
  return (
    ww.moveTab(tab, { id: def.id }) ??
    `moved to "${def.name}" (route ${hit.route.index}): reopened there, without its history`
  );
}
