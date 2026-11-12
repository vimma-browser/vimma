/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Whether Vimma is the default browser behind Omarchy's link router (#855). Pure: the host reads
 * the files and asks GIO (services/AppLauncher.sys.mjs).
 *
 * Omarchy lists its router, omarchy-browser.desktop, as the http and https handler in
 * hyprland-mimeapps.list, which GIO reads before mimeapps.list on Hyprland. The router runs
 * omarchy-launch-browser, which opens the first installed entry past the router in those lists
 * (omarchy-cmd-default-browser). Firefox's shell service compares only GIO's handler with its own
 * command, so it never counts Vimma as the default there, and Settings and the startup prompt
 * disagree with the browser the router actually opens.
 */

/** The desktop entry Omarchy names as the handler; it opens the browser listed after it. */
export const OMARCHY_ROUTER = "omarchy-browser.desktop";

/** The schemes Firefox's GNOME shell service needs for "is default" (appProtocols, essential). */
export const BROWSER_SCHEMES = ["http", "https"];

/** A desktop name from XDG_CURRENT_DESKTOP that is safe in a file name. */
const DESKTOP_NAME = /^[A-Za-z0-9_.-]+$/;

/** A desktop entry id that names a file directly in an applications dir, as Omarchy reads it. */
const ENTRY_ID = /^[A-Za-z0-9_+-][A-Za-z0-9_.+-]*\.desktop$/;

/**
 * @param {string[]} dirs
 * @returns {string[]} the absolute ones, without a trailing slash (the XDG spec ignores the rest)
 */
const absolute = (dirs) =>
  dirs.filter((dir) => dir.startsWith("/")).map((dir) => dir.replace(/(.)\/+$/, "$1"));

/**
 * The data dirs whose applications/ hold desktop entries, in XDG order.
 *
 * @param {{ home: string, dataHome: string, dataDirs: string }} env
 * @returns {string[]}
 */
export function dataDirs({ home, dataHome, dataDirs: dirs }) {
  return absolute([
    dataHome || (home ? `${home.replace(/\/+$/, "")}/.local/share` : ""),
    ...(dirs || "/usr/local/share:/usr/share").split(":"),
  ]);
}

/**
 * The mimeapps.list files in the order Omarchy's launcher reads them: each config dir's
 * desktop-specific lists, then its mimeapps.list. Relative dirs are ignored, as the XDG Base
 * Directory spec says.
 *
 * @param {{ home: string, configHome: string, configDirs: string, currentDesktop: string }} env
 * @returns {string[]}
 */
export function mimeappsLists({ home, configHome, configDirs, currentDesktop }) {
  const dirs = absolute([
    configHome || (home ? `${home.replace(/\/+$/, "")}/.config` : ""),
    ...(configDirs || "/etc/xdg").split(":"),
  ]);
  const desktops = currentDesktop
    .split(":")
    .filter((name) => DESKTOP_NAME.test(name) && name !== "." && name !== "..")
    .map((name) => name.toLowerCase());
  return dirs.flatMap((dir) => [
    ...desktops.map((name) => `${dir}/${name}-mimeapps.list`),
    `${dir}/mimeapps.list`,
  ]);
}

/**
 * The entries of the first `<mimeType>=` line in a list's [Default Applications] group.
 *
 * @param {string | null} text a mimeapps.list, or null when it does not exist
 * @param {string} mimeType
 * @returns {string[]}
 */
export function defaultHandlers(text, mimeType) {
  if (!text) {
    return [];
  }
  // Read as omarchy-cmd-default-browser's awk does: a group header at column 1, the key and `=`
  // at column 1 with no spaces, entries split on `;` and not trimmed. A line written any other
  // way is one Omarchy's launcher skips, so it must not count for Vimma either.
  let inGroup = false;
  const prefix = `${mimeType}=`;
  for (const line of text.split("\n")) {
    if (line.startsWith("[")) {
      inGroup = line.startsWith("[Default Applications]");
      continue;
    }
    if (inGroup && line.startsWith(prefix)) {
      return line.slice(prefix.length).split(";").filter(Boolean);
    }
  }
  return [];
}

/**
 * The first `Exec=` line of a desktop entry, at column 1 as Omarchy's launcher reads it (sed
 * `^Exec=`, first match in the file).
 *
 * @param {string | null} text
 * @returns {string | null}
 */
export function desktopEntryExec(text) {
  if (!text) {
    return null;
  }
  const line = text.split("\n").find((l) => l.startsWith("Exec="));
  return line === undefined ? null : line.slice("Exec=".length);
}

/**
 * The entry Omarchy's router opens: the first installed one past the router, list by list.
 *
 * @param {(string | null)[]} lists the texts of mimeappsLists(), null where missing
 * @param {string} mimeType
 * @param {(id: string) => boolean} installed
 * @returns {string | null}
 */
export function routedBrowser(lists, mimeType, installed) {
  for (const text of lists) {
    for (const id of defaultHandlers(text, mimeType)) {
      if (id !== OMARCHY_ROUTER && installed(id)) {
        return id;
      }
    }
  }
  return null;
}

/**
 * The program of a desktop entry's command line as Omarchy's launcher takes it: everything up to
 * the first space, quotes and tabs included, so a quoted program never resolves there or here.
 *
 * @param {string} command
 * @returns {string}
 */
export function commandProgram(command) {
  return command.split(" ", 1)[0] ?? "";
}

/**
 * True only when GIO's handler for both http and https is Omarchy's router, and the entry the
 * router opens for each runs exactly `appPath`, the absolute command Firefox's shell service
 * takes as this browser. Anything else keeps Firefox's own answer.
 *
 * As omarchy-cmd-default-browser does, an entry counts as installed when the first data dir that
 * has it gives an Exec program that resolves; the files are read rather than asked of GIO, whose
 * list of handlers for a scheme leaves out entries missing from a dir's mimeinfo.cache.
 *
 * @param {{
 *   defaultFor: (scheme: string) => string,
 *   lists: (string | null)[],
 *   entryFor: (id: string) => string | null,
 *   resolves: (program: string) => boolean,
 *   appPath: string,
 * }} options `defaultFor` gives GIO's handler id; `entryFor` the text of the first desktop
 *   entry file by that id in the data dirs; `resolves` whether a program is an executable file
 *   (an absolute path) or found in PATH
 * Two differences from Omarchy are deliberate and can only give "not default": https must route
 * to Vimma as well as http (Omarchy routes both by the http line), and when no list names an
 * installed browser this says no rather than falling back to xdg-settings or mimeinfo.cache.
 * `resolves` uses Vimma's own PATH, which a wrapper may have changed from the session's.
 *
 * @returns {boolean}
 */
export function isDefaultThroughRouter({ defaultFor, lists, entryFor, resolves, appPath }) {
  if (!appPath.startsWith("/")) {
    return false;
  }
  /** @type {Map<string, string>} */
  const programs = new Map();
  /** @param {string} id */
  const programOf = (id) => {
    if (!programs.has(id)) {
      const exec = ENTRY_ID.test(id) ? desktopEntryExec(entryFor(id)) : null;
      const program = exec === null ? "" : commandProgram(exec);
      programs.set(id, program && resolves(program) ? program : "");
    }
    return programs.get(id) ?? "";
  };
  return BROWSER_SCHEMES.every((scheme) => {
    if (defaultFor(scheme) !== OMARCHY_ROUTER) {
      return false;
    }
    const id = routedBrowser(lists, `x-scheme-handler/${scheme}`, (entry) => !!programOf(entry));
    return id !== null && programOf(id) === appPath;
  });
}
