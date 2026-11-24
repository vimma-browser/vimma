/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `:siteunbind` and `:sitebind` (docs/specs/site-unbind-command.md): the arguments, the
 * `[sites."<host>"]` table a page's keys go to, the keys given until restart, and what the
 * command says. The keys are read as config.toml's `unbind` reads them (keymap `siteKey`), and
 * the host applies them through the keymap's own site rules, so the command and the file behave
 * the same.
 */

import { matchSiteRule } from "./editable.mjs";

/** @import { Keymap } from "./keymap.mjs" */

/** Between keys in every message: one key at a time, never run together (decision 3). */
export const KEY_SEPARATOR = " · ";

/** The option each command takes, and the one it does not. */
const OPTIONS = Object.freeze({
  siteunbind: { takes: "--save", not: "--delete" },
  sitebind: { takes: "--delete", not: "--save" },
});

/**
 * `:siteunbind [--save] [<key> …]` or `:sitebind [--delete] <key> …`. Each argument is one key
 * written as in config.toml, a sequence is several arguments (`g c`); the first argument that
 * is not one key refuses the whole line, naming it (decision 2). Keys come back canonical
 * (`<C-k>` is `ctrl+k`) and once each, in the order typed.
 * @param {"siteunbind" | "sitebind"} command
 * @param {string | undefined} text  the argument, as the command line passes it
 * @param {Pick<Keymap, "siteKey">} keymap  the keymap in force, for its prefix and leader
 * @returns {{ kind: "list" }
 *   | { kind: "keys", keys: string[], save: boolean, delete: boolean }
 *   | { kind: "refuse", text: string }}
 */
export function parseSiteKeysCommand(command, text, keymap) {
  const words = (text ?? "").trim().split(/\s+/).filter(Boolean);
  const { takes, not } = OPTIONS[command];
  const refuse = (/** @type {string} */ why) => ({
    kind: /** @type {const} */ ("refuse"),
    text: why,
  });
  let option = false;
  /** @type {string[]} */
  const keys = [];
  for (const word of words) {
    // `-` is the minus key; an option is `--` and a word.
    if (word.startsWith("--") && word.length > 2) {
      if (word === takes) {
        option = true;
        continue;
      }
      if (word === not) {
        return refuse(
          command === "siteunbind"
            ? ":siteunbind takes --save, not --delete (:sitebind --delete removes a saved key)"
            : ":sitebind takes --delete, not --save",
        );
      }
      return refuse(`:${command}: unknown option ${word} (it takes ${takes})`);
    }
    const read = keymap.siteKey(word);
    if (read.ok) {
      if (!keys.includes(read.key)) keys.push(read.key);
      continue;
    }
    if (read.why === "notation")
      return refuse(`:${command}: ${word} is not a key: ${read.message}`);
    if (read.why === "sequence") {
      // A hint only where the reading is plain: `gc`, `<C-k>j`; never for `comma`'s five keys.
      const hint = read.keys.length <= 3 ? ` (did you mean ${read.keys.join(" ")}?)` : "";
      return refuse(`:${command}: ${word} is not one key${hint}`);
    }
    return refuse(`:${command}: ${word} ${read.message}`);
  }
  if (keys.length === 0) {
    if (option) return refuse(`:${command} ${takes} needs keys: :${command} ${takes} t`);
    // `:sitebind` without an argument is the command line's missing-argument error.
    return { kind: "list" };
  }
  return {
    kind: "keys",
    keys,
    save: command === "siteunbind" && option,
    delete: command === "sitebind" && option,
  };
}

/**
 * The host of a page with a site: http and https only (decision 5), lower case, without a port,
 * IPv6 without brackets, as the keymap matches `<browser>.currentURI.host`. Null for about:,
 * file:, data:, an extension's page and anything that is not a URL.
 * @param {string} url
 * @returns {string | null}
 */
export function siteOfUrl(url) {
  /** @type {URL} */
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  return host || null;
}

/**
 * The `[sites."<host>"]` table a page's keys go to (decision 4): the most specific table that
 * matches the host, among config.toml's and those `:siteunbind` made, so a key joins the rule
 * that applies there; else the host without a leading `www.`, so that `www.reddit.com` and
 * `old.reddit.com` share one. A trailing dot is dropped.
 * @param {string} host  siteOfUrl's
 * @param {readonly string[]} tables  as written
 * @returns {string}
 */
