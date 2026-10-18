/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The workspace definitions of the app (spec m3-workspaces, sub-spec 1): one per app, shared by
 * every window. Loads and saves `<profile>/vimma-workspaces.json` (JSONFile: debounced, atomic,
 * with a backup and a shutdown flush), reconciles it with `[workspaces]` and with Firefox's
 * containers, and owns the container lifecycle: create, adopt, update, and remove only through
 * an explicit, confirmed delete (decision 7). The pure part is core's workspacedefs.mjs.
 */

import {
  addRuntimeWorkspace,
  canWriteDefinitions,
  emptyDefinitions,
  lostContainersAlert,
  newWorkspaceLooks,
  planContainers,
  readDefinitions,
  reconcileDefinitions,
  removeWorkspaceDefinition,
  renameWorkspaceDefinition,
  setLastActive,
  userWorkspace,
  withBookmarksFolder,
  withContainer,
} from "../core/workspacedefs.mjs";

/** @import { Definitions, WorkspaceDefinition } from "../core/workspacedefs.mjs" */
/** @import { Workspace } from "../core/config.mjs" */

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  ContextualIdentityService:
    "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs",
  JSONFile: "resource://gre/modules/JSONFile.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WorkspaceRouter: "chrome://browser/content/vimma/workspaces/WorkspaceRouter.sys.mjs",
});

export const DEFINITIONS_FILE = "vimma-workspaces.json";
/** Observer topic: the definitions changed (subject null, data a JSON list of workspace ids). */
export const CHANGED_TOPIC = "vimma-workspaces-changed";
const CONTAINERS_PREF = "privacy.userContext.enabled";
/** The status bar's persistent error while containers are off at startup. */
export const CONTAINERS_OFF_ALERT =
  "workspaces off: containers are disabled (set privacy.userContext.enabled to true, restart)";
const DELETED_TOPIC = "contextual-identity-deleted";
/**
 * The container of the last workspace used that is not the agent's, so a start routes its first
 * tab without reading the file (never the agent's: docs/specs/vimma-mcp.md, decision 42).
 */
const STARTUP_PREF = "vimma.workspaces.startupUserContextId";
/** The agent workspace's container at the last save, so a start can trust STARTUP_PREF. */
const STARTUP_AGENT_PREF = "vimma.workspaces.startupAgentUserContextId";
/**
 * The id of the agent workspace Vimma made (docs/specs/vimma-mcp.md, decision 8): one of that
 * name with another id is the user's own, adopted, and `:mcp on` warns about it.
 */
export const AGENT_ID_PREF = "vimma.mcp.agentWorkspaceId";
/** `[mcp] workspace`'s default. */
export const DEFAULT_AGENT_WORKSPACE = "agent";

/** @param {string} code @param {string} message */
const storeError = (code, message) => Object.assign(new Error(message), { code });

/** @returns {string} */
const mintId = () => `ws-${Services.uuid.generateUUID().toString().slice(1, -1)}`;

export class WorkspaceStoreImpl {
  /** @type {Definitions} */
  definitions = emptyDefinitions();
  /** A newer vimma wrote the file: nothing is written, created or removed this session. */
  readOnly = false;
  /** Containers are off (`privacy.userContext.enabled`): no workspaces, upstream behaviour. */
  disabled = false;
  /** Names of workspaces whose container was gone or reused at startup and got a new one. */
  /** @type {string[]} */
  lostContainers = [];

  /** The status bar's persistent error, or null: containers off at startup. */
  get alert() {
    return this.disabled ? CONTAINERS_OFF_ALERT : null;
  }

  /** Every persistent status-bar error: containers off, then containers lost at startup. */
  get alerts() {
    const lost = lostContainersAlert(this.lostContainers);
    return [this.alert, lost].filter((a) => a !== null);
  }

