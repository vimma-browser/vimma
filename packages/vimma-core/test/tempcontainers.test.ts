// docs/specs/temporary-containers.md: the pure rules of temporary containers (decision 11).
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { readDefinitions } from "../src/workspaces/workspacedefs.mjs";
import {
  TEMPORARY_LOOKS,
  TEMPORARY_REFUSALS,
  canRemoveTemporary,
  planTemporaryCleanup,
  readTemporaryRecords,
  temporaryName,
  temporaryRefusal,
  temporaryWorkspaceOf,
  withTemporary,
  withoutTemporary,
} from "../src/workspaces/tempcontainers.mjs";

import type { TemporaryRecord } from "../src/workspaces/tempcontainers.mjs";

const NAME = temporaryName("0123abcd");
const rec = (userContextId: number, workspace = "ws-a", name = NAME): TemporaryRecord => ({
  userContextId,
  name,
  workspace,
});

describe("temporaryName", () => {
  test("names a container as Vimma's temporary one, with its token", () => {
    expect(NAME).toBe("vimma temporary 0123abcd");
  });

  test("refuses a token that is not lower-case hex, so a name never carries other text", () => {
    expect(() => temporaryName("ABC")).toThrow();
    expect(() => temporaryName("")).toThrow();
    expect(() => temporaryName("12 34")).toThrow();
  });

  test("its looks are a Firefox colour and icon", () => {
    expect(TEMPORARY_LOOKS).toEqual({ color: "toolbar", icon: "fence" });
  });
});

describe("temporaryRefusal (behaviour 8)", () => {
  test("no temporary container in the agent workspace", () => {
    expect(temporaryRefusal({ privateWindow: false, agentWorkspace: true })).toBe(
      "agent-workspace",
    );
    expect(TEMPORARY_REFUSALS["agent-workspace"]).toBe(
      "no temporary containers in the agent workspace",
    );
  });

  test("none in the private workspace, which is discarded on close already", () => {
    expect(temporaryRefusal({ privateWindow: true, agentWorkspace: false })).toBe(
      "private-workspace",
    );
    expect(TEMPORARY_REFUSALS["private-workspace"]).toBe(
      "the private workspace is discarded when it closes already",
    );
  });

  test("any other workspace may open one", () => {
    expect(temporaryRefusal({ privateWindow: false, agentWorkspace: false })).toBeNull();
  });

  test("moving a temporary tab is refused with its own text (behaviour 7)", () => {
    expect(TEMPORARY_REFUSALS["move-temporary"]).toBe(
      "a temporary tab stays in its workspace: open it again with :tmp there",
    );
  });
});

describe("the container map (decision 3)", () => {
  test("a temporary container's tab belongs to the workspace it was opened in", () => {
    const records = withTemporary(withTemporary([], rec(30, "ws-a")), rec(31, "ws-b"));
    expect(temporaryWorkspaceOf(records, 30)).toBe("ws-a");
    expect(temporaryWorkspaceOf(records, 31)).toBe("ws-b");
  });

  test("a container that is not a recorded temporary one belongs to no workspace here", () => {
    const records = withTemporary([], rec(30));
    expect(temporaryWorkspaceOf(records, 7)).toBeUndefined();
    expect(temporaryWorkspaceOf(records, 0)).toBeUndefined();
  });

  test("adding a recorded id replaces it; removing forgets it; neither changes its input", () => {
    const one = withTemporary([], rec(30, "ws-a"));
    const two = withTemporary(one, rec(30, "ws-b"));
    expect(two).toEqual([rec(30, "ws-b")]);
    expect(one).toEqual([rec(30, "ws-a")]);
    expect(withoutTemporary(two, 30)).toEqual([]);
    expect(withoutTemporary(two, 99)).toBe(two);
  });
});