export function siteTableFor(host, tables) {
  const hit = matchSiteRule(
    host,
    tables.map((match) => ({ match })),
  );
  if (hit) return hit.match;
  const h = host.toLowerCase().replace(/\.$/, "");
  return /^www\.[^.]+\.[^.]/.test(h) ? h.slice(4) : h;
}

/**
 * The keys `:siteunbind` gave the page until restart (decision 6), by table: in memory only,
 * for every window, never written anywhere.
 */
export function createTemporarySiteUnbinds() {
  /** @type {Map<string, string[]>} */
  const tables = new Map();
  return {
    /**
     * @param {string} table @param {readonly string[]} keys  canonical
     * @returns {string[]} the keys that were not there yet
     */
    add(table, keys) {
      const now = tables.get(table) ?? [];
      const added = keys.filter((k) => !now.includes(k));
      if (added.length) tables.set(table, [...now, ...added]);
      return added;
    },
    /**
     * @param {string} table @param {readonly string[]} keys
     * @returns {string[]} the keys that were there
     */
    remove(table, keys) {
      const now = tables.get(table) ?? [];
      const removed = keys.filter((k) => now.includes(k));
      const left = now.filter((k) => !keys.includes(k));
      if (left.length) tables.set(table, left);
      else tables.delete(table);
      return removed;
    },
    /** @param {string} table */
    keys: (table) => [...(tables.get(table) ?? [])],
    tables: () => [...tables.keys()],
    /** @returns {ReadonlyMap<string, readonly string[]>} for keymap `withSiteUnbinds` */
    entries: () => new Map(tables),
  };
}

/** @typedef {ReturnType<typeof createTemporarySiteUnbinds>} TemporarySiteUnbinds */

/** @param {readonly string[]} keys */
const joined = (keys) => keys.join(KEY_SEPARATOR);
/** @param {readonly string[]} keys @param {string} one @param {string} many */
const verb = (keys, one, many) => (keys.length === 1 ? one : many);

/**
 * What `:siteunbind` says: the keys it gave the page, and for how long (decision 3).
 * @param {string} table
 * @param {readonly string[]} added
 * @param {readonly string[]} already  keys the site gave the page before
 * @param {"temporary" | "saved"} how
 */
export function unbindMessage(table, added, already, how) {
  if (added.length === 0) {
    return `${table}: ${joined(already)} ${verb(already, "goes", "go")} to the page already`;
  }
  const until = how === "saved" ? "(saved to config.toml)" : "(until restart)";
  const said = `${table}: ${joined(added)} ${verb(added, "goes", "go")} to the page ${until}`;
  return already.length
    ? `${said}; ${joined(already)} ${verb(already, "was", "were")} already`
    : said;
}

/**
 * What `:sitebind` says (decision 7): the keys that are Vimma's again; those config.toml still
 * gives the page, which only `--delete` takes back; and those the site did not have.
 * @param {string} table
 * @param {{ bound: readonly string[], saved: readonly string[], idle: readonly string[] }} keys
 * @param {{ deleted?: boolean }} [options]  `--delete` removed `bound` from config.toml too
 */
export function bindMessage(table, { bound, saved, idle }, { deleted = false } = {}) {
  /** @type {string[]} */
  const parts = [];
  if (bound.length) {
    const from = deleted ? " (removed from config.toml)" : "";
    parts.push(`${table}: ${joined(bound)} ${verb(bound, "is", "are")} Vimma's again${from}`);
  }
  if (saved.length) {
    parts.push(
      `${joined(saved)} ${verb(saved, "is", "are")} saved for ${table}: :sitebind --delete ${saved.join(" ")}`,
    );
  }
  if (idle.length) {
    const lead = parts.length ? "" : `${table}: `;
    parts.push(`${lead}${joined(idle)} ${verb(idle, "was", "were")} not unbound here`);
  }
  return parts.join("; ");
}

/**
 * What `:siteunbind` alone says: the site's keys, those until restart and those in config.toml
 * marked apart (decision 8).
 * @param {string} table
 * @param {{ temporary: readonly string[], saved: readonly string[] }} keys
 */
export function listMessage(table, { temporary, saved }) {
  /** @type {string[]} */
  const parts = [];
  if (temporary.length) {
    parts.push(`${joined(temporary)} ${verb(temporary, "goes", "go")} to the page until restart`);
  }
  if (saved.length) parts.push(`${joined(saved)} saved in config.toml`);
  if (!parts.length)
    return `${table}: every key is Vimma's (:siteunbind <key> gives one to the page)`;
  return `${table}: ${parts.join("; ")}`;
}
