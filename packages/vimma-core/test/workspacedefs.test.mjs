// Spec: docs/specs/m3-workspaces.md (sub-spec 1, m3-workspace-store): the definitions file.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_WORKSPACE_NAME,
  DEFINITIONS_SCHEMA_VERSION,
  DefinitionsError,
  addRuntimeWorkspace,
  canWriteDefinitions,
  closeWorkspaceQuestion,
  emptyDefinitions,
  lostContainersAlert,
  moveTabQuestion,
  unpinnedNotice,
  newWorkspaceLooks,
  planContainers,
  readDefinitions,
  reconcileDefinitions,
  removeWorkspaceDefinition,
  renameWorkspaceDefinition,
  setLastActive,
  withBookmarksFolder,
  withContainer,
  userWorkspace,
  deleteBookmarksQuestion,
  AGENT_LOOKS,
} from "../src/workspacedefs.mjs";

const fixture = (/** @type {string} */ name) =>
  readFileSync(new URL(`../../../tests/contract/workspaces/v1/${name}`, import.meta.url), "utf8");

/** A deterministic id minter: ws-1, ws-2, … */
function minter() {
  let n = 0;
  return () => `ws-${++n}`;
}

/** @param {() => unknown} fn */
function defsError(fn) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DefinitionsError);
    return /** @type {DefinitionsError} */ (e);
  }
  throw new Error("expected a DefinitionsError");
}

/**
 * @param {string} name
 * @param {Partial<{ color: string, icon: string, home: string }>} [o]
 */
const cfg = (name, o = {}) => ({ name, color: "gray", icon: "circle", autofill: true, ...o });

describe("contract fixtures, schema v1", () => {
  test("valid.json reads and stays as written", () => {
    const d = readDefinitions(fixture("valid.json"));
    expect(d.workspaces.map((w) => w.name)).toEqual(["work", "shop"]);
    expect(d).toEqual(JSON.parse(fixture("valid.json")));
    expect(DEFINITIONS_SCHEMA_VERSION).toBe(1);
  });

  test("invalid.json fails naming the path", () => {
    const e = defsError(() => readDefinitions(fixture("invalid.json")));
    expect(e.path).toBe("workspaces[1].color");
  });

  test("a newer schema is unsupported, and may not be overwritten", () => {
    const text = fixture("invalid-newer.json");
    expect(defsError(() => readDefinitions(text)).code).toBe("unsupported-schema");
    expect(canWriteDefinitions(text)).toBe(false);
  });
});

describe("readDefinitions", () => {
  test.each([
    [{ schema: 1, lastActive: null }, "workspaces"],
    [{ schema: 1, lastActive: null, workspaces: [{ id: "a b" }] }, "workspaces[0].id"],
    [
      {
        schema: 1,
        lastActive: "x",
        workspaces: [
          {
            id: "x",
            name: "a",
            userContextId: 7,
            color: "gray",
            icon: "circle",
            source: "runtime",
          },
          {
            id: "x",
            name: "b",
            userContextId: 8,
            color: "gray",
            icon: "circle",
            source: "runtime",
          },
        ],
      },
      "workspaces[1].id",
    ],
    [
      {
        schema: 1,
        lastActive: "x",
        workspaces: [
          {
            id: "x",
            name: "a",
            userContextId: 0,
            color: "gray",
            icon: "circle",
            source: "runtime",
          },
        ],
      },
      "workspaces[0].userContextId",
    ],
    [
      {
        schema: 1,
        lastActive: "nope",
        workspaces: [
          {
            id: "x",
            name: "a",
            userContextId: 5,
            color: "gray",
            icon: "circle",
            source: "runtime",
          },
        ],
      },
      "lastActive",
    ],
    [
      {
        schema: 1,
        lastActive: null,
        workspaces: [
          { id: "x", name: "", userContextId: 5, color: "gray", icon: "circle", source: "runtime" },
        ],
      },
      "workspaces[0].name",
    ],
    [
      {
        schema: 1,
        lastActive: null,
        workspaces: [
          { id: "x", name: "a", userContextId: 5, color: "gray", icon: "circle", source: "x" },
        ],
      },
      "workspaces[0].source",
    ],
  ])("rejects %j at %s", (doc, path) => {
    expect(defsError(() => readDefinitions(doc)).path).toBe(path);
  });

  // docs/security.md: container 0 is the default container, shared by every page outside a
  // workspace. A file that names it must never make a workspace delete or close it.
  test("container 0 is never a workspace's: a stored id of 0 or below is refused", () => {
    for (const userContextId of [0, -1, 1.5, "3"]) {
      const doc = {
        schema: 1,
        lastActive: null,
        workspaces: [
          { id: "x", name: "a", userContextId, color: "gray", icon: "circle", source: "runtime" },
        ],
      };
      expect(defsError(() => readDefinitions(doc)).path, String(userContextId)).toBe(
        "workspaces[0].userContextId",
      );
    }
  });

  test("text that is not JSON is a syntax error", () => {
    expect(defsError(() => readDefinitions("{")).code).toBe("syntax");
  });
});

