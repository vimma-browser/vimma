/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Workspace definitions (spec m3-workspaces, sub-spec 1): the global list of workspaces in
 * `<profile>/vimma-workspaces.json`, each with its id, name, container and looks. Pure: the host
 * (WorkspaceStore) reads and writes the file and talks to ContextualIdentityService; this module
 * validates the file, reconciles it with `[workspaces]` and plans the container work.
 * Every operation returns a new object; a no-op returns its input.
 */

import { CONTAINER_COLORS, CONTAINER_ICONS, MAX_WORKSPACE_NAME } from "./config.mjs";
import { isWorkspaceId } from "./workspaces.mjs";

/** @import { Workspace } from "./config.mjs" */

export const DEFINITIONS_SCHEMA_VERSION = 1;
/** Decision 5: without `[workspaces]`, the one workspace a profile starts with. */
export const DEFAULT_WORKSPACE_NAME = "main";
const DEFAULT_LOOKS = Object.freeze({ color: "gray", icon: "circle" });
/**
 * The agent workspace's looks when Vimma makes it (docs/specs/vimma-mcp.md, decision 8): cyan,
 * not purple, which reads as the private workspace's magenta.
 */
export const AGENT_LOOKS = Object.freeze({ color: "cyan", icon: "fingerprint" });
/**
 * `agent`: the name of the agent workspace (`[mcp] workspace`), which the reconcile ensures and
 * keeps last, and which cannot be renamed or deleted (vimma-mcp decisions 8 and 9). Left out (or
 * null), no workspace is the agent's.
 * @typedef {{ agent?: string | null }} AgentOption
 */
const HOME = /^(?:https?:\/\/|about:)\S+$/;
/** A Places guid (toolkit/components/places/PlacesUtils.sys.mjs isValidGuid). */
const PLACES_GUID = /^[a-zA-Z0-9\-_]{12}$/;

/**
 * `userContextId` is the workspace's container, or null before one is made. `source` is
 * `"config"` for a `[workspaces]` entry, `"runtime"` for one made while running (or `main`).
 * `bookmarksFolder` is the Places guid of its folder in the Bookmarks Toolbar, once it has one
 * (docs/specs/bookmarks.md, decision 11); without it, the folder is found by name.
 * @typedef {{ id: string, name: string, userContextId: number | null, color: string,
 *   icon: string, home?: string, source: "config" | "runtime",
 *   bookmarksFolder?: string }} WorkspaceDefinition
 */
/**
 * Workspaces in workspace order: config ones in file order, then runtime ones.
 * @typedef {{ schema: number, lastActive: string | null,
 *   workspaces: WorkspaceDefinition[] }} Definitions
 */
/**
 * A container as `ContextualIdentityService.getPublicIdentities()` lists it. Firefox's defaults
 * have an `l10nId` and no `name`.
 * @typedef {{ userContextId: number, name?: string, color: string, icon: string }} Identity
 */

export class DefinitionsError extends Error {
  /**
   * @param {"syntax" | "invalid" | "unsupported-schema" | "unknown-workspace" | "duplicate-name"
   *   | "duplicate-id" | "bad-id" | "bad-name" | "bad-color" | "bad-icon" | "config-workspace"
   *   | "last-workspace" | "agent-workspace"} code
   * @param {string} path
   * @param {string} message
   */
  constructor(code, path, message) {
    super(path ? `${path}: ${message}` : message);
    this.name = "DefinitionsError";
    this.code = code;
    this.path = path;
  }
}

/** @returns {Definitions} */
export function emptyDefinitions() {
  return { schema: DEFINITIONS_SCHEMA_VERSION, lastActive: null, workspaces: [] };
}

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** @param {string} s */
const validName = (s) =>
  typeof s === "string" &&
  [...s].length >= 1 &&
  [...s].length <= MAX_WORKSPACE_NAME &&
  ![...s].some((ch) => /** @type {number} */ (ch.codePointAt(0)) < 0x20 || ch === "\x7f");

/**
 * Validates a definitions file (its text or parsed JSON) and returns it as a Definitions.
 * @param {unknown} input
 * @returns {Definitions}
 */
