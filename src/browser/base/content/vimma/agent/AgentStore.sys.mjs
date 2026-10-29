/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The built-in agent's stored conversations on disk (docs/specs/builtin-agent.md B15, Behaviour
// 19-23, security.md §12): one file per conversation in <profile>/vimma/agent/, named by its
// UUID, holding core agent-store.mjs's record (messages, replies, Vimma's task summaries; never
// tool output) encrypted with OSKeyStore, the key Firefox keeps in the desktop keyring through
// libsecret, or without one in key4.db, as for saved cards and the agent's API keys. Nothing is
// written in clear: a record that cannot be encrypted stays in memory only. Files are 0600 in a
// 0700 folder, written through a temporary file and a rename, so a crash leaves the old file or
// the new one. `keep_days` reads only the files' times, so it never needs the keyring.

import { readRecord } from "../core/agent-store.mjs";

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  OSKeyStore: "resource://gre/modules/OSKeyStore.sys.mjs",
});

/** OSKeyStore's caller name, for its own telemetry. */
const TRIGGER = "vimma_agent_conversation";
const SUFFIX = ".conv";
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A conversation's file, or the temporary file a save writes before its rename. */
const NAME =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.conv(\.[0-9a-f]{8}\.tmp)?$/;

/** @typedef {import("../core/agent-store.mjs").StoredRecord} StoredRecord */

const dir = () => PathUtils.join(PathUtils.profileDir, "vimma", "agent");

/** @param {string} id  a UUID, never a path */
function fileOf(id) {
  if (!UUID.test(id)) throw new Error("not a conversation id");
  return PathUtils.join(dir(), `${id}${SUFFIX}`);
}

/** OSKeyStore decrypts to bytes, one character a byte. @param {string} s */
const fromBytes = (s) => new TextDecoder().decode(Uint8Array.from(s, (c) => c.charCodeAt(0)));

/**
 * The store's files with their times: the conversations' and, as `temp`, a save's temporary
 * file that a crash left before its rename, which every removal takes too.
 * @returns {Promise<{ id: string, path: string, modified: number, temp: boolean }[]>}
 */
async function files() {
  let children;
  try {
    children = await IOUtils.getChildren(dir());
  } catch (e) {
    if (/** @type {any} */ (e)?.name === "NotFoundError") return [];
    throw e;
  }
  /** @type {{ id: string, path: string, modified: number, temp: boolean }[]} */
  const out = [];
  for (const path of children) {
    const m = NAME.exec(PathUtils.filename(path));
    if (!m) continue;
    try {
      const stat = await IOUtils.stat(path);
      if (stat.type !== "regular") continue;
      out.push({
        id: /** @type {string} */ (m[1]),
        path,
        modified: stat.lastModified ?? 0,
        temp: !!m[2],
      });
    } catch {
      // gone meanwhile
    }
  }
  return out;
}

/** One write at a time per file, so a later save never lands before an earlier one. */
/** @type {Map<string, Promise<unknown>>} */
const writing = new Map();

export const AgentStore = {
  /** Where the files are (security.md, tests). */
  get dir() {
    return dir();
  },

  /**
   * Writes `record`, encrypted. Throws, writing nothing, when it cannot be encrypted.
   * @param {StoredRecord} record
   */
  save(record) {
    const path = fileOf(record.id);
    const previous = writing.get(record.id) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const cipher = await lazy.OSKeyStore.encrypt(JSON.stringify(record));
        if (!(await IOUtils.exists(dir()))) {
          await IOUtils.makeDirectory(dir(), { createAncestors: true, permissions: DIR_MODE });
        }
        // Every time: a folder made otherwise (a copied profile, a restored backup) is narrowed.
        await IOUtils.setPermissions(dir(), DIR_MODE, false);
        const tmp = `${path}.${Services.uuid.generateUUID().toString().slice(1, 9)}.tmp`;
        try {
          await IOUtils.writeUTF8(tmp, cipher, { mode: "create" });
          await IOUtils.setPermissions(tmp, FILE_MODE, false);
          await IOUtils.move(tmp, path);
        } finally {
          await IOUtils.remove(tmp, { ignoreAbsent: true }).catch(() => {});
        }
      });
    writing.set(record.id, next);
    const settle = () => {
      if (writing.get(record.id) === next) writing.delete(record.id);
    };
    // Both ways, so this bookkeeping adds no rejection of its own: the caller handles `next`'s.
    next.then(settle, settle);
    return next;
  },

  /**
   * Every stored conversation that decrypts and reads as a record, oldest use first. A file
   * that does not (another keyring, another version) is left where it is, for `forgetAll`.
   * @returns {Promise<StoredRecord[]>}
   */
  async loadAll() {
    /** @type {StoredRecord[]} */
    const records = [];
    for (const f of await files()) {
      if (f.temp) continue;
      try {
        const cipher = await IOUtils.readUTF8(f.path);
        const record = readRecord(
          JSON.parse(fromBytes(await lazy.OSKeyStore.decrypt(cipher, TRIGGER))),
        );
        if (record && record.id === f.id) records.push(record);
        else console.warn(`vimma agent: ${PathUtils.filename(f.path)} is not a conversation`);
      } catch (e) {
        // The error's text could carry the file's contents: only its name is logged.
        console.warn(
          `vimma agent: ${PathUtils.filename(f.path)} could not be read`,
          /** @type {any} */ (e)?.name,
        );
      }
    }
    return records.sort((a, b) => a.used - b.used);
  },

  /** @param {string} id */
  async remove(id) {
    await (writing.get(id) ?? Promise.resolve()).catch(() => {});
    await IOUtils.remove(fileOf(id), { ignoreAbsent: true });
    for (const f of await files()) {
      if (f.id === id) await IOUtils.remove(f.path, { ignoreAbsent: true });
    }
  },

  /** `:agent forget all` (Behaviour 23): every file of the store, readable or not. */
  async removeAll() {
    await Promise.allSettled([...writing.values()]);
    for (const f of await files()) await IOUtils.remove(f.path, { ignoreAbsent: true });
  },

  /**
   * `keep_days` (Behaviour 20): the ids of the files not written for longer, removed. Reads only
   * the files' times: a conversation's file is written whenever it is used.
   * @param {(modified: number) => boolean} isExpired
   * @returns {Promise<string[]>}
   */
  async prune(isExpired) {
    /** @type {string[]} */
    const removed = [];
    for (const f of await files()) {
      // A temporary file outside a save under way was left by a crash: it goes whatever its age.
      if ((!f.temp && !isExpired(f.modified)) || writing.has(f.id)) continue;
      await IOUtils.remove(f.path, { ignoreAbsent: true });
      if (!f.temp) removed.push(f.id);
    }
    return removed;
  },
};