describe("canWriteDefinitions", () => {
  test.each([
    [null, true],
    ["not json", true],
    [{ schema: 1 }, true],
    [{ schema: 2 }, false],
    ['{"schema": 9}', false],
  ])("%j → %s", (existing, ok) => {
    expect(canWriteDefinitions(existing)).toBe(ok);
  });
});

describe("reconcileDefinitions", () => {
  test("nothing at all gives one runtime workspace, main (gray circle), active", () => {
    const { definitions, changed } = reconcileDefinitions(emptyDefinitions(), [], minter());
    expect(changed).toBe(true);
    expect(definitions).toEqual({
      schema: 1,
      lastActive: "ws-1",
      workspaces: [
        {
          id: "ws-1",
          name: DEFAULT_WORKSPACE_NAME,
          userContextId: null,
          color: "gray",
          icon: "circle",
          source: "runtime",
        },
      ],
    });
    expect(DEFAULT_WORKSPACE_NAME).toBe("main");
  });

  test("a second run with the same input changes nothing (idempotent)", () => {
    const once = reconcileDefinitions(emptyDefinitions(), [cfg("work")], minter()).definitions;
    const twice = reconcileDefinitions(once, [cfg("work")], minter());
    expect(twice.changed).toBe(false);
    expect(twice.definitions).toBe(once);
  });

  test("config workspaces match by name, keep their id and take colour, icon and home", () => {
    const first = reconcileDefinitions(
      emptyDefinitions(),
      [cfg("work"), cfg("admin")],
      minter(),
    ).definitions;
    const next = withContainer(first, "ws-1", 9);
    const { definitions } = reconcileDefinitions(
      next,
      [cfg("admin", { color: "red" }), cfg("work", { icon: "briefcase", home: "https://a.b/" })],
      minter(),
    );
    expect(definitions.workspaces).toEqual([
      expect.objectContaining({ id: "ws-2", name: "admin", color: "red", source: "config" }),
      expect.objectContaining({
        id: "ws-1",
        name: "work",
        icon: "briefcase",
        home: "https://a.b/",
        userContextId: 9,
      }),
    ]);
  });

  test("config first in file order, then runtime ones; a removed config one becomes runtime", () => {
    let d = reconcileDefinitions(
      emptyDefinitions(),
      [cfg("work"), cfg("admin")],
      minter(),
    ).definitions;
    d = addRuntimeWorkspace(d, { id: "ws-9", name: "shop", color: "pink", icon: "cart" });
    const { definitions, changed } = reconcileDefinitions(d, [cfg("personal")], minter());
    expect(changed).toBe(true);
    expect(definitions.workspaces.map((w) => [w.name, w.source])).toEqual([
      ["personal", "config"],
      ["work", "runtime"],
      ["admin", "runtime"],
      ["shop", "runtime"],
    ]);
  });

  test("a runtime workspace named like a new config entry becomes that config workspace", () => {
    const d = addRuntimeWorkspace(emptyDefinitions(), {
      id: "ws-7",
      name: "work",
      color: "gray",
      icon: "circle",
    });
    const { definitions } = reconcileDefinitions(d, [cfg("work", { color: "blue" })], minter());
    expect(definitions.workspaces).toEqual([
      expect.objectContaining({ id: "ws-7", source: "config", color: "blue" }),
    ]);
  });

  test("a dropped home is removed; lastActive falls back to the first workspace", () => {
    let d = reconcileDefinitions(
      emptyDefinitions(),
      [cfg("a", { home: "about:blank" }), cfg("b")],
      minter(),
    ).definitions;
    d = setLastActive(d, "ws-2");
    expect(d.lastActive).toBe("ws-2");
    const { definitions } = reconcileDefinitions(d, [cfg("a")], minter());
    expect(definitions.workspaces[0]).not.toHaveProperty("home");
    expect(definitions.lastActive).toBe("ws-2");
    const gone = removeWorkspaceDefinition(definitions, "ws-2").definitions;
    expect(gone.lastActive).toBe("ws-1");
  });
});