export function readDefinitions(input) {
  let doc = input;
  if (typeof input === "string") {
    try {
      doc = JSON.parse(input);
    } catch (e) {
      throw new DefinitionsError("syntax", "", `not JSON: ${/** @type {Error} */ (e).message}`);
    }
  }
  if (!isObject(doc)) throw new DefinitionsError("invalid", "", "must be a JSON object");
  if (!Number.isInteger(doc.schema)) {
    throw new DefinitionsError("invalid", "schema", "missing or not an integer");
  }
  if (doc.schema !== DEFINITIONS_SCHEMA_VERSION) {
    throw new DefinitionsError(
      "unsupported-schema",
      "schema",
      `schema ${doc.schema} is not supported`,
    );
  }
  if (!Array.isArray(doc.workspaces)) {
    throw new DefinitionsError("invalid", "workspaces", "must be an array");
  }
  const ids = new Set();
  const names = new Set();
  const workspaces = doc.workspaces.map((w, i) => {
    const at = (/** @type {string} */ k) => `workspaces[${i}]${k ? `.${k}` : ""}`;
    if (!isObject(w)) throw new DefinitionsError("invalid", at(""), "must be an object");
    if (!isWorkspaceId(w.id)) throw new DefinitionsError("bad-id", at("id"), "not a valid id");
    if (ids.has(w.id)) throw new DefinitionsError("duplicate-id", at("id"), `"${w.id}" twice`);
    if (!validName(w.name)) {
      throw new DefinitionsError("bad-name", at("name"), `1 to ${MAX_WORKSPACE_NAME} characters`);
    }
    if (names.has(w.name)) {
      throw new DefinitionsError("duplicate-name", at("name"), `"${w.name}" twice`);
    }
    const ucid = w.userContextId;
    if (ucid !== null && !(Number.isInteger(ucid) && ucid > 0)) {
      throw new DefinitionsError("invalid", at("userContextId"), "a positive integer or null");
    }
    checkLooks(w, at);
    if (w.home !== undefined && !(typeof w.home === "string" && HOME.test(w.home))) {
      throw new DefinitionsError("invalid", at("home"), "an http(s) or about: URL");
    }
    if (w.source !== "config" && w.source !== "runtime") {
      throw new DefinitionsError("invalid", at("source"), '"config" or "runtime"');
    }
    if (w.bookmarksFolder !== undefined && !PLACES_GUID.test(String(w.bookmarksFolder))) {
      throw new DefinitionsError("invalid", at("bookmarksFolder"), "a Places guid");
    }
    ids.add(w.id);
    names.add(w.name);
    /** @type {WorkspaceDefinition} */
    const def = {
      id: w.id,
      name: w.name,
      userContextId: ucid,
      color: w.color,
      icon: w.icon,
      source: w.source,
    };
    if (w.home !== undefined) def.home = w.home;
    if (w.bookmarksFolder !== undefined) def.bookmarksFolder = w.bookmarksFolder;
    return def;
  });
  const last = doc.lastActive;
  if (last !== null && !ids.has(last)) {
    throw new DefinitionsError("invalid", "lastActive", "null or the id of a workspace");
  }
  return { schema: doc.schema, lastActive: last, workspaces };
}

/**
 * @param {{ color?: unknown, icon?: unknown }} w
 * @param {(k: string) => string} at
 */
function checkLooks(w, at) {
  if (!CONTAINER_COLORS.includes(/** @type {string} */ (w.color))) {
    throw new DefinitionsError("bad-color", at("color"), `unknown colour "${w.color}"`);
  }
  if (!CONTAINER_ICONS.includes(/** @type {string} */ (w.icon))) {
    throw new DefinitionsError("bad-icon", at("icon"), `unknown icon "${w.icon}"`);
  }
}

/**
 * Whether the host may overwrite the definitions file it found: false only for a file written
 * by a newer vimma (schema above ours). Missing (null) or unreadable files may be overwritten.
 * @param {unknown} existing the file's text, its parsed JSON, or null
 * @returns {boolean}
 */
export function canWriteDefinitions(existing) {
  let doc = existing;
  if (typeof existing === "string") {
    try {
      doc = JSON.parse(existing);
    } catch {
      return true;
    }
  }
  const schema = isObject(doc) ? doc.schema : undefined;
  return !(Number.isInteger(schema) && schema > DEFINITIONS_SCHEMA_VERSION);
}

/** Why the agent workspace is never renamed (vimma-mcp decision 8). */
const AGENT_RENAME = "its name is [mcp] workspace in config.toml";

/**
 * @param {WorkspaceDefinition} w
 * @param {string | null | undefined} agent
 */
