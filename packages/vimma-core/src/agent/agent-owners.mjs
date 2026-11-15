/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Which conversation owns which agent-workspace tab (docs/specs/builtin-agent.md B17,
// Behaviour 30), so one conversation's model cannot read or act in another's pages. A tab
// belongs to the conversation that opened it, was given it, or owns its opener; a tab moved
// there by the user belongs to none until given. MCP connections (conversation null) see only
// the tabs no conversation owns. Kept in memory: after a restart no tab is owned.

/** @typedef {string | number} TabId */
/** @typedef {string | number} ConvId  a conversation's gate connection (`builtin:<n>`) */

export class TabOwners {
  constructor() {
    /** @type {Map<number, ConvId>} */
    this.owners = new Map();
  }

  /** @param {TabId} tab @param {ConvId} conv */
  opened(tab, conv) {
    this.owners.set(Number(tab), conv);
  }

  /** A tab a page opened (a `target=_blank` link, `window.open`). @param {TabId} tab @param {TabId} opener */
  openedBy(tab, opener) {
    const conv = this.owners.get(Number(opener));
    if (conv === undefined) this.owners.delete(Number(tab));
    else this.owners.set(Number(tab), conv);
  }

  /** @param {TabId} tab @param {ConvId} conv */
  given(tab, conv) {
    this.owners.set(Number(tab), conv);
  }

  /** Moved to the agent workspace without being given (the picker's `m`). @param {TabId} tab */
  moved(tab) {
    this.owners.delete(Number(tab));
  }

  /** @param {TabId} tab */
  closed(tab) {
    this.owners.delete(Number(tab));
  }

  /** @param {TabId} tab @returns {ConvId | null} */
  owner(tab) {
    return this.owners.get(Number(tab)) ?? null;
  }

  /** @param {ConvId} conv @returns {number[]} */
  tabsOf(conv) {
    return [...this.owners].filter(([, c]) => c === conv).map(([t]) => t);
  }

  /**
   * Whether `conv` (null for an MCP connection) may see and act on `tab`.
   * @param {TabId} tab @param {ConvId | null} conv
   */
  visible(tab, conv) {
    return this.owner(tab) === conv;
  }
}