describe("planContainers", () => {
  const defs = {
    schema: 1,
    lastActive: "a",
    workspaces: [
      { id: "a", name: "a", userContextId: 6, color: "gray", icon: "circle", source: "runtime" },
      { id: "b", name: "b", userContextId: 7, color: "red", icon: "circle", source: "runtime" },
      { id: "c", name: "c", userContextId: 8, color: "gray", icon: "circle", source: "runtime" },
      { id: "d", name: "d", userContextId: null, color: "gray", icon: "circle", source: "runtime" },
    ],
  };
  const identities = [
    { userContextId: 1, l10nId: "user-context-personal", color: "blue", icon: "fingerprint" },
    { userContextId: 6, name: "a", color: "gray", icon: "circle" },
    { userContextId: 7, name: "b", color: "gray", icon: "circle" },
    { userContextId: 8, name: "someone else's", color: "gray", icon: "circle" },
  ];

  test("adopts by stored id and name, updates drifted looks, creates for missing or reused", () => {
    expect(planContainers(/** @type {any} */ (defs), identities)).toEqual({
      adopt: ["a", "b"],
      update: ["b"],
      create: ["c", "d"],
    });
  });

  test("never matches Firefox's default containers by name", () => {
    const d = {
      schema: 1,
      lastActive: "p",
      workspaces: [
        {
          id: "p",
          name: "personal",
          userContextId: null,
          color: "blue",
          icon: "fingerprint",
          source: "config",
        },
      ],
    };
    expect(planContainers(/** @type {any} */ (d), identities).create).toEqual(["p"]);
  });
});

describe("runtime workspaces", () => {
  test("names are unique and valid", () => {
    const d = addRuntimeWorkspace(emptyDefinitions(), {
      id: "x",
      name: "a",
      color: "gray",
      icon: "circle",
    });
    expect(
      defsError(() => addRuntimeWorkspace(d, { id: "y", name: "a", color: "gray", icon: "circle" }))
        .code,
    ).toBe("duplicate-name");
    expect(
      defsError(() => addRuntimeWorkspace(d, { id: "x", name: "b", color: "gray", icon: "circle" }))
        .code,
    ).toBe("duplicate-id");
    expect(
      defsError(() => addRuntimeWorkspace(d, { id: "y", name: "b", color: "blu", icon: "circle" }))
        .code,
    ).toBe("bad-color");
  });

  test("removal: only runtime ones, never the last; returns the removed definition", () => {
    const main = reconcileDefinitions(emptyDefinitions(), [], minter()).definitions;
    expect(defsError(() => removeWorkspaceDefinition(main, "ws-1")).code).toBe("last-workspace");
    let d = reconcileDefinitions(emptyDefinitions(), [cfg("work")], minter()).definitions;
    d = withContainer(
      addRuntimeWorkspace(d, { id: "r", name: "r", color: "gray", icon: "circle" }),
      "r",
      12,
    );
    expect(defsError(() => removeWorkspaceDefinition(d, "ws-1")).code).toBe("config-workspace");
    expect(defsError(() => removeWorkspaceDefinition(d, "zz")).code).toBe("unknown-workspace");
    const { definitions, removed } = removeWorkspaceDefinition(d, "r");
    expect(removed.userContextId).toBe(12);
    expect(definitions.workspaces.map((w) => w.id)).toEqual(["ws-1"]);
  });
});

