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
} from "../src/workspaces/workspacedefs.mjs";

const fixture = (name: string) =>
  readFileSync(new URL(`../../../tests/contract/workspaces/v1/${name}`, import.meta.url), "utf8");

/** A deterministic id minter: ws-1, ws-2, … */
function minter() {
  let n = 0;
  return () => `ws-${++n}`;
}

function defsError(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DefinitionsError);
    return e as DefinitionsError;
  }
  throw new Error("expected a DefinitionsError");
}

const cfg = (name: string, o: Partial<{ color: string; icon: string; home: string }> = {}) => ({
  name,
  color: "gray",
  icon: "circle",
  autofill: true,
  ...o,
});

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

  // docs/security/: container 0 is the default container, shared by every page outside a
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
    expect(planContainers(defs as any, identities)).toEqual({
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
    expect(planContainers(d as any, identities).create).toEqual(["p"]);
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
    expect(closeWorkspaceQuestion(shop as any, 4)).toBe(
      'Close "shop" (4 tabs) and delete its cookies and site data? y/N',
    );
    expect(closeWorkspaceQuestion(shop as any, 1)).toBe(
      'Close "shop" (1 tab) and delete its cookies and site data? y/N',
    );
    expect(closeWorkspaceQuestion(work as any, 2)).toBe(
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
    (bad.workspaces[0] as any).bookmarksFolder = 12;
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
  const names = (d: { workspaces: { name: string }[] }) => d.workspaces.map((w) => w.name);

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
    const a = d.workspaces[1] as any;
    expect(closeWorkspaceQuestion(a, 2, agent)).toBe(
      'Close the 2 tabs of "agent"? It stays, with its cookies and logins (:mcp forget clears them). y/N',
    );
    expect(closeWorkspaceQuestion(d.workspaces[0] as any, 2, agent)).toBe(
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

// #1119: mutants the tests above let through.
describe("readDefinitions: every rule, and what it says", () => {
  /** One valid runtime workspace, changed by `over`. */
  const doc = (over: Record<string, unknown> = {}, more: Record<string, unknown> = {}) => ({
    schema: 1,
    lastActive: null,
    workspaces: [
      {
        id: "x",
        name: "a",
        userContextId: 5,
        color: "gray",
        icon: "circle",
        source: "runtime",
        ...over,
      },
    ],
    ...more,
  });
  const second = (over: Record<string, unknown>) => ({
    schema: 1,
    lastActive: null,
    workspaces: [
      { id: "x", name: "a", userContextId: 5, color: "gray", icon: "circle", source: "runtime" },
      {
        id: "y",
        name: "b",
        userContextId: 6,
        color: "gray",
        icon: "circle",
        source: "runtime",
        ...over,
      },
    ],
  });

  test.each([
    ["not an object", 5, "invalid", "", "must be a JSON object"],
    ["an array", [], "invalid", "", "must be a JSON object"],
    ["no schema", { workspaces: [] }, "invalid", "schema", "schema: missing or not an integer"],
    [
      "another schema",
      doc({}, { schema: 2 }),
      "unsupported-schema",
      "schema",
      "schema: schema 2 is not supported",
    ],
    [
      "no workspaces list",
      { schema: 1, lastActive: null },
      "invalid",
      "workspaces",
      "workspaces: must be an array",
    ],
    [
      "a workspace not an object",
      { schema: 1, lastActive: null, workspaces: ["x"] },
      "invalid",
      "workspaces[0]",
      "workspaces[0]: must be an object",
    ],
    [
      "a bad id",
      doc({ id: "a b" }),
      "bad-id",
      "workspaces[0].id",
      "workspaces[0].id: not a valid id",
    ],
    [
      "an id twice",
      second({ id: "x" }),
      "duplicate-id",
      "workspaces[1].id",
      'workspaces[1].id: "x" twice',
    ],
    [
      "a name twice",
      second({ name: "a" }),
      "duplicate-name",
      "workspaces[1].name",
      'workspaces[1].name: "a" twice',
    ],
    [
      "an empty name",
      doc({ name: "" }),
      "bad-name",
      "workspaces[0].name",
      "workspaces[0].name: 1 to 32 characters",
    ],
    [
      "a name that is not a string",
      doc({ name: ["a"] }),
      "bad-name",
      "workspaces[0].name",
      "workspaces[0].name: 1 to 32 characters",
    ],
    [
      "a name of 33 characters",
      doc({ name: "n".repeat(33) }),
      "bad-name",
      "workspaces[0].name",
      "workspaces[0].name: 1 to 32 characters",
    ],
    [
      "a name with a control character",
      doc({ name: "a\u0001" }),
      "bad-name",
      "workspaces[0].name",
      "workspaces[0].name: 1 to 32 characters",
    ],
    [
      "a name with a tab",
      doc({ name: "a\tb" }),
      "bad-name",
      "workspaces[0].name",
      "workspaces[0].name: 1 to 32 characters",
    ],
    [
      "a name with DEL",
      doc({ name: "a\u007f" }),
      "bad-name",
      "workspaces[0].name",
      "workspaces[0].name: 1 to 32 characters",
    ],
    [
      "a bad container",
      doc({ userContextId: 0 }),
      "invalid",
      "workspaces[0].userContextId",
      "workspaces[0].userContextId: a positive integer or null",
    ],
    [
      "a bad colour",
      doc({ color: "beige" }),
      "bad-color",
      "workspaces[0].color",
      'workspaces[0].color: unknown colour "beige"',
    ],
    [
      "a bad icon",
      doc({ icon: "boat" }),
      "bad-icon",
      "workspaces[0].icon",
      'workspaces[0].icon: unknown icon "boat"',
    ],
    [
      "a javascript: home",
      doc({ home: "javascript:alert(1)" }),
      "invalid",
      "workspaces[0].home",
      "workspaces[0].home: an http(s) or about: URL",
    ],
    [
      "a file: home",
      doc({ home: "file:///etc/passwd" }),
      "invalid",
      "workspaces[0].home",
      "workspaces[0].home: an http(s) or about: URL",
    ],
    [
      "a home in an array",
      doc({ home: ["https://example.com/"] }),
      "invalid",
      "workspaces[0].home",
      "workspaces[0].home: an http(s) or about: URL",
    ],
    [
      "a home that is not a string",
      doc({ home: 5 }),
      "invalid",
      "workspaces[0].home",
      "workspaces[0].home: an http(s) or about: URL",
    ],
    [
      "a bad source",
      doc({ source: "file" }),
      "invalid",
      "workspaces[0].source",
      'workspaces[0].source: "config" or "runtime"',
    ],
    [
      "a bad bookmarks folder",
      doc({ bookmarksFolder: "short" }),
      "invalid",
      "workspaces[0].bookmarksFolder",
      "workspaces[0].bookmarksFolder: a Places guid",
    ],
    [
      "an unknown lastActive",
      doc({}, { lastActive: "nope" }),
      "invalid",
      "lastActive",
      "lastActive: null or the id of a workspace",
    ],
  ] as Array<[string, unknown, string, string, string]>)("%s", (_, input, code, path, message) => {
    const e = defsError(() => readDefinitions(input));
    expect(e.name).toBe("DefinitionsError");
    expect(e.code).toBe(code);
    expect(e.path).toBe(path);
    expect(e.message).toBe(message);
  });

  test("text that is not JSON says so", () => {
    expect(defsError(() => readDefinitions("{")).message).toMatch(/^not JSON: ./);
  });

  test("a name of 32 characters, with spaces, reads; so does a workspace without home", () => {
    const d = readDefinitions(doc({ name: `${"n".repeat(30)} n` }));
    expect(d.workspaces[0]?.name).toHaveLength(32);
    expect(d.workspaces[0]).not.toHaveProperty("home");
    expect(d.workspaces[0]).not.toHaveProperty("bookmarksFolder");
    expect(d.lastActive).toBeNull();
  });
});

describe("workspace definitions: edges", () => {
  const rt = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    name: id,
    userContextId: null as number | null,
    color: "gray",
    icon: "circle",
    source: "runtime" as const,
    ...over,
  });
  const defsOf = (...workspaces: any[]) => ({
    schema: 1,
    lastActive: workspaces[0]?.id ?? null,
    workspaces,
  });

  test.each([
    ["color", { color: "red" }],
    ["icon", { icon: "cart" }],
    ["home", { home: "https://example.org/" }],
  ])("a reconcile that changes only the %s is a change", (_, looks) => {
    const before = reconcileDefinitions(emptyDefinitions(), [cfg("work")], minter()).definitions;
    const after = reconcileDefinitions(before, [cfg("work", looks)], minter());
    expect(after.changed).toBe(true);
    expect(after.definitions.workspaces[0]).toMatchObject(looks);
  });

  test("a reconcile that changes only lastActive or the schema is a change", () => {
    const d = defsOf(rt("a"));
    expect(reconcileDefinitions({ ...d, lastActive: "gone" }, [], minter())).toMatchObject({
      changed: true,
      definitions: { lastActive: "a" },
    });
    expect(reconcileDefinitions({ ...d, schema: 0 }, [], minter())).toMatchObject({
      changed: true,
      definitions: { schema: 1 },
    });
  });

  test("a config workspace removed from config.toml becomes a runtime one", () => {
    const before = reconcileDefinitions(emptyDefinitions(), [cfg("work")], minter()).definitions;
    const after = reconcileDefinitions(before, [], minter()).definitions;
    expect(after.workspaces[0]).toMatchObject({ name: "work", source: "runtime" });
  });

  test.each([
    ["colour", { color: "red" }],
    ["icon", { icon: "cart" }],
  ])("planContainers updates a container whose %s alone drifted", (_, drift) => {
    const d = defsOf(rt("a", { userContextId: 6, ...drift }));
    expect(
      planContainers(d as any, [{ userContextId: 6, name: "a", color: "gray", icon: "circle" }]),
    ).toEqual({ adopt: ["a"], update: ["a"], create: [] });
  });

  test("the same container, folder or lastActive returns the input; an unknown id is refused", () => {
    const d = defsOf(rt("a", { userContextId: 6 }), rt("b"));
    expect(withContainer(d as any, "a", 6)).toBe(d);
    expect(setLastActive(d as any, "a")).toBe(d);
    expect(defsError(() => setLastActive(d as any, "nope")).message).toBe('no workspace "nope"');
    expect(defsError(() => withBookmarksFolder(d as any, "a", "bad")).message).toBe(
      "bookmarksFolder: a Places guid",
    );
  });

  test("linking one workspace's folder leaves the others as they are", () => {
    const d = defsOf(rt("a"), rt("b"));
    const next = withBookmarksFolder(d as any, "b", "abcdefghijkl");
    expect(next.workspaces[0]).toBe(d.workspaces[0]);
    expect(next.workspaces[1]?.bookmarksFolder).toBe("abcdefghijkl");
  });

  test("addRuntimeWorkspace: refusals and what they say", () => {
    const d = defsOf(rt("a"));
    const add = (w: any, o?: any) => defsError(() => addRuntimeWorkspace(d as any, w, o));
    const w = { id: "b", name: "b", color: "gray", icon: "circle" };
    expect(add({ ...w, id: "a b" })).toMatchObject({
      code: "bad-id",
      path: "id",
      message: "id: not a valid id",
    });
    expect(add({ ...w, id: "a" })).toMatchObject({
      code: "duplicate-id",
      message: 'id: "a" exists',
    });
    expect(add({ ...w, name: "a" })).toMatchObject({
      code: "duplicate-name",
      message: 'name: "a" exists',
    });
    expect(add({ ...w, name: "" })).toMatchObject({ message: "name: 1 to 32 characters" });
    expect(add({ ...w, name: "2" })).toMatchObject({
      code: "bad-name",
      path: "name",
      message: 'name: "2" is only digits, which name a workspace by its place',
    });
    expect(add({ ...w, color: "beige" })).toMatchObject({ code: "bad-color", path: "color" });
  });

  test("addRuntimeWorkspace: a name ending in digits is fine; home only when given", () => {
    const d = defsOf(rt("a"));
    const w = { id: "b", name: "a2", color: "gray", icon: "circle" };
    expect(addRuntimeWorkspace(d as any, w).workspaces[1]).not.toHaveProperty("home");
    expect(
      addRuntimeWorkspace(d as any, { ...w, home: "https://example.org/" }).workspaces[1]?.home,
    ).toBe("https://example.org/");
  });

  test("addRuntimeWorkspace goes before the agent workspace only when it is last", () => {
    const w = { id: "n", name: "n", color: "gray", icon: "circle" };
    const ids = (d: any) => d.workspaces.map((x: any) => x.id);
    expect(
      ids(addRuntimeWorkspace(defsOf(rt("agent"), rt("a")) as any, w, { agent: "agent" })),
    ).toEqual(["agent", "a", "n"]);
    expect(ids(addRuntimeWorkspace(emptyDefinitions(), w, { agent: "agent" }))).toEqual(["n"]);
  });

  test("removal: what each refusal says; an inactive one keeps lastActive", () => {
    const config = { ...rt("c"), source: "config" as const };
    const d = { ...defsOf(rt("a"), rt("b"), config, rt("agent")), lastActive: "b" };
    expect(removeWorkspaceDefinition(d as any, "a").definitions.lastActive).toBe("b");
    expect(removeWorkspaceDefinition(d as any, "agent").definitions.lastActive).toBe("b");
    expect(
      defsError(() => removeWorkspaceDefinition(d as any, "agent", { agent: "agent" })).message,
    ).toBe('"agent" is the agent workspace; it is only emptied');
    expect(defsError(() => removeWorkspaceDefinition(d as any, "c")).message).toBe(
      '"c" is in config.toml',
    );
    expect(defsError(() => removeWorkspaceDefinition(defsOf(rt("a")) as any, "a")).message).toBe(
      "cannot delete the last workspace",
    );
  });

  test("rename: what each refusal says", () => {
    const config = { ...rt("c"), source: "config" as const };
    const d = defsOf(rt("a"), rt("b"), config);
    expect(defsError(() => renameWorkspaceDefinition(d as any, "c", "z")).message).toBe(
      '"c" is named in config.toml',
    );
    expect(defsError(() => renameWorkspaceDefinition(d as any, "a", "b")).message).toBe(
      'name: "b" exists',
    );
  });

  test("with every new colour taken, a new workspace's colour goes by count", () => {
    const colors = [
      "blue",
      "green",
      "orange",
      "purple",
      "red",
      "yellow",
      "pink",
      "cyan",
      "violet",
      "gray",
    ];
    const d = defsOf(...colors.map((color, i) => rt(`w${i}`, { color })));
    expect(newWorkspaceLooks(d as any)).toEqual({ color: "green", icon: "circle" });
  });
});