const isAgent = (w, agent) => !!agent && w.name === agent;

/** @param {WorkspaceDefinition} a @param {WorkspaceDefinition} b */
const sameDef = (a, b) =>
  a.id === b.id &&
  a.name === b.name &&
  a.userContextId === b.userContextId &&
  a.color === b.color &&
  a.icon === b.icon &&
  a.home === b.home &&
  a.source === b.source &&
  a.bookmarksFolder === b.bookmarksFolder;

/**
 * Reconciles the file with `[workspaces]` (decision 7, Reconcile step 1): config workspaces by
 * name, in file order, take colour, icon and home and keep their id and container; the others
 * stay as runtime workspaces (a config one removed from the file becomes runtime: nothing is
 * removed); an empty result gets `main`. With `agent` (vimma-mcp decision 8), the workspace of
 * that name is ensured: one of that name is adopted, else a runtime one is appended in
 * AGENT_LOOKS (`agentCreated` is its id); either way it goes last (decision 9). Idempotent.
 * @param {Definitions} defs
 * @param {readonly Pick<Workspace, "name" | "color" | "icon" | "home">[]} config
 * @param {() => string} mintId a new global workspace id (`ws-<uuid>`)
 * @param {AgentOption} [options]
 * @returns {{ definitions: Definitions, changed: boolean, agentCreated: string | null }}
 */
export function reconcileDefinitions(defs, config, mintId, { agent = null } = {}) {
  const byName = new Map(defs.workspaces.map((w) => [w.name, w]));
  const configNames = new Set(config.map((c) => c.name));
  /** @type {WorkspaceDefinition[]} */
  const workspaces = config.map((c) => {
    const old = byName.get(c.name);
    /** @type {WorkspaceDefinition} */
    const def = {
      id: old?.id ?? mintId(),
      name: c.name,
      userContextId: old?.userContextId ?? null,
      color: c.color,
      icon: c.icon,
      source: "config",
    };
    if (c.home !== undefined) def.home = c.home;
    if (old?.bookmarksFolder !== undefined) def.bookmarksFolder = old.bookmarksFolder;
    return def;
  });
  for (const w of defs.workspaces) {
    if (!configNames.has(w.name)) {
      workspaces.push(w.source === "runtime" ? w : { ...w, source: "runtime" });
    }
  }
  if (workspaces.length === 0) {
    workspaces.push({
      id: mintId(),
      name: DEFAULT_WORKSPACE_NAME,
      userContextId: null,
      ...DEFAULT_LOOKS,
      source: "runtime",
    });
  }
  /** @type {string | null} */
  let agentCreated = null;
  if (agent) {
    const at = workspaces.findIndex((w) => w.name === agent);
    if (at < 0) {
      agentCreated = mintId();
      workspaces.push({
        id: agentCreated,
        name: agent,
        userContextId: null,
        ...AGENT_LOOKS,
        source: "runtime",
      });
    } else if (at !== workspaces.length - 1) {
      workspaces.push(...workspaces.splice(at, 1));
    }
  }
  const lastActive = workspaces.some((w) => w.id === defs.lastActive)
    ? defs.lastActive
    : /** @type {WorkspaceDefinition} */ (workspaces[0]).id;
  const changed =
    lastActive !== defs.lastActive ||
    defs.schema !== DEFINITIONS_SCHEMA_VERSION ||
    workspaces.length !== defs.workspaces.length ||
    workspaces.some((w, i) => !sameDef(w, /** @type {WorkspaceDefinition} */ (defs.workspaces[i])));
  if (!changed) return { definitions: defs, changed, agentCreated };
  return {
    definitions: { schema: DEFINITIONS_SCHEMA_VERSION, lastActive, workspaces },
    changed,
    agentCreated,
  };
}

/**
 * The startup container check (Container lifecycle): a workspace adopts the container whose id
 * it stored when that container still carries the workspace's name; otherwise (none yet, gone,
 * or the id reused after a `containers.json` reset) it needs a new one. Containers are only ever
 * matched by stored id, so Firefox's defaults and other containers are never adopted.
 * @param {Definitions} defs
 * @param {readonly Identity[]} identities
 * @returns {{ adopt: string[], update: string[], create: string[] }} workspace ids
 */
