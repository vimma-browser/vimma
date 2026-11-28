// docs/specs/temporary-containers.md: the pure rules of temporary containers (decision 11).
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { readDefinitions } from "../src/workspaces/workspacedefs.mjs";
import { THEME_TOKENS } from "../src/config/theme.mjs";
import { WORKSPACE_COLOR_TOKENS } from "../src/ui/statusbar.mjs";
import { PRIVATE_COLOR_TOKEN } from "../src/workspaces/privatews.mjs";
import {
  TEMPORARY_COLOR_TOKEN,
  TEMPORARY_GLYPH,
  TEMPORARY_LOOKS,
  TEMPORARY_REFUSALS,
  canRemoveTemporary,
  numberTemporary,
  planTemporaryCleanup,
  readTemporaryRecords,
  temporaryCountText,
  temporaryMarker,
  temporaryName,
  temporaryRefusal,
  temporarySplit,
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

describe("temporarySplit (behaviour 2, decision 9)", () => {
  test("vsplit and vs split right, split and sp split down", () => {
    expect(temporarySplit("vsplit")).toBe("vertical");
    expect(temporarySplit("vs")).toBe("vertical");
    expect(temporarySplit("split")).toBe("horizontal");
    expect(temporarySplit(" sp ")).toBe("horizontal");
  });

  test("anything else is a page to open, not a split", () => {
    for (const text of ["", "example.com", "vsplit example.com", "VSPLIT", "spl", "splits"]) {
      expect(temporarySplit(text)).toBeNull();
    }
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

describe("markers (decision 16)", () => {
  test("text that does not lean on colour: tmp1 in the lists, ◇ tmp1 in the bar's glyph", () => {
    expect(temporaryMarker(1)).toBe("tmp1");
    expect(temporaryMarker(12)).toBe("tmp12");
    expect(TEMPORARY_GLYPH).toBe("◇");
  });

  test("the picker's count says how many tabs are temporary", () => {
    expect(temporaryCountText(1)).toBe("1 temporary");
    expect(temporaryCountText(2)).toBe("2 temporary");
  });

  test("a theme colour no workspace marker uses", () => {
    expect(THEME_TOKENS.some((t) => t.name === TEMPORARY_COLOR_TOKEN)).toBe(true);
    expect(Object.values(WORKSPACE_COLOR_TOKENS)).not.toContain(TEMPORARY_COLOR_TOKEN);
    expect([PRIVATE_COLOR_TOKEN, "--vimma-text-accent"]).not.toContain(TEMPORARY_COLOR_TOKEN);
  });
});

describe("numberTemporary (decision 16)", () => {
  test("numbers count up from 1, in the order the containers were made", () => {
    const n = numberTemporary(new Map(), [31, 30]);
    expect([...n]).toEqual([
      [30, 1],
      [31, 2],
    ]);
  });

  test("a number stays with its container while it is open", () => {
    const first = numberTemporary(new Map(), [30, 31]);
    const next = numberTemporary(first, [31, 32]);
    expect(next.get(31)).toBe(2);
    expect(next.has(30)).toBe(false);
  });

  test("a number is not reused while its container is open; a closed one's is free again", () => {
    const n = numberTemporary(new Map([[31, 2]]), [31, 40, 41]);
    expect([...n].sort((a, b) => a[0] - b[0])).toEqual([
      [31, 2],
      [40, 1],
      [41, 3],
    ]);
  });

  test("the same map back when nothing changed, so a caller can tell", () => {
    const n = numberTemporary(new Map(), [30]);
    expect(numberTemporary(n, [30])).toBe(n);
  });
});
