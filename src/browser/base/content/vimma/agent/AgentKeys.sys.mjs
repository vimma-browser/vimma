/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The built-in agent's API keys (docs/specs/builtin-agent.md B8, security.md §12): one login per
// provider, of the origin chrome://vimma-agent, whose password is the key and the origin it was
// entered for, encrypted with OSKeyStore. The origin binds the key to its endpoint: a provider
// whose endpoint config.toml changes (an edited or pulled dotfile) gets no key until it is
// entered again. Login storage alone would put the key in a password export and in Sync, readable
// wherever the passwords are; with the OSKeyStore layer those copies are useless without the
// desktop keyring (or, without one, the profile's key4.db, as for saved cards). Never a pref,
// config.toml or a file of Vimma's. The key leaves this module only for the provider's request.

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  OSKeyStore: "resource://gre/modules/OSKeyStore.sys.mjs",
});

/** Matches no website, so login autofill never offers a key to a page. */
export const KEY_ORIGIN = "chrome://vimma-agent";
/** A login needs a realm or a form origin; the realm keeps it out of every form. */
const REALM = "Vimma agent API key";
/** OSKeyStore's caller name, for its own telemetry. */
const TRIGGER = "vimma_agent_key";

/** Login storage (nsILoginManager), which the Services typings leave out. */
const logins = () => /** @type {any} */ (Services).logins;

/** @param {string} provider */
const search = (provider) =>
  logins()
    .searchLoginsAsync({ origin: KEY_ORIGIN, httpRealm: REALM })
    .then((/** @type {any[]} */ all) => all.filter((l) => l.username === provider));

/** OSKeyStore encrypts UTF-8 bytes and decrypts to them, one character a byte. */
const fromBytes = (/** @type {string} */ s) =>
  new TextDecoder().decode(Uint8Array.from(s, (c) => c.charCodeAt(0)));

export const AgentKeys = {
  /**
   * Store `key` for `provider` at `endpoint`, replacing any key it had.
   * @param {string} provider  a name of `[[agent.providers]]`
   * @param {string} key @param {string} endpoint
   */
  async set(provider, key, endpoint) {
    if (!provider || !key) throw new Error("a provider and a key are needed");
    const origin = new URL(endpoint).origin;
    const cipher = await lazy.OSKeyStore.encrypt(JSON.stringify({ key, origin }));
    const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
    login.init(KEY_ORIGIN, null, REALM, provider, cipher, "", "");
    const old = await search(provider);
    if (old.length) {
      await logins().modifyLoginAsync(old[0], login);
      for (const extra of old.slice(1)) await logins().removeLoginAsync(extra);
    } else {
      await logins().addLoginAsync(login);
    }
  },

  /**
   * `provider`'s key for a request to `endpoint`, or null: none stored, or stored for another
   * origin. Only for the provider's request.
   * @param {string} provider @param {string} endpoint
   * @returns {Promise<string | null>}
   */
  async get(provider, endpoint) {
    const [login] = await search(provider);
    if (!login) return null;
    const stored = JSON.parse(fromBytes(await lazy.OSKeyStore.decrypt(login.password, TRIGGER)));
    if (stored?.origin !== new URL(endpoint).origin || typeof stored.key !== "string") return null;
    return stored.key;
  },

  /**
   * What setup shows of a stored key: its last four characters (Behaviour 3).
   * @param {string} provider @param {string} endpoint
   * @returns {Promise<string | null>}
   */
  async hint(provider, endpoint) {
    const key = await this.get(provider, endpoint);
    return key === null ? null : `key stored · ends …${[...key].slice(-4).join("")}`;
  },

  /**
   * @param {string} provider
   * @returns {Promise<boolean>} whether there was a key
   */
  async delete(provider) {
    const old = await search(provider);
    for (const login of old) await logins().removeLoginAsync(login);
    return old.length > 0;
  },

  /** Whether `provider` has a key stored, without decrypting it. @param {string} provider */
  async has(provider) {
    return (await search(provider)).length > 0;
  },
};