// Sub-spec 4a (m3-workspace-lifecycle): rename, the close question, a new workspace's looks.
describe("workspace lifecycle", () => {
  const twoKinds = () => {
    const d = reconcileDefinitions(emptyDefinitions(), [cfg("work")], minter()).definitions;
    return withContainer(
      addRuntimeWorkspace(d, { id: "r", name: "shop", color: "gray", icon: "circle" }),
      "r",
      12,
    );
  };

  test("rename: a runtime workspace takes a valid, unused name", () => {
    const d = twoKinds();
    const renamed = renameWorkspaceDefinition(d, "r", "market");
    expect(renamed.workspaces.map((w) => w.name)).toEqual(["work", "market"]);
    expect(renamed.workspaces[1]?.userContextId).toBe(12);
    expect(renameWorkspaceDefinition(d, "r", "shop")).toBe(d);
    expect(defsError(() => renameWorkspaceDefinition(d, "r", "work")).code).toBe("duplicate-name");
    expect(defsError(() => renameWorkspaceDefinition(d, "r", "")).code).toBe("bad-name");
    expect(defsError(() => renameWorkspaceDefinition(d, "r", "x".repeat(33))).code).toBe(
      "bad-name",
    );
    expect(defsError(() => renameWorkspaceDefinition(d, "zz", "a")).code).toBe("unknown-workspace");
  });

  test("a name of digits only is refused: `:wsmove 2` reads it as a place", () => {
    const d = twoKinds();
    for (const name of ["2", "10", "007"]) {
      const added = defsError(() =>
        addRuntimeWorkspace(d, { id: "n", name, color: "gray", icon: "circle" }),
      );
      expect(added.code).toBe("bad-name");
      expect(added.message).toMatch(/digits/);
      expect(defsError(() => renameWorkspaceDefinition(d, "r", name)).code).toBe("bad-name");
    }
    expect(renameWorkspaceDefinition(d, "r", "2nd").workspaces[1]?.name).toBe("2nd");
  });

  test("rename: a config workspace is renamed in config.toml, not here", () => {
    const e = defsError(() => renameWorkspaceDefinition(twoKinds(), "ws-1", "job"));
    expect(e.code).toBe("config-workspace");
    expect(e.message).toContain("config.toml");
  });

  test("the close question says what goes: data for runtime ones, tabs only for config", () => {
    const [work, shop] = twoKinds().workspaces;
    expect(closeWorkspaceQuestion(/** @type {any} */ (shop), 4)).toBe(
      'Close "shop" (4 tabs) and delete its cookies and site data? y/N',
    );
    expect(closeWorkspaceQuestion(/** @type {any} */ (shop), 1)).toBe(
      'Close "shop" (1 tab) and delete its cookies and site data? y/N',
    );
    expect(closeWorkspaceQuestion(/** @type {any} */ (work), 2)).toBe(
      'Close the 2 tabs of "work"? It stays, as it is in config.toml. y/N',
    );
  });

  test("moving a tab asks first, saying that its history stays behind (decision 6)", () => {
    expect(moveTabQuestion("beta")).toBe(
      'Move this tab to "beta"? It is reopened there; its back/forward history and form data ' +
        "are lost. y/N",
    );
  });

  test("lost containers at startup are one persistent alert naming them (sub-spec 4a)", () => {
    expect(lostContainersAlert([])).toBeNull();
    expect(lostContainersAlert(["work"])).toBe(
      '"work" lost its container since the last run; it has a new, empty one, so its sites need ' +
        "a new sign-in",
    );
    expect(lostContainersAlert(["work", "shop"])).toBe(
      '"work", "shop" lost their containers since the last run; they have new, empty ones, so ' +
        "their sites need a new sign-in",
    );
  });

  test("a pinned tab is unpinned with a notice naming it (decision 11)", () => {
    expect(unpinnedNotice("Inbox")).toBe(
      'unpinned "Inbox": a pinned tab would show in every workspace',
    );
    expect(unpinnedNotice("")).toBe("unpinned a tab: a pinned tab would show in every workspace");
  });

  test("a new workspace takes the first colour no workspace uses, and a circle", () => {
    const d = twoKinds(); // both gray
    expect(newWorkspaceLooks(d)).toEqual({ color: "blue", icon: "circle" });
    const blue = addRuntimeWorkspace(d, { id: "b", name: "b", color: "blue", icon: "circle" });
    expect(newWorkspaceLooks(blue).color).toBe("green");
    expect(newWorkspaceLooks(emptyDefinitions()).color).toBe("blue");
  });
});