export function planContainers(defs, identities) {
  const byId = new Map(identities.map((i) => [i.userContextId, i]));
  /** @type {{ adopt: string[], update: string[], create: string[] }} */
  const plan = { adopt: [], update: [], create: [] };
  for (const w of defs.workspaces) {
    const identity = w.userContextId === null ? undefined : byId.get(w.userContextId);
    if (!identity || identity.name !== w.name) {
      plan.create.push(w.id);
      continue;
    }
    plan.adopt.push(w.id);
    if (identity.color !== w.color || identity.icon !== w.icon) plan.update.push(w.id);
  }
  return plan;
}

/**
 * @param {Definitions} defs
 * @param {string} id
 */
function mustIndex(defs, id) {
  const i = defs.workspaces.findIndex((w) => w.id === id);
  if (i < 0) throw new DefinitionsError("unknown-workspace", "", `no workspace "${id}"`);
  return i;
}

/**
 * Records the container of workspace `id`.
 * @param {Definitions} defs
 * @param {string} id
 * @param {number} userContextId
 * @returns {Definitions}
 */
export function withContainer(defs, id, userContextId) {
  const i = mustIndex(defs, id);
  if (defs.workspaces[i]?.userContextId === userContextId) return defs;
  const workspaces = defs.workspaces.map((w, k) => (k === i ? { ...w, userContextId } : w));
  return { ...defs, workspaces };
}

/**
 * Links workspace `id` to its bookmarks folder (a Places guid), or unlinks it (null).
 * @param {Definitions} defs
 * @param {string} id
 * @param {string | null} guid
 * @returns {Definitions}
 */
export function withBookmarksFolder(defs, id, guid) {
  const i = mustIndex(defs, id);
  if (guid !== null && !PLACES_GUID.test(guid)) {
    throw new DefinitionsError("invalid", "bookmarksFolder", "a Places guid");
  }
  const w = /** @type {WorkspaceDefinition} */ (defs.workspaces[i]);
  if ((w.bookmarksFolder ?? null) === guid) return defs;
  const next = { ...w, bookmarksFolder: guid ?? undefined };
  if (guid === null) delete next.bookmarksFolder;
  const workspaces = defs.workspaces.map((x, k) => (k === i ? next : x));
  return { ...defs, workspaces };
}

/**
 * @param {Definitions} defs
 * @param {string} id
 * @returns {Definitions}
 */
export function setLastActive(defs, id) {
  mustIndex(defs, id);
  return defs.lastActive === id ? defs : { ...defs, lastActive: id };
}

/**
 * The workspace a tab you did not open inside the agent workspace takes: a link from another
 * app, a new window's first tab, the first tab at startup (docs/specs/vimma-mcp.md, decision
 * 42). The first of `wanted` that exists, has a container and is not the agent workspace, else
 * the first such workspace in order, else null. The agent workspace is never returned: its
 * pages are read by agents, so a login link landing there would hand them the session.
 * @param {Definitions} defs
 * @param {readonly (string | null | undefined)[]} wanted  workspace ids, most wanted first
 * @param {{ agent?: string | null, exclude?: readonly string[] }} [options]  `exclude`: ids
 *   that are the agent workspace too, under a name not yet read from config.toml
 * @returns {WorkspaceDefinition | null}
 */
export function userWorkspace(defs, wanted, { agent = null, exclude = [] } = {}) {
  const usable = (/** @type {WorkspaceDefinition} */ w) =>
    w.userContextId !== null && !isAgent(w, agent) && !exclude.includes(w.id);
  for (const id of wanted) {
    const w = id ? defs.workspaces.find((x) => x.id === id) : undefined;
    if (w && usable(w)) return w;
  }
  return defs.workspaces.find(usable) ?? null;
}

/**
 * Adds a runtime workspace (no container yet) at the end, or just before the agent workspace
 * when that is last (it sorts last, vimma-mcp decision 9).
 * @param {Definitions} defs
 * @param {{ id: string, name: string, color: string, icon: string, home?: string }} w
 * @param {AgentOption} [options]
 * @returns {Definitions}
 */
