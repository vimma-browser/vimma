/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Temporary containers (docs/specs/temporary-containers.md): a tab, or the tabs its page opens,
 * in a container of its own inside a workspace, deleted with its site data when its last tab
 * closes. Pure rules only (decision 11): the map from container to workspace, the refusals,
 * which recorded containers may be deleted, the startup cleanup plan, and the markers' text and
 * numbers (decision 16). The host owns ContextualIdentityService, the tabs and the file
 * (workspaces/WorkspaceStore.sys.mjs).
 */

/**
 * A temporary container Vimma made: its id, the name Vimma gave it, and the workspace it was
 * opened in (decision 3). The file records only the id and the name (decision 5).
 * @typedef {{ userContextId: number, name: string, workspace: string }} TemporaryRecord
 * @typedef {{ userContextId: number, name: string }} RecordedTemporary
 */
/** @import { Identity } from "./workspacedefs.mjs" */

/**
 * @typedef {"agent-workspace" | "private-workspace" | "move-temporary"} TemporaryRefusal
 */

/** @type {Readonly<Record<TemporaryRefusal, string>>} */
export const TEMPORARY_REFUSALS = Object.freeze({
  "agent-workspace": "no temporary containers in the agent workspace",
  "private-workspace": "the private workspace is discarded when it closes already",
  "move-temporary": "a temporary tab stays in its workspace: open it again with :tmp there",
});

/**
 * The start of every name Vimma gives a temporary container. The token after it makes each
 * name its own, so that a recorded id whose container now has another name (reused after a
 * `containers.json` reset, or renamed in Settings) is told apart and kept (decision 5).
 */
const NAME_PREFIX = "vimma temporary ";
const NAME = /^vimma temporary [0-9a-f]+$/;

/** Firefox's colour and icon for the container (Settings → Containers shows them). */
export const TEMPORARY_LOOKS = Object.freeze({ color: "toolbar", icon: "fence" });

/**
 * The name of a new temporary container.
 * @param {string} token  lower-case hex, unique enough not to repeat (a uuid's digits)
 * @returns {string}
 */
export function temporaryName(token) {
  if (!/^[0-9a-f]+$/.test(token)) throw new Error("a temporary container's token is hex");
  return `${NAME_PREFIX}${token}`;
}

/**
 * Why a temporary container cannot be opened here (behaviour 8, decision 7), or null.
 * @param {{ privateWindow: boolean, agentWorkspace: boolean }} where
 * @returns {TemporaryRefusal | null}
 */
export function temporaryRefusal({ privateWindow, agentWorkspace }) {
  if (privateWindow) return "private-workspace";
  if (agentWorkspace) return "agent-workspace";
  return null;
}

/** `:tmp`'s words for a split (behaviour 2): the direction each splits in, as `:vsplit` / `:split`. */
const SPLIT_WORDS = Object.freeze(
  /** @type {Record<string, "vertical" | "horizontal">} */ ({
    vsplit: "vertical",
    vs: "vertical",
    split: "horizontal",
    sp: "horizontal",
  }),
);

/** The split words `:tmp ` completes, the long forms (behaviour 2). */
export const TEMPORARY_SPLIT_WORDS = Object.freeze(["vsplit", "split"]);

/**
 * The split `:tmp <text>` asks for (behaviour 2, decision 9): `vertical` for `vsplit` / `vs`,
 * `horizontal` for `split` / `sp`, or null when the text is a page to open in a new tab. Only the
 * whole word counts, so `:tmp split screen` still searches for those words.
 * @param {string} text
 * @returns {"vertical" | "horizontal" | null}
 */
export function temporarySplit(text) {
  const word = text.trim();
  return Object.hasOwn(SPLIT_WORDS, word)
    ? /** @type {"vertical" | "horizontal"} */ (SPLIT_WORDS[word])
    : null;
}

/**
 * The workspace a temporary container's tabs belong to (decision 3), or undefined when
 * `userContextId` is not a recorded temporary container.
 * @param {readonly TemporaryRecord[]} records
 * @param {number} userContextId
 * @returns {string | undefined}
 */
export function temporaryWorkspaceOf(records, userContextId) {
  return records.find((r) => r.userContextId === userContextId)?.workspace;
}

/**
 * `records` with `record` in it, replacing one of the same id.
 * @param {readonly TemporaryRecord[]} records
 * @param {TemporaryRecord} record
 * @returns {TemporaryRecord[]}
 */
export function withTemporary(records, record) {
  return [...records.filter((r) => r.userContextId !== record.userContextId), record];
}

/**
 * `records` without container `userContextId`; the same array when it was not there.
 * @param {readonly TemporaryRecord[]} records
 * @param {number} userContextId
 * @returns {readonly TemporaryRecord[]}
 */