describe("readTemporaryRecords (decision 5)", () => {
  test("reads the ids and names recorded in vimma-workspaces.json", () => {
    const file = {
      schema: 1,
      lastActive: null,
      workspaces: [],
      temporary: [{ userContextId: 30, name: NAME }],
    };
    expect(readTemporaryRecords(file)).toEqual([{ userContextId: 30, name: NAME }]);
  });

  test("the schema 1 contract fixture: an older Vimma reads the workspaces and skips them", () => {
    const text = readFileSync(
      new URL("../../../tests/contract/workspaces/v1/valid-temporary.json", import.meta.url),
      "utf8",
    );
    const file = JSON.parse(text);
    expect(readTemporaryRecords(file)).toEqual(file.temporary);
    const definitions = { ...file };
    delete definitions.temporary;
    expect(readDefinitions(text)).toEqual(definitions);
  });

  test("a file without them, or not an object, records none", () => {
    expect(readTemporaryRecords({ schema: 1, workspaces: [] })).toEqual([]);
    expect(readTemporaryRecords(null)).toEqual([]);
    expect(readTemporaryRecords("text")).toEqual([]);
    expect(readTemporaryRecords({ temporary: "x" })).toEqual([]);
  });

  test("drops an entry that is not a positive id with one of Vimma's temporary names", () => {
    const file = {
      temporary: [
        { userContextId: 0, name: NAME },
        { userContextId: -3, name: NAME },
        { userContextId: 1.5, name: NAME },
        { userContextId: "31", name: NAME },
        { userContextId: 32, name: "work" },
        { userContextId: 33 },
        null,
        { userContextId: 34, name: NAME },
      ],
    };
    expect(readTemporaryRecords(file)).toEqual([{ userContextId: 34, name: NAME }]);
  });
});

describe("canRemoveTemporary: only Vimma's own temporary containers are ever deleted", () => {
  const identity = { userContextId: 30, name: NAME, color: "toolbar", icon: "fence" };

  test("a recorded container that still has its name may be deleted", () => {
    expect(canRemoveTemporary({ userContextId: 30, name: NAME }, identity, [])).toBe(true);
  });

  test("a renamed or reused one keeps its data", () => {
    expect(
      canRemoveTemporary({ userContextId: 30, name: NAME }, { ...identity, name: "bank" }, []),
    ).toBe(false);
    expect(
      canRemoveTemporary(
        { userContextId: 30, name: NAME },
        { ...identity, name: temporaryName("ffff0000") },
        [],
      ),
    ).toBe(false);
  });

  test("a container gone already has nothing to delete", () => {
    expect(canRemoveTemporary({ userContextId: 30, name: NAME }, undefined, [])).toBe(false);
  });

  test("a workspace's container never is, whatever its name", () => {
    expect(canRemoveTemporary({ userContextId: 30, name: NAME }, identity, [30])).toBe(false);
  });

  test("never 0, the default container, nor an identity of another id", () => {
    expect(
      canRemoveTemporary({ userContextId: 0, name: NAME }, { ...identity, userContextId: 0 }, []),
    ).toBe(false);
    expect(
      canRemoveTemporary({ userContextId: 30, name: NAME }, { ...identity, userContextId: 31 }, []),
    ).toBe(false);
  });

  test("a record whose name is not one Vimma gives never is", () => {
    const named = { ...identity, name: "work" };
    expect(canRemoveTemporary({ userContextId: 30, name: "work" }, named, [])).toBe(false);
  });
});

describe("planTemporaryCleanup (decisions 5 and 18)", () => {
  const live = [
    { userContextId: 30, name: NAME, color: "toolbar", icon: "fence" },
    { userContextId: 31, name: "renamed", color: "toolbar", icon: "fence" },
    { userContextId: 40, name: "work", color: "blue", icon: "briefcase" },
  ];

  test("deletes only recorded ids whose identity still has Vimma's name", () => {
    const records = [
      { userContextId: 30, name: NAME },
      { userContextId: 31, name: temporaryName("aa") },
      { userContextId: 32, name: temporaryName("bb") },
    ];
    expect(planTemporaryCleanup(records, live, [40])).toEqual({ remove: [30], kept: [31] });
  });

  test("never a workspace's container, even recorded under its own name", () => {
    const reused = [{ userContextId: 40, name: NAME, color: "blue", icon: "briefcase" }];
    expect(planTemporaryCleanup([{ userContextId: 40, name: NAME }], reused, [40])).toEqual({
      remove: [],
      kept: [40],
    });
  });

  test("nothing recorded, nothing deleted", () => {
    expect(planTemporaryCleanup([], live, [40])).toEqual({ remove: [], kept: [] });
  });
});