export function addRuntimeWorkspace(defs, w, { agent = null } = {}) {
  if (!isWorkspaceId(w.id)) throw new DefinitionsError("bad-id", "id", "not a valid id");
  if (defs.workspaces.some((x) => x.id === w.id)) {
    throw new DefinitionsError("duplicate-id", "id", `"${w.id}" exists`);
  }
  checkNewName(w.name);
  if (defs.workspaces.some((x) => x.name === w.name)) {
    throw new DefinitionsError("duplicate-name", "name", `"${w.name}" exists`);
  }
  checkLooks(w, (k) => k);
  /** @type {WorkspaceDefinition} */
  const def = {
    id: w.id,
    name: w.name,
    userContextId: null,
    color: w.color,
    icon: w.icon,
    source: "runtime",
  };
  if (w.home !== undefined) def.home = w.home;
  const workspaces = [...defs.workspaces];
  const lastIsAgent = !!agent && workspaces[workspaces.length - 1]?.name === agent;
  workspaces.splice(lastIsAgent ? workspaces.length - 1 : workspaces.length, 0, def);
  return { ...defs, workspaces };
}

/**
 * Removes a runtime workspace (decision 7: a config workspace stays while it is in
 * `config.toml`; the last workspace stays; the agent workspace stays, vimma-mcp decision 8).
 * The host removes `removed.userContextId`.
 * @param {Definitions} defs
 * @param {string} id
 * @param {AgentOption} [options]
 * @returns {{ definitions: Definitions, removed: WorkspaceDefinition }}
 */
export function removeWorkspaceDefinition(defs, id, { agent = null } = {}) {
  const i = mustIndex(defs, id);
  const removed = /** @type {WorkspaceDefinition} */ (defs.workspaces[i]);
  if (isAgent(removed, agent)) {
    throw new DefinitionsError(
      "agent-workspace",
      "",
      `"${removed.name}" is the agent workspace; it is only emptied`,
    );
  }
  if (removed.source === "config") {
    throw new DefinitionsError("config-workspace", "", `"${removed.name}" is in config.toml`);
  }
  // The agent workspace never is all that is left (vimma-mcp decision 8): it is not counted.
  if (defs.workspaces.filter((w) => !isAgent(w, agent)).length === 1) {
    throw new DefinitionsError("last-workspace", "", "cannot delete the last workspace");
  }
  const workspaces = defs.workspaces.filter((_, k) => k !== i);
  const lastActive =
    defs.lastActive === id
      ? /** @type {WorkspaceDefinition} */ (workspaces[0]).id
      : defs.lastActive;
  return { definitions: { ...defs, lastActive, workspaces }, removed };
}

/**
 * A name a user gives a workspace (new or rename). Besides the file's rules (validName), not
 * digits only: `:wsmove 2` / `:workspace 2` read those as a place, so a workspace named "2"
 * could never be named and would take another's tab. A file's existing names are not checked.
 * @param {string} name
 */
function checkNewName(name) {
  if (!validName(name)) {
    throw new DefinitionsError("bad-name", "name", `1 to ${MAX_WORKSPACE_NAME} characters`);
  }
  if (/^\d+$/.test(name)) {
    throw new DefinitionsError(
      "bad-name",
      "name",
      `"${name}" is only digits, which name a workspace by its place`,
    );
  }
}

/**
 * Renames a runtime workspace (`prefix+shift+w`, `:wsrename`; sub-spec 4a). A config workspace
 * is named by its `[workspaces]` key, and a reconcile matches by that name, so it is renamed in
 * `config.toml`, and so is the agent workspace (`[mcp] workspace`, vimma-mcp decision 8), so
 * agent access never follows or loses a workspace. The same name returns `defs` itself. The host
 * renames the container too.
 * @param {Definitions} defs
 * @param {string} id
 * @param {string} name
 * @param {AgentOption} [options]
 * @returns {Definitions}
 */
export function renameWorkspaceDefinition(defs, id, name, { agent = null } = {}) {
  const i = mustIndex(defs, id);
  const w = /** @type {WorkspaceDefinition} */ (defs.workspaces[i]);
  if (w.name === name) return defs;
  if (isAgent(w, agent)) throw new DefinitionsError("agent-workspace", "", AGENT_RENAME);
  if (w.source === "config") {
    throw new DefinitionsError("config-workspace", "", `"${w.name}" is named in config.toml`);
  }
  checkNewName(name);
  if (defs.workspaces.some((x) => x.name === name)) {
    throw new DefinitionsError("duplicate-name", "name", `"${name}" exists`);
  }
  const workspaces = defs.workspaces.map((x, k) => (k === i ? { ...x, name } : x));
  return { ...defs, workspaces };
}