export function withoutTemporary(records, userContextId) {
  if (!records.some((r) => r.userContextId === userContextId)) return records;
  return records.filter((r) => r.userContextId !== userContextId);
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** @param {unknown} id @returns {id is number} */
const positive = (id) => Number.isInteger(id) && /** @type {number} */ (id) > 0;

/**
 * The temporary containers vimma-workspaces.json records (decision 5). Lenient: the list only
 * names containers to delete, and each is checked against its live identity first
 * (canRemoveTemporary), so an entry that is not a positive id with one of Vimma's names is
 * dropped rather than failing the file.
 * @param {unknown} file  the parsed file
 * @returns {RecordedTemporary[]}
 */
export function readTemporaryRecords(file) {
  if (!isObject(file) || !Array.isArray(file.temporary)) return [];
  /** @type {RecordedTemporary[]} */
  const out = [];
  for (const entry of file.temporary) {
    if (!isObject(entry)) continue;
    const { userContextId, name } = entry;
    if (!positive(userContextId) || typeof name !== "string" || !NAME.test(name)) continue;
    out.push({ userContextId, name });
  }
  return out;
}

/**
 * Whether Vimma may delete recorded container `record` (docs/security W-invariants): its live
 * identity has the same id and still the name Vimma gave it, that name is one Vimma gives, and
 * no workspace owns the id. Never 0, the default container.
 * @param {RecordedTemporary} record
 * @param {Identity | undefined} identity  the live public identity of that id, if any
 * @param {readonly (number | null)[]} workspaceContainers  every workspace's container
 * @returns {boolean}
 */
export function canRemoveTemporary(record, identity, workspaceContainers) {
  return (
    positive(record.userContextId) &&
    NAME.test(record.name) &&
    identity?.userContextId === record.userContextId &&
    identity.name === record.name &&
    !workspaceContainers.includes(record.userContextId)
  );
}

/**
 * The startup cleanup (decisions 5 and 18): every recorded container a crash or a quit left is
 * deleted when canRemoveTemporary allows it; the others (renamed, reused, a workspace's) are
 * kept with their data. Either way the record is dropped. Ids gone already are in neither list.
 * @param {readonly RecordedTemporary[]} records
 * @param {readonly Identity[]} identities  ContextualIdentityService.getPublicIdentities()
 * @param {readonly (number | null)[]} workspaceContainers
 * @returns {{ remove: number[], kept: number[] }}
 */
export function planTemporaryCleanup(records, identities, workspaceContainers) {
  const byId = new Map(identities.map((i) => [i.userContextId, i]));
  /** @type {{ remove: number[], kept: number[] }} */
  const plan = { remove: [], kept: [] };
  for (const r of records) {
    const identity = byId.get(r.userContextId);
    if (!identity) continue;
    if (canRemoveTemporary(r, identity, workspaceContainers)) plan.remove.push(r.userContextId);
    else plan.kept.push(r.userContextId);
  }
  return plan;
}

/**
 * The status bar's glyph before a temporary tab's marker (decision 16): `◇` echoes the private
 * workspace's `◆` without claiming to be it.
 */
export const TEMPORARY_GLYPH = "◇";

/**
 * The markers' colour (decision 16): a theme token no workspace colour, the private workspace
 * nor the default accent uses. Many palettes give bright green the same value as green (a
 * workspace colour, the panel's mark gutter) and split 8's stripe uses it too, so the colour can
 * match those on screen: the text is what tells a temporary tab apart.
 */
export const TEMPORARY_COLOR_TOKEN = "--vimma-text-bright-green";

/**
 * A temporary tab's marker in the tab line and the side panel, `tmp1` (decision 16).
 * @param {number} n  its container's number in the window (numberTemporary)
 */
export function temporaryMarker(n) {
  return `tmp${n}`;
}

/**
 * The workspace picker's count of temporary tabs, `2 temporary` (behaviour 4).
 * @param {number} n
 */
export function temporaryCountText(n) {
  return `${n} temporary`;
}

/**
 * The numbers of a window's temporary containers (decision 16): a container keeps its number
 * while it is open, so a marker never changes under a tab; one opened since gets the lowest
 * number no open container has, in the order the containers were made (Firefox's ids only
 * count up). A closed container's number is free again. `numbers` itself when nothing changed.
 * @param {ReadonlyMap<number, number>} numbers  userContextId → number, as last returned
 * @param {readonly number[]} open  the temporary containers with a tab in the window
 * @returns {ReadonlyMap<number, number>}
 */
export function numberTemporary(numbers, open) {
  const live = new Set(open);
  const kept = [...numbers].filter(([id]) => live.has(id));
  const fresh = [...live].filter((id) => !numbers.has(id)).sort((a, b) => a - b);
  if (!fresh.length && kept.length === numbers.size) return numbers;
  const next = new Map(kept);
  const used = new Set(next.values());
  let n = 1;
  for (const id of fresh) {
    while (used.has(n)) n++;
    next.set(id, n);
    used.add(n);
  }
  return next;
}
