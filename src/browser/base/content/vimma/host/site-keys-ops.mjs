/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// `:siteunbind` and `:sitebind` (docs/specs/site-unbind-command.md; security.md K13): keys the
// selected tab's site gets instead of Vimma, until restart or, with `--save`, in config.toml.
// Core reads the arguments and picks the `[sites]` table; the keys until restart live here, one
// list for every window, and reach the keymap through VimmaHost, which compiles them into the
// keymap in force as if config.toml listed them. The write to config.toml is ConfigHost's,
// through HostServices (ADR-026).

import {
  bindMessage,
  createTemporarySiteUnbinds,
  listMessage,
  parseSiteKeysCommand,
  siteOfUrl,
  siteTableFor,
  unbindMessage,
} from "../core/site-keys.mjs";
import { HostServices } from "./host-services.mjs";
import { PdfOps } from "./pdf-ops.mjs";

/** @import { Keymap } from "../core/keymap.mjs" */

/** The keys `:siteunbind` gave until restart, by table: in memory only (decision 6). */
export const TemporarySiteUnbinds = createTemporarySiteUnbinds();

/**
 * What the commands need of the host.
 * @typedef {object} SiteKeysHost
 * @property {() => Keymap} baseKeymap  config.toml's keymap, without the keys until restart
 * @property {() => void} siteUnbindsChanged  compile TemporarySiteUnbinds into every window's keymap
 */

/**
 * The selected tab's `[sites]` table, or why there is none (decision 5): about:, file:, data:
 * and other pages without a host have no site, and the PDF viewer keeps Vimma's keys.
 * @param {BrowserWindow} win @param {string} command @param {Keymap} base
 * @returns {{ table: string } | { refused: string }}
 */
function selectedSite(win, command, base) {
  const browser = win.gBrowser?.selectedBrowser;
  if (!browser) return { refused: `:${command}: no page is selected` };
  if (PdfOps.context(browser) === "pdf") {
    return {
      refused: `:${command}: the PDF viewer keeps Vimma's keys; run it on one of the site's pages`,
    };
  }
  const host = siteOfUrl(browser.currentURI?.spec ?? "");
  if (!host)
    return { refused: `:${command}: this page has no site; it works on http and https pages` };
  return { table: siteTableFor(host, [...base.siteTables(), ...TemporarySiteUnbinds.tables()]) };
}

/**
 * `:siteunbind [--save] [<key> …]` and `:sitebind [--delete] <key> …`.
 * @param {SiteKeysHost} host
 * @param {{ win: BrowserWindow, private: boolean }} state
 * @param {"siteunbind" | "sitebind"} command
 * @param {string | undefined} text
 * @param {(text: string, error?: boolean) => void} say  the notice, now or once written
 */
export function runSiteKeys(host, state, command, text, say) {
  const base = host.baseKeymap();
  const parsed = parseSiteKeysCommand(command, text, base);
  if (parsed.kind === "refuse") return say(parsed.text, true);
  const site = selectedSite(state.win, command, base);
  if ("refused" in site) return say(site.refused, true);
  const { table } = site;
  const temp = TemporarySiteUnbinds;
  if (parsed.kind === "list") {
    return say(listMessage(table, { temporary: temp.keys(table), saved: base.siteKeys(table) }));
  }
  const { keys } = parsed;
  if (command === "siteunbind" && !parsed.save) {
    const saved = base.siteKeys(table);
    const added = temp.add(
      table,
      keys.filter((k) => !saved.includes(k)),
    );
    if (added.length) host.siteUnbindsChanged();
    return say(
      unbindMessage(
        table,
        added,
        keys.filter((k) => !added.includes(k)),
        "temporary",
      ),
    );
  }
  if (command === "siteunbind") {
    // Decision 11: a private window's sites are not written to disk.
    if (state.private) {
      return say(
        ":siteunbind --save: not from a private window, whose sites stay off disk; " +
          ":siteunbind without --save gives the keys until restart",
        true,
      );
    }
    HostServices.editSiteUnbind(table, { add: keys }).then(
      (r) => {
        if ("error" in r) return say(`:siteunbind --save: ${r.error}`, true);
        // The file has them now: the keys until restart would only repeat them.
        if (temp.remove(table, keys).length) host.siteUnbindsChanged();
        return say(unbindMessage(table, r.added, r.already, "saved"));
      },
      (/** @type {unknown} */ e) =>
        say(`:siteunbind --save: ${/** @type {Error} */ (e).message}`, true),
    );
    return undefined;
  }
  if (!parsed.delete) {
    // Decision 7: config.toml changes only with --save or --delete.
    const bound = temp.remove(table, keys);
    if (bound.length) host.siteUnbindsChanged();
    const savedNow = base.siteKeys(table);
    const saved = keys.filter((k) => savedNow.includes(k));
    const idle = keys.filter((k) => !bound.includes(k) && !saved.includes(k));
    return say(bindMessage(table, { bound, saved, idle }), bound.length === 0);
  }
  HostServices.editSiteUnbind(table, { remove: keys }).then(
    (r) => {
      if ("error" in r) return say(`:sitebind --delete: ${r.error}`, true);
      const fromTemp = temp.remove(table, keys);
      if (fromTemp.length) host.siteUnbindsChanged();
      const bound = keys.filter((k) => r.removed.includes(k) || fromTemp.includes(k));
      const idle = keys.filter((k) => !bound.includes(k));
      return say(
        bindMessage(table, { bound, saved: [], idle }, { deleted: r.removed.length > 0 }),
        bound.length === 0,
      );
    },
    (/** @type {unknown} */ e) =>
      say(`:sitebind --delete: ${/** @type {Error} */ (e).message}`, true),
  );
  return undefined;
}

/**
 * `:sitebind`'s Tab completion (decision 9): `--delete`, then the selected site's keys, those
 * until restart first; nothing on a page without a site.
 * @param {BrowserWindow} win @param {Keymap} base
 * @returns {string[]}
 */
export function siteBindCompletions(win, base) {
  const site = selectedSite(win, "sitebind", base);
  if ("refused" in site) return ["--delete"];
  const keys = [...TemporarySiteUnbinds.keys(site.table), ...base.siteKeys(site.table)];
  return ["--delete", ...keys.filter((k, i) => keys.indexOf(k) === i)];
}
