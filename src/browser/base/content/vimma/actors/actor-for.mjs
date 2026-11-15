/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Vimma actor's name and the lookup of a frame's actor, shared by the host's requests
// (VimmaActors.sys.mjs) and the agent's (AgentActors.sys.mjs).

/** The name the actor pair is registered under (VimmaActors.register). */
export const NAME = "Vimma";

/**
 * The actor of a frame's current document, or null when the document does not match
 * (moz-extension:, data:, blob:) or the frame is gone.
 * @param {CanonicalBrowsingContext | null | undefined} bc
 * @returns {JSWindowActorParent | null}
 */
export function actorFor(bc) {
  try {
    return bc?.currentWindowGlobal?.getActor(NAME) ?? null;
  } catch {
    return null;
  }
}
