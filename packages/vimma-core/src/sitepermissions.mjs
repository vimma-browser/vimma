/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The site permissions picker (`:site`, docs/specs/site-permissions.md): a row's text, what a key
 * asks Firefox to do, and the heading. The host reads Firefox's SitePermissions into
 * PermissionRecords and applies a plan through it; nothing here knows Firefox.
 */

/** nsIPermissionManager's action constants, which SitePermissions uses as states. */
export const PERMISSION_STATE = Object.freeze({ UNKNOWN: 0, ALLOW: 1, BLOCK: 2, PROMPT: 3 });

/**
 * What the host reads from SitePermissions for one permission of the current site.
 * @typedef {object} PermissionRecord
 * @property {string} id           SitePermissions id: "camera", "geo", "popup", ...
 * @property {string} label        Firefox's label for it
 * @property {number} state        the state in effect for the site
 * @property {string} stateLabel   Firefox's label for that state
 * @property {readonly number[]} states  the states Firefox offers for it, in its order
 * @property {boolean} set         the site has its own setting (not the default)
 * @property {"persistent" | "session" | "temporary" | "policy" | "global"} scope
 * @property {boolean} locked      a policy or a locked pref decides it
 */
/**
 * @typedef {object} PermissionItem
 * @property {"permission"} kind
 * @property {string} permissionId
 * @property {string} display  the label
 * @property {string} detail   the state, how long it lasts, whether it can change
 * @property {boolean} set
 * @property {boolean} active  never
 */
/** @typedef {"allow" | "block" | "reset" | "next"} PermissionOp */
/**
 * @typedef {{ type: "set", state: number } | { type: "remove" }
 *   | { type: "refuse", text: string }} PermissionPlan
 */

/** @type {Readonly<Record<PermissionRecord["scope"], string[]>>} */
const SCOPE_WORDS = Object.freeze({
  persistent: [],
  temporary: ["temporary"],
  session: ["this session"],
  policy: ["set by policy"],
  global: ["temporary"],
});

/** @param {PermissionRecord} r */
function detail(r) {
  const words = [r.stateLabel, ...(r.set ? SCOPE_WORDS[r.scope] : ["default"])];
  if (r.locked && r.scope !== "policy") words.push("locked");
  return words.join(" · ");
}

/**
 * The picker's rows, by Firefox's label, then id.
 * @param {readonly PermissionRecord[]} records
 * @returns {PermissionItem[]}
 */
export function permissionItems(records) {
  return [...records]
    .sort((a, b) => a.label.localeCompare(b.label) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) =>
      Object.freeze({
        kind: /** @type {const} */ ("permission"),
        permissionId: r.id,
        display: r.label,
        detail: detail(r),
        set: r.set,
        active: false,
      }),
    );
}

/**
 * What a key asks for one permission. A locked row refuses every key; allow and block only when
 * Firefox offers that state for the permission; next steps through Firefox's own state order.
 * @param {PermissionRecord} r
 * @param {PermissionOp} op
 * @returns {PermissionPlan}
 */
export function permissionPlan(r, op) {
  const refuse = (/** @type {string} */ text) => ({ type: /** @type {const} */ ("refuse"), text });
  if (r.locked)
    return refuse(`${r.label} ${r.scope === "policy" ? "is set by policy" : "is locked"}`);
  switch (op) {
    case "allow":
    case "block": {
      const state = op === "allow" ? PERMISSION_STATE.ALLOW : PERMISSION_STATE.BLOCK;
      if (!r.states.includes(state)) return refuse(`${r.label} cannot be set to ${op}`);
      return { type: "set", state };
    }
    case "reset":
      return r.set ? { type: "remove" } : refuse(`${r.label} is already the default`);
    case "next": {
      if (r.states.length === 0) return refuse(`${r.label} cannot be changed`);
      const i = r.states.indexOf(r.state);
      return { type: "set", state: /** @type {number} */ (r.states[(i + 1) % r.states.length]) };
    }
  }
}

/**
 * The picker's heading.
 * @param {{ site: string, isPrivate: boolean }} page
 */
export function permissionTitle({ site, isPrivate }) {
  const title = `Site permissions · ${site}`;
  return isPrivate ? `${title} · private: until the private workspace closes` : title;
}