// docs/specs/bookmarks.md, decision 11: a workspace's bookmarks
// folder is linked by its Places guid, kept in the definitions file.
describe("bookmarksFolder", () => {
  const base = () => reconcileDefinitions(emptyDefinitions(), [cfg("work")], minter()).definitions;

  test("withBookmarksFolder links a folder; the same guid returns the input", () => {
    const d = base();
    const linked = withBookmarksFolder(d, "ws-1", "abcdefghijkl");
    expect(linked.workspaces[0]?.bookmarksFolder).toBe("abcdefghijkl");
    expect(withBookmarksFolder(linked, "ws-1", "abcdefghijkl")).toBe(linked);
    expect(d.workspaces[0]?.bookmarksFolder).toBeUndefined();
    expect(withBookmarksFolder(linked, "ws-1", null).workspaces[0]).not.toHaveProperty(
      "bookmarksFolder",
    );
    expect(defsError(() => withBookmarksFolder(d, "ws-1", "not a guid")).code).toBe("invalid");
  });

  test("it is read back from the file, and checked", () => {
    const linked = withBookmarksFolder(base(), "ws-1", "abcdefghijkl");
    expect(readDefinitions(JSON.stringify(linked))).toEqual(linked);
    const bad = structuredClone(linked);
    /** @type {any} */ (bad.workspaces[0]).bookmarksFolder = 12;
    expect(defsError(() => readDefinitions(bad)).path).toBe("workspaces[0].bookmarksFolder");
  });

  test("a reconcile keeps it, for config and runtime workspaces, and a rename too", () => {
    const linked = withBookmarksFolder(base(), "ws-1", "abcdefghijkl");
    const again = reconcileDefinitions(linked, [cfg("work", { color: "blue" })], minter());
    expect(again.definitions.workspaces[0]?.bookmarksFolder).toBe("abcdefghijkl");
    const runtime = reconcileDefinitions(linked, [], minter()).definitions;
    expect(runtime.workspaces[0]).toMatchObject({
      source: "runtime",
      bookmarksFolder: "abcdefghijkl",
    });
    const renamed = renameWorkspaceDefinition(runtime, "ws-1", "job");
    expect(renamed.workspaces[0]).toMatchObject({ name: "job", bookmarksFolder: "abcdefghijkl" });
  });

  test("keeping it is no change; relinking is a new object", () => {
    const linked = withBookmarksFolder(base(), "ws-1", "abcdefghijkl");
    const again = reconcileDefinitions(linked, [cfg("work")], minter());
    expect(again.changed).toBe(false);
    expect(again.definitions).toBe(linked);
    const moved = withBookmarksFolder(linked, "ws-1", "mnopqrstuvwx");
    expect(moved).not.toBe(linked);
    expect(moved.workspaces[0]?.bookmarksFolder).toBe("mnopqrstuvwx");
  });
});

describe("deleteBookmarksQuestion", () => {
  test("names the count and the three choices, keep first", () => {
    expect(deleteBookmarksQuestion("work", 3, "main")).toBe(
      'The 3 bookmarks of "work": k keep the folder (default), m move them to "main", ' +
        "d delete them? K/m/d",
    );
    expect(deleteBookmarksQuestion("work", 1, null)).toBe(
      'The 1 bookmark of "work": k keep the folder (default), d delete it? K/d',
    );
  });
});