/**
 * The y/N question before closing a workspace (decision 7): a runtime workspace goes with its
 * container and so its site data; a config one only loses its tabs, and so does the agent
 * workspace, which keeps its container (vimma-mcp decision 8).
 * @param {WorkspaceDefinition} w
 * @param {number} tabs  its open tabs, in every window
 * @param {AgentOption} [options]
 */
export function closeWorkspaceQuestion(w, tabs, { agent = null } = {}) {
  const count = `${tabs} tab${tabs === 1 ? "" : "s"}`;
  if (isAgent(w, agent)) {
    return (
      `Close the ${count} of "${w.name}"? It stays, with its cookies and logins ` +
      "(:mcp forget clears them). y/N"
    );
  }
  return w.source === "config"
    ? `Close the ${count} of "${w.name}"? It stays, as it is in config.toml. y/N`
    : `Close "${w.name}" (${count}) and delete its cookies and site data? y/N`;
}

/**
 * After yes to closing a runtime workspace whose bookmarks folder has items: what becomes of
 * them (docs/specs/bookmarks.md, decision 12). Keeping the folder is the default (any other key,
 * Enter, Esc); `m` moves them to `moveTo` (none: no other workspace), `d` deletes them.
 * @param {string} name  the workspace
 * @param {number} count  items in its folder, folders included
 * @param {string | null} moveTo  the workspace `m` moves them to
 */
export function deleteBookmarksQuestion(name, count, moveTo) {
  const what = `The ${count} bookmark${count === 1 ? "" : "s"} of "${name}"`;
  const them = count === 1 ? "it" : "them";
  return moveTo === null
    ? `${what}: k keep the folder (default), d delete ${them}? K/d`
    : `${what}: k keep the folder (default), m move ${them} to "${moveTo}", d delete ${them}? K/m/d`;
}

/**
 * The y/N question before the workspace picker's `m` moves the current tab (decision 6: the tab
 * is reopened by URL in the target's container). Into the agent workspace it says that agents
 * can read it there, with the agent's cookies (vimma-mcp decision 11).
 * @param {string} name  the target workspace
 * @param {AgentOption} [options]
 */
export function moveTabQuestion(name, { agent = null } = {}) {
  if (agent && name === agent) {
    return (
      `Move this tab to "${name}"? Agents you allow can read it there. It is reopened with the ` +
      "agent's cookies; its history and form data are lost. y/N"
    );
  }
  return (
    `Move this tab to "${name}"? It is reopened there; its back/forward history and form data ` +
    "are lost. y/N"
  );
}

/**
 * The status bar's persistent alert for workspaces whose container was gone (or reused by
 * someone else) at startup and was replaced by a new, empty one: their sign-ins are gone, which
 * a notice that times out could hide (sub-spec 4a). Null when none was lost.
 * @param {readonly string[]} names
 * @returns {string | null}
 */
export function lostContainersAlert(names) {
  if (!names.length) return null;
  const list = names.map((n) => `"${n}"`).join(", ");
  return names.length === 1
    ? `${list} lost its container since the last run; it has a new, empty one, so its sites ` +
        "need a new sign-in"
    : `${list} lost their containers since the last run; they have new, empty ones, so their ` +
        "sites need a new sign-in";
}

/**
 * The notice after a tab pinned outside Vimma (an extension, an imported session) is unpinned:
 * `hideTab` refuses pinned tabs, so it would show in every workspace (decision 11).
 * @param {string} label  the tab's label, or "" when it has none
 */
export function unpinnedNotice(label) {
  const what = label ? `"${label}"` : "a tab";
  return `unpinned ${what}: a pinned tab would show in every workspace`;
}

/** The order new workspaces take colours in: distinct ones first, gray never. */
const NEW_COLORS = ["blue", "green", "orange", "purple", "red", "yellow", "pink", "cyan", "violet"];

/**
 * A runtime workspace's colour and icon: the first colour no workspace uses (all used: by
 * count), so neighbours in workspace order look different; the icon is a circle.
 * @param {Definitions} defs
 * @returns {{ color: string, icon: string }}
 */
export function newWorkspaceLooks(defs) {
  const used = new Set(defs.workspaces.map((w) => w.color));
  const color =
    NEW_COLORS.find((c) => !used.has(c)) ??
    /** @type {string} */ (NEW_COLORS[defs.workspaces.length % NEW_COLORS.length]);
  return { color, icon: "circle" };
}