  #path;
  #config;
  #enabled;
  /** @type {string | null} */
  #cachePref;
  /** @type {string | null} */
  #agentCachePref;
  #watch;
  #watching = false;
  /** @type {any} */
  #file = null;
  /** @type {Promise<void> | null} */
  #ready = null;
  /** Active workspace id per window (WindowWorkspaces sets it, sub-spec 2b). */
  /** @type {WeakMap<object, string>} */
  #active = new WeakMap();
  /** `[mcp] workspace`: the agent workspace's name, or null (a test's store has none). */
  /** @type {string | null} */
  #agent;
  /** The last workspace a window switched to that is not the agent's, this session. */
  /** @type {string | null} */
  #lastUser = null;
  /** Where the store records the id of an agent workspace it made, or null. */
  /** @type {string | null} */
  #agentPref;

  /**
   * @param {{ path?: string, config?: readonly Workspace[],
   *   enabled?: () => boolean, saveDelayMs?: number, cachePref?: string | null,
   *   watch?: boolean, agent?: string | null, agentPref?: string | null,
   *   agentCachePref?: string | null }} [options]
   *   `config` is the resolved `[workspaces]` (core `mergeWithDefaults(...).workspaces`);
   *   ConfigHost passes it once it reads `config.toml`. `enabled` reads the containers pref.
   *   `cachePref` (the app's store only) caches, for the next start, the container of the last
   *   workspace used that is not the agent's; `agentCachePref` the agent workspace's.
   *   `watch` (the app's store only) replaces a workspace's container deleted outside Vimma.
   *   `agent` is the agent workspace's name (`[mcp] workspace`), ensured at every reconcile
   *   (docs/specs/vimma-mcp.md, decision 8); null for none. `agentPref` records the id of one
   *   the store made.
   */
  constructor({
    path = PathUtils.join(PathUtils.profileDir, DEFINITIONS_FILE),
    config = [],
    enabled = () => Services.prefs.getBoolPref(CONTAINERS_PREF, true),
    saveDelayMs,
    cachePref = null,
    agentCachePref = null,
    watch = false,
    agent = null,
    agentPref = null,
  } = {}) {
    this.#agent = agent;
    this.#agentPref = agentPref;
    this.#cachePref = cachePref;
    this.#agentCachePref = agentCachePref;
    this.#watch = watch;
    this.#path = path;
    this.#config = config;
    this.#enabled = enabled;
    this.saveDelayMs = saveDelayMs;
  }

  get path() {
    return this.#path;
  }

  /** Loads, reconciles and checks containers, once; later calls return the same promise. */
  init() {
    this.#ready ??= this.#init();
    return this.#ready;
  }