// docs/specs/vimma-mcp.md, decisions 8, 9 and 11: every profile has an agent workspace; the
// reconcile ensures it, last.
describe("the agent workspace", () => {
  const agent = { agent: "agent" };
  const names = (/** @type {{ workspaces: { name: string }[] }} */ d) =>
    d.workspaces.map((w) => w.name);

  test("an empty file gives main, then agent (cyan, fingerprint, runtime); created names it", () => {
    const r = reconcileDefinitions(emptyDefinitions(), [], minter(), agent);
    expect(r.changed).toBe(true);
    expect(r.definitions.workspaces).toEqual([
      expect.objectContaining({ id: "ws-1", name: "main", source: "runtime" }),
      {
        id: "ws-2",
        name: "agent",
        userContextId: null,
        color: "cyan",
        icon: "fingerprint",
        source: "runtime",
      },
    ]);
    expect(r.definitions.lastActive).toBe("ws-1");
    expect(r.agentCreated).toBe("ws-2");
    expect(AGENT_LOOKS).toEqual({ color: "cyan", icon: "fingerprint" });
  });

  test("an existing profile (main, work) gets agent appended; the others keep ids and order", () => {
    const before = withContainer(
      addRuntimeWorkspace(reconcileDefinitions(emptyDefinitions(), [], minter()).definitions, {
        id: "ws-work",
        name: "work",
        color: "blue",
        icon: "circle",
      }),
      "ws-work",
      7,
    );
    const r = reconcileDefinitions(before, [], () => "ws-new", agent);
    expect(names(r.definitions)).toEqual(["main", "work", "agent"]);
    expect(r.definitions.workspaces.slice(0, 2)).toEqual(before.workspaces);
    expect(r.definitions.lastActive).toBe(before.lastActive);
    expect(r.agentCreated).toBe("ws-new");
  });

  test("a workspace already named agent is adopted, not duplicated, and sorts last", () => {
    let d = reconcileDefinitions(
      emptyDefinitions(),
      [cfg("agent"), cfg("work")],
      minter(),
    ).definitions;
    const r = reconcileDefinitions(d, [cfg("agent"), cfg("work")], minter(), agent);
    expect(names(r.definitions)).toEqual(["work", "agent"]);
    expect(r.definitions.workspaces[1]).toEqual(
      expect.objectContaining({ id: "ws-1", source: "config", color: "gray" }),
    );
    expect(r.agentCreated).toBeNull();
    d = addRuntimeWorkspace(r.definitions, { id: "x", name: "x", color: "red", icon: "circle" });
    expect(names(d)).toEqual(["work", "agent", "x"]);
    expect(
      names(reconcileDefinitions(d, [cfg("agent"), cfg("work")], minter(), agent).definitions),
    ).toEqual(["work", "x", "agent"]);
  });

  test('[mcp] workspace = "bots": bots is ensured; an old agent stays, an ordinary workspace', () => {
    const d = reconcileDefinitions(emptyDefinitions(), [], minter(), agent).definitions;
    const r = reconcileDefinitions(d, [], () => "ws-bots", { agent: "bots" });
    expect(names(r.definitions)).toEqual(["main", "agent", "bots"]);
    expect(r.definitions.workspaces[1]).toEqual(d.workspaces[1]);
    expect(r.definitions.workspaces[2]).toEqual(
      expect.objectContaining({ id: "ws-bots", color: "cyan", icon: "fingerprint" }),
    );
  });

  test("reconciling twice changes nothing", () => {
    const once = reconcileDefinitions(emptyDefinitions(), [cfg("work")], minter(), agent);
    const twice = reconcileDefinitions(once.definitions, [cfg("work")], minter(), agent);
    expect(twice.changed).toBe(false);
    expect(twice.definitions).toBe(once.definitions);
    expect(twice.agentCreated).toBeNull();
  });

  test("a new runtime workspace goes before the agent workspace, which stays last", () => {
    const d = reconcileDefinitions(emptyDefinitions(), [], minter(), agent).definitions;
    const added = addRuntimeWorkspace(
      d,
      { id: "s", name: "shop", color: "red", icon: "circle" },
      agent,
    );
    expect(names(added)).toEqual(["main", "shop", "agent"]);
  });

  test("it cannot be deleted, only emptied; renaming it is refused", () => {
    const d = reconcileDefinitions(emptyDefinitions(), [], minter(), agent).definitions;
    const del = defsError(() => removeWorkspaceDefinition(d, "ws-2", agent));
    expect(del.code).toBe("agent-workspace");
    const ren = defsError(() => renameWorkspaceDefinition(d, "ws-2", "robots", agent));
    expect(ren.code).toBe("agent-workspace");
    expect(ren.message).toBe("its name is [mcp] workspace in config.toml");
    expect(renameWorkspaceDefinition(d, "ws-1", "home", agent).workspaces[0]?.name).toBe("home");
  });

  test("the last workspace besides the agent's stays: agent is never all that is left", () => {
    const d = reconcileDefinitions(emptyDefinitions(), [], minter(), agent).definitions;
    expect(defsError(() => removeWorkspaceDefinition(d, "ws-1", agent)).code).toBe(
      "last-workspace",
    );
    const two = addRuntimeWorkspace(d, { id: "s", name: "shop", color: "red", icon: "circle" });
    expect(removeWorkspaceDefinition(two, "ws-1", agent).removed.name).toBe("main");
  });

  test("its close question says it stays with its logins; its move question warns", () => {
    const d = reconcileDefinitions(emptyDefinitions(), [], minter(), agent).definitions;
    const a = /** @type {any} */ (d.workspaces[1]);
    expect(closeWorkspaceQuestion(a, 2, agent)).toBe(
      'Close the 2 tabs of "agent"? It stays, with its cookies and logins (:mcp forget clears them). y/N',
    );
    expect(closeWorkspaceQuestion(/** @type {any} */ (d.workspaces[0]), 2, agent)).toBe(
      'Close "main" (2 tabs) and delete its cookies and site data? y/N',
    );
    expect(moveTabQuestion("agent", agent)).toBe(
      'Move this tab to "agent"? Agents you allow can read it there. It is reopened with the ' +
        "agent's cookies; its history and form data are lost. y/N",
    );
    expect(moveTabQuestion("main", agent)).toBe(moveTabQuestion("main"));
  });
});

