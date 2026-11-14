/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * vimma-ctl's version on an agent connection (docs/specs/ship-vimma-ctl.md): the check of the
 * `ctl` field `agent-hello` carries, and the one-line notice Vimma shows when the client is older
 * than the browser. An older client keeps working with the tools it knows (decision 6): Vimma
 * checks every command it receives, so an older client is a smaller tool set, never a weaker gate.
 * vimma-ctl's src/version.rs compares the same way.
 */

/** A Vimma version: SemVer with an optional pre-release, as surfer.json's displayVersion. */
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Longest `ctl` an `agent-hello` may carry: the label limit of `client.version`. */
export const MAX_CTL_VERSION = 64;

/**
 * Whether `value` is a version `agent-hello`'s `ctl` may carry.
 * @param {unknown} value
 * @returns {value is string}
 */
export function isCtlVersion(value) {
  return typeof value === "string" && value.length <= MAX_CTL_VERSION && VERSION.test(value);
}

/**
 * `a` against `b`: negative when older, 0 when the same, positive when newer; NaN when either is
 * not a version. A pre-release sorts before its release; two pre-releases of one release count
 * as the same, so a nightly client never warns about another nightly of that release.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const x = VERSION.exec(a);
  const y = VERSION.exec(b);
  if (!x || !y) return NaN;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return Math.sign(d);
  }
  return (x[4] === undefined ? 1 : 0) - (y[4] === undefined ? 1 : 0);
}

/**
 * Whether vimma-ctl `ctl` is at least as new as Vimma `vimma`, so it reads every reply field this
 * Vimma sends: a field newer than the client (a rate refusal's `retryAfter`, issue #592) goes only
 * to such a client, and an older one keeps working with what it knows (decision 6). False when
 * either version cannot be compared.
 * @param {string | undefined} ctl
 * @param {string} vimma
 * @returns {boolean}
 */
export function ctlIsCurrent(ctl, vimma) {
  return ctl !== undefined && compareVersions(ctl, vimma) >= 0;
}

/**
 * The notice for an agent connection whose vimma-ctl is `ctl` (undefined: it named none, so it
 * predates the check) on a Vimma of version `vimma`; null when there is nothing to say.
 * @param {string | undefined} ctl
 * @param {string} vimma
 * @returns {string | null}
 */
export function ctlVersionNotice(ctl, vimma) {
  if (!VERSION.test(vimma)) return null;
  if (ctl !== undefined && !(compareVersions(ctl, vimma) < 0)) return null;
  const client = ctl === undefined ? "vimma-ctl" : `vimma-ctl ${ctl}`;
  return `${client} is older than Vimma ${vimma}: agents get fewer tools until you update it`;
}