  async #init() {
    if (!this.#enabled()) {
      this.disabled = true;
      return;
    }
    const file = this.#open();
    await file.load();
    this.definitions = await this.#parse(file.data);
    const { definitions, changed, agentCreated } = reconcileDefinitions(
      this.definitions,
      this.#config,
      mintId,
      { agent: this.#agent },
    );
    // Read-only: keep what was read (lenient) plus config, in memory only, with no containers.
    this.definitions = definitions;
    if (this.readOnly) return;
    this.#recordAgent(agentCreated);
    const containersChanged = this.#checkContainers();
    if (changed || containersChanged) this.#save();
    if (this.#watch && !this.#watching) {
      Services.obs.addObserver(this.#onDeleted, DELETED_TOPIC);
      this.#watching = true;
    }
  }

  /**
   * A container deleted outside Vimma (Settings → Containers, which closes its tabs first; an
   * extension's `contextualIdentities.remove`, which leaves them open in the deleted container):
   * if it was a workspace's, the workspace stays and gets a new, empty container at once, so its
   * new tabs never fall back to container 0. Vimma's own deleteWorkspace drops the definition
   * before it removes the container, so it never comes here.
   * @param {any} subject  `{ wrappedJSObject: { userContextId, name, ... } }`
   */
  #onDeleted = (subject) => {
    if (this.disabled || this.readOnly || !this.#enabled()) return;
    const ucid = subject?.wrappedJSObject?.userContextId;
    const w = ucid ? this.definitions.workspaces.find((d) => d.userContextId === ucid) : null;
    if (!w) return;
    this.#createContainer(w);
    this.#save();
    this.#notify([w.id]);
  };

  #open() {
    this.#file ??= new lazy.JSONFile({
      path: this.#path,
      backupTo: `${this.#path}.bak`,
      saveDelayMs: this.saveDelayMs,
      // A second guard: never replace a file a newer vimma wrote meanwhile.
      beforeSave: async () => {
        const text = await IOUtils.readUTF8(this.#path).catch(() => null);
        if (!canWriteDefinitions(text)) {
          throw storeError("read-only", `${this.#path} was written by a newer vimma`);
        }
      },
    });
    return this.#file;
  }

  /**
   * @param {unknown} raw JSONFile's data: `{}` for a missing file
   * @returns {Promise<Definitions>}
   */
  async #parse(raw) {
    if (raw && typeof raw === "object" && Object.keys(raw).length === 0) {
      return emptyDefinitions();
    }
    if (!canWriteDefinitions(raw)) {
      this.readOnly = true;
      console.warn(`vimma: ${this.#path} is from a newer vimma; workspaces are read-only`);
      try {
        return readDefinitions({ .../** @type {object} */ (raw), schema: 1 });
      } catch {
        return emptyDefinitions();
      }
    }
    try {
      return readDefinitions(raw);
    } catch (e) {
      // Valid JSON, invalid definitions: keep it aside rather than silently emptying it (Zen
      // #12460). JSONFile itself moves unparsable files to `.corrupt` and restores the backup.
      const aside = `${this.#path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      console.error(`vimma: ${this.#path} is invalid, moved to ${aside}:`, e);
      await IOUtils.copy(this.#path, aside).catch(console.error);
      return emptyDefinitions();
    }
  }

  /** The startup container check. @returns {boolean} whether the definitions changed */
  #checkContainers() {
    const CIS = lazy.ContextualIdentityService;
    const plan = planContainers(this.definitions, CIS.getPublicIdentities());
    const before = this.definitions;
    for (const id of plan.create) {
      const w = this.#def(id);
      if (w.userContextId !== null) this.lostContainers.push(w.name);
      this.#createContainer(w);
    }
    for (const id of plan.update) {
      const w = this.#def(id);
      CIS.update(w.userContextId, w.name, w.icon, w.color);
    }
    return this.definitions !== before;
  }

  /** @param {WorkspaceDefinition} w */
  #createContainer(w) {
    const identity = lazy.ContextualIdentityService.create(w.name, w.icon, w.color);
    this.definitions = withContainer(this.definitions, w.id, identity.userContextId);
    return identity.userContextId;
  }

  /** @param {string} id */
  #def(id) {
    return /** @type {WorkspaceDefinition} */ (
      this.definitions.workspaces.find((w) => w.id === id)
    );
  }

  #save() {
    if (this.readOnly || this.disabled) return;
    const file = this.#open();
    file.data = this.definitions;
    file.saveSoon();
    if (this.#cachePref) {
      Services.prefs.setIntPref(this.#cachePref, this.#userWorkspace()?.userContextId ?? 0);
      if (this.#agentCachePref) {
        Services.prefs.setIntPref(this.#agentCachePref, this.agent?.userContextId ?? 0);
      }
    }
  }

  /** @param {string | null} id  the agent workspace the reconcile made, if it made one */
  #recordAgent(id) {
    if (id && this.#agentPref) Services.prefs.setStringPref(this.#agentPref, id);
  }

  /** `[mcp] workspace`, the agent workspace's name, or null. */
  get agentName() {
    return this.#agent;
  }

  /** The agent workspace's definition, or null (none, or containers off). */
  get agent() {
    if (!this.#agent || this.disabled) return null;
    return this.definitions.workspaces.find((w) => w.name === this.#agent) ?? null;
  }

  /**
   * Whether the agent workspace is one the store made (its id is the one recorded), rather than
   * a workspace of yours of that name it adopted (vimma-mcp decision 8).
   */
  agentIsOurs() {
    const w = this.agent;
    if (!w || !this.#agentPref) return false;
    return Services.prefs.getStringPref(this.#agentPref, "") === w.id;
  }

  /** @param {string[]} ids */
  #notify(ids) {
    Services.obs.notifyObservers(null, CHANGED_TOPIC, JSON.stringify(ids));
  }

  #writable() {
    if (this.disabled) throw storeError("disabled", "workspaces are disabled (containers are off)");
    if (this.readOnly) {
      throw storeError("read-only", "workspaces are read-only (a newer vimma wrote them)");
    }
  }

  /**
   * Creates a runtime workspace with its own new container (decision 1).
   * @param {{ name: string, color: string, icon: string, home?: string }} w
   * @returns {WorkspaceDefinition}
   */
  addWorkspace(w) {
    this.#writable();
    const id = mintId();
    // Validates first, so a bad name never leaves a stray container behind.
    this.definitions = addRuntimeWorkspace(this.definitions, { ...w, id }, { agent: this.#agent });
    this.#createContainer(this.#def(id));
    this.#save();
    this.#notify([id]);
    return this.#def(id);
  }

  /**
   * Deletes a runtime workspace and its container, which deletes the container's cookies and
   * site data (decision 7). Only with `confirmed: true`, which the caller passes after the user
   * answered yes (the prompt is sub-spec 4a). Closes the container's tabs first. A container whose
   * name is no longer the workspace's (reused after a reset) is not ours and is left alone.
   * @param {string} id
   * @param {{ confirmed?: boolean }} [options]
   */
  async deleteWorkspace(id, { confirmed = false } = {}) {
    if (confirmed !== true) {
      throw storeError("not-confirmed", "deleting a workspace needs the user's confirmation");
    }
    this.#writable();
    const { definitions, removed } = removeWorkspaceDefinition(this.definitions, id, {
      agent: this.#agent,
    });
    const CIS = lazy.ContextualIdentityService;
    const ucid = removed.userContextId;
    // Never 0: closeContainerTabs(0) closes every container tab in every window.
    const ours =
      ucid !== null && ucid > 0 && CIS.getPublicIdentityFromId(ucid)?.name === removed.name;
    this.definitions = definitions;
    this.#save();
    if (ours) {
      await CIS.closeContainerTabs(ucid);
      CIS.remove(ucid);
    }
    this.#notify([id]);
    // `cleared: false`: the container was not recognisably ours (renamed in Settings, or reused
    // after a reset), so its tabs and site data were kept; the caller says so.
    return { cleared: ours };
  }

  /**
   * `prefix+shift+n` / `:wsnew name` (sub-spec 4a): a runtime workspace in the first colour no
   * workspace uses.
   * @param {string} name
   * @returns {WorkspaceDefinition}
   */
  newWorkspace(name) {
    return this.addWorkspace({ name, ...newWorkspaceLooks(this.definitions) });
  }

  /**
   * Renames a runtime workspace and its container (whose name must stay the workspace's: the
   * startup check adopts a container by id and name). Throws `config-workspace` for a config
   * one, `bad-name`, `duplicate-name`.
   * @param {string} id
   * @param {string} name
   */
  renameWorkspace(id, name) {
    this.#writable();
    const before = this.definitions;
    this.definitions = renameWorkspaceDefinition(before, id, name, { agent: this.#agent });
    if (this.definitions === before) return;
    const w = this.#def(id);
    const CIS = lazy.ContextualIdentityService;
    const old = before.workspaces.find((d) => d.id === id);
    const ucid = w.userContextId;
    if (ucid !== null && CIS.getPublicIdentityFromId(ucid)?.name === old?.name) {
      CIS.update(ucid, w.name, w.icon, w.color);
    }
    this.#save();
    this.#notify([id]);
  }

  /**
   * Links workspace `id` to its folder in the Bookmarks Toolbar (a Places guid; null unlinks),
   * docs/specs/bookmarks.md decision 11. Saved with the definitions; nothing to tell windows.
   * @param {string} id
   * @param {string | null} guid
   */
  setBookmarksFolder(id, guid) {
    this.#writable();
    const next = withBookmarksFolder(this.definitions, id, guid);
    if (next === this.definitions) return;
    this.definitions = next;
    this.#save();
  }

  /**
   * Closes a workspace after the user answered yes (decision 7): a runtime one is deleted with its
   * container and site data (deleteWorkspace); a config one only loses its tabs, in every
   * window, and stays with its container. The last workspace stays (`last-workspace`).
   * `asked` is the workspace as the question described it: the answer stands only for that,
   * so a config reload in between (which can make a config workspace runtime, and its close a
   * data deletion) or a rename refuses with `changed` and closes nothing.
   * @param {string} id
   * @param {{ confirmed?: boolean,
   *   asked?: Pick<WorkspaceDefinition, "source" | "name" | "userContextId"> }} [options]
   * @returns {Promise<{ cleared: boolean }>} whether its site data was deleted
   */
  async closeWorkspace(id, { confirmed = false, asked } = {}) {
    if (confirmed !== true) {
      throw storeError("not-confirmed", "closing a workspace needs the user's confirmation");
    }
    const w = this.definitions.workspaces.find((d) => d.id === id);
    if (
      asked &&
      (!w ||
        w.source !== asked.source ||
        w.name !== asked.name ||
        w.userContextId !== asked.userContextId)
    ) {
      throw storeError(
        "changed",
        `"${asked.name}" changed since you were asked (config.toml reloaded?); nothing was closed`,
      );
    }
    // The agent workspace is only emptied, as a config one (docs/specs/vimma-mcp.md, decision 8).
    const agent = !!w && w.name === this.#agent;
    if (w?.source !== "config" && !agent) return this.deleteWorkspace(id, { confirmed });
    const others = this.definitions.workspaces.filter((d) => d.name !== this.#agent);
    if (!agent && others.length === 1) {
      throw storeError("last-workspace", "cannot close the last workspace");
    }
    // Never 0: that would close every container tab in every window.
    const ucid = /** @type {WorkspaceDefinition} */ (w).userContextId;
    if (ucid !== null && ucid > 0) {
      await lazy.ContextualIdentityService.closeContainerTabs(ucid);
    }
    return { cleared: false };
  }

  /**
   * `:mcp forget` after the user answered yes (docs/specs/vimma-mcp.md, decision 8): deletes the
   * agent workspace's cookies and site data, as deleting a runtime workspace's container does
   * (ContextualIdentityService.remove), and keeps the workspace and its container. The yes
   * stands for the workspace and container asked about (`asked`), else `changed`.
   * @param {{ confirmed?: boolean, asked?: { id: string, userContextId: number | null } }} [options]
   */
  forgetAgent({ confirmed = false, asked } = {}) {
    if (confirmed !== true) {
      throw storeError("not-confirmed", "forgetting needs the user's confirmation");
    }
    this.#writable();
    const w = this.agent;
    if (!w) throw storeError("no-agent", "there is no agent workspace");
    if (asked && (asked.id !== w.id || asked.userContextId !== w.userContextId)) {
      throw storeError("changed", `"${w.name}" changed since you were asked; nothing was deleted`);
    }
    const ucid = w.userContextId;
    // Never 0: that pattern would be the default container's data, not the agent's.
    if (ucid === null || ucid <= 0) return;
    /** @type {any} */ (Services).clearData.deleteDataFromOriginAttributesPattern({
      userContextId: ucid,
    });
  }

  /**
   * The config's `[workspaces]` changed (ConfigHost, m5-config-load): reconciles the definitions
   * with it as init does (a workspace gone from the file becomes runtime; nothing is removed),
   * gives new ones a container, saves and tells the windows. `agent` is `[mcp] workspace`: a new
   * name makes that workspace the agent's, and the old one an ordinary one (vimma-mcp 8).
   * @param {readonly Workspace[]} config  core `mergeWithDefaults(...).workspaces`
   * @param {{ agent?: string | null }} [options]  left out: the agent name stays
   */
  async setConfig(config, { agent } = {}) {
    this.#config = config;
    if (agent !== undefined) this.#agent = agent;
    if (!this.#ready) return; // init() reads it
    await this.#ready;
    if (this.disabled || this.readOnly) return;
    const before = this.definitions;
    const { definitions, changed, agentCreated } = reconcileDefinitions(
      before,
      this.#config,
      mintId,
      { agent: this.#agent },
    );
    this.definitions = definitions;
    this.#recordAgent(agentCreated);
    this.#retireRecordedAgent();
    const containersChanged = this.#checkContainers();
    if (!changed && !containersChanged) return;
    this.#save();
    this.#notify(this.definitions.workspaces.map((w) => w.id));
  }

  /**
   * config.toml has named the agent workspace: one Vimma made earlier under another name is an
   * ordinary workspace again (vimma-mcp decision 8), so its recorded id stops counting.
   */
  #retireRecordedAgent() {
    if (!this.#agentPref) return;
    const made = Services.prefs.getStringPref(this.#agentPref, "");
    const named = this.agent;
    if (made && named && made !== named.id) Services.prefs.clearUserPref(this.#agentPref);
  }

  /**
   * Records the workspace a window switched to; it becomes `lastActive` for the next start.
   * @param {object | null} win
   * @param {string} id
   */
  setActive(win, id) {
    if (win) this.#active.set(win, id);
    if (!this.#agentIds().has(id)) this.#lastUser = id;
    const next = setLastActive(this.definitions, id);
    if (next !== this.definitions) {
      this.definitions = next;
      this.#save();
    }
  }

  /**
   * The container a tab or window opened without one takes (decision 3): the window's active
   * workspace's, else the most recent browser window's, else `lastActive`'s. Null for private
   * windows and popups, and when workspaces are disabled, so upstream behaviour stays there.
   * Before init has loaded the file it reads it synchronously (as ContextualIdentityService does).
   * `fromExternal` (addTab's flag: the command line's URLs) gives nonAgentUserContextId's.
   * @param {any} win
   * @param {{ fromExternal?: boolean }} [options]
   * @returns {number | null}
   */
  defaultUserContextId(win, { fromExternal = false } = {}) {
    if (fromExternal) return this.nonAgentUserContextId(win);
    if (this.disabled || !this.#enabled()) return null;
    if (win && (lazy.PrivateBrowsingUtils.isWindowPrivate(win) || win.toolbar?.visible === false)) {
      return null;
    }
    const top = lazy.BrowserWindowTracker.getTopWindow({ private: false });
    const active = (win && this.#active.get(win)) ?? (top && this.#active.get(top));
    // Also while init() is still loading: a window's first tab at startup is set up before it
    // ends. The container cached at the last save spares the synchronous read.
    if (!this.#file?.dataReady) {
      const cached = this.#cachePref ? Services.prefs.getIntPref(this.#cachePref, 0) : 0;
      if (!active && cached > 0) return cached;
      this.#readSync();
    }
    const id = active ?? this.definitions.lastActive;
    return this.definitions.workspaces.find((w) => w.id === id)?.userContextId ?? null;
  }

  /**
   * The container a tab you did not open inside the agent workspace takes (docs/specs/vimma-mcp.md,
   * decision 42): a link from another app, a URL from the control socket, a new window's first
   * tab. defaultUserContextId's, unless that is the agent workspace's: then the last workspace
   * used that is not the agent's, else the first one. Never the agent's, whose pages agents read:
   * a login link landing there would hand them the session. Null where defaultUserContextId is;
   * 0 (no container) when no workspace but the agent's has one.
   * @param {any} win
   * @returns {number | null}
   */
  nonAgentUserContextId(win) {
    const id = this.defaultUserContextId(win);
    if (id === null) return null;
    if (!this.#file?.dataReady) {
      // A start: the cache is trusted only once a save has recorded the agent's container too.
      const agentCached = this.#agentCachePref
        ? Services.prefs.getIntPref(this.#agentCachePref, -1)
        : -1;
      if (agentCached >= 0 && id !== agentCached) return id;
      this.#readSync();
    }
    if (!this.isAgentContainer(id)) return id;
    // No other workspace has a container: no container (0), never the agent's.
    return this.#userWorkspace()?.userContextId ?? 0;
  }

  /**
   * Whether `userContextId` is the agent workspace's container (any of #agentIds').
   * @param {number | null | undefined} userContextId
   */
  isAgentContainer(userContextId) {
    if (!userContextId) return false;
    this.ensureLoaded();
    const owner = this.definitions.workspaces.find((w) => w.userContextId === userContextId);
    return !!owner && this.#agentIds().has(owner.id);
  }

  /**
   * The ids of the workspaces that count as the agent's: the one `[mcp] workspace` names; the
   * one the store made (its recorded id), and the one whose container the last save recorded,
   * both of which hold before config.toml is read and gives another name than the default.
   * @returns {Set<string>}
   */
  #agentIds() {
    const ids = new Set();
    const named = this.agent;
    if (named) ids.add(named.id);
    const made = this.#agentPref ? Services.prefs.getStringPref(this.#agentPref, "") : "";
    if (made) ids.add(made);
    const cached = this.#agentCachePref ? Services.prefs.getIntPref(this.#agentCachePref, 0) : 0;
    for (const w of this.definitions.workspaces) {
      if (cached > 0 && w.userContextId === cached) ids.add(w.id);
    }
    return ids;
  }

  /** The workspace an outside open falls back to: the last one used that is not the agent's. */
  #userWorkspace() {
    const cached = this.#cachePref ? Services.prefs.getIntPref(this.#cachePref, 0) : 0;
    const fromCache = this.definitions.workspaces.find((w) => w.userContextId === cached)?.id;
    return userWorkspace(
      this.definitions,
      [this.#lastUser, this.definitions.lastActive, fromCache],
      { agent: this.#agent, exclude: [...this.#agentIds()] },
    );
  }

  /** Tests: as if no workspace but the agent's had been used this session. */
  _forgetLastUserWorkspaceForTesting() {
    this.#lastUser = null;
  }

  /**
   * A new window's first tab (Tabbrowser-sys-mjs.patch, hunk 2): the container a `[[routes]]`
   * rule gives the window's URL (spec workspace-routing), else nonAgentUserContextId's: a new
   * window never starts in the agent workspace. Null where that is null (private windows,
   * popups, containers off).
   * @param {any} win  the window being set up
   * @returns {number | null}
   */
  firstTabUserContextId(win) {
    const fallback = this.nonAgentUserContextId(win);
    if (fallback === null || this !== WorkspaceStore) return fallback;
    return lazy.WorkspaceRouter.firstTab(win) ?? fallback;
  }

  /** The definitions, read synchronously when init() has not loaded them yet (routing). */
  ensureLoaded() {
    if (!this.disabled && !this.#file?.dataReady) this.#readSync();
  }

  #readSync() {
    const file = this.#open();
    file.ensureDataReady();
    try {
      this.definitions = readDefinitions(file.data);
    } catch {
      // Missing, newer or invalid: init() sorts it out; until then, no default.
    }
  }

  /** Flushes a pending save and stops saving (shutdown does this on its own). */
  async finalize() {
    if (this.#watching) Services.obs.removeObserver(this.#onDeleted, DELETED_TOPIC);
    this.#watching = false;
    if (this.#file) await this.#file.finalize();
  }
}

/** The app's store. */
export const WorkspaceStore = new WorkspaceStoreImpl({
  cachePref: STARTUP_PREF,
  agentCachePref: STARTUP_AGENT_PREF,
  watch: true,
  agent: DEFAULT_AGENT_WORKSPACE,
  agentPref: AGENT_ID_PREF,
});