// docs/specs/vimma-mcp.md, decision 42: a tab you did not open inside the agent workspace (a
// link from another app, a new window, the first tab at startup) never takes its container.
describe("the workspace an outside open takes", () => {
  const agent = { agent: "agent" };
  /** main (1), work (2), agent (3), and a fourth with no container yet. */
  function defs() {
    let d = reconcileDefinitions(emptyDefinitions(), [], minter(), agent).definitions;
    d = addRuntimeWorkspace(d, { id: "w", name: "work", color: "blue", icon: "circle" }, agent);
    d = addRuntimeWorkspace(d, { id: "n", name: "new", color: "red", icon: "circle" }, agent);
    d = withContainer(withContainer(withContainer(d, "ws-1", 1), "w", 2), "ws-2", 3);
    return d;
  }

  test("the first wanted workspace that is not the agent's and has a container", () => {
    expect(userWorkspace(defs(), ["w", "ws-1"], agent)?.name).toBe("work");
    expect(userWorkspace(defs(), ["ws-2", "w"], agent)?.name).toBe("work");
    expect(userWorkspace(defs(), [null, undefined, "gone", "n", "ws-1"], agent)?.name).toBe("main");
  });

  test("none wanted, or only the agent's: the first workspace that is not the agent's", () => {
    expect(userWorkspace(defs(), ["ws-2"], agent)?.name).toBe("main");
    expect(userWorkspace(defs(), [], agent)?.name).toBe("main");
    const agentFirst = { ...defs(), workspaces: [...defs().workspaces].reverse() };
    expect(userWorkspace(agentFirst, ["ws-2"], agent)?.name).toBe("work");
  });

  test("never the agent workspace, even when it is all there is with a container", () => {
    const d = reconcileDefinitions(emptyDefinitions(), [], minter(), agent).definitions;
    expect(userWorkspace(withContainer(d, "ws-2", 3), ["ws-2"], agent)).toBeNull();
    expect(userWorkspace(withContainer(d, "ws-1", 1), ["ws-2"], agent)?.name).toBe("main");
  });

  test("workspaces named in exclude are skipped too (an agent workspace under another name)", () => {
    expect(userWorkspace(defs(), ["w", "ws-1"], { ...agent, exclude: ["w"] })?.name).toBe("main");
    expect(userWorkspace(defs(), [], { ...agent, exclude: ["ws-1"] })?.name).toBe("work");
  });

  test("with no agent workspace configured, the wanted one is taken as it is", () => {
    expect(userWorkspace(defs(), ["ws-2"])?.name).toBe("agent");
  });
});
