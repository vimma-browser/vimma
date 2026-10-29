import { describe, expect, it } from "vitest";
import { describeOutcome, formatAge, redactReport, workspaceReport } from "../src/report.mjs";

describe("redactReport", () => {
  const home = "/home/alice";

  it("turns paths under $HOME into ~", () => {
    expect(redactReport("config: /home/alice/.config/vimma/config.toml:4: x", home)).toBe(
      "config: ~/.config/vimma/config.toml:4: x",
    );
    expect(redactReport("home is /home/alice", home)).toBe("home is ~");
  });

  it("leaves other paths and look-alike prefixes alone", () => {
    expect(redactReport("/home/alicebob/x and /etc/vimma", home)).toBe(
      "/home/alicebob/x and /etc/vimma",
    );
  });

  it("drops URLs, whatever the scheme", () => {
    expect(redactReport("at https://example.com/secret?q=1 and file:///tmp/x.", home)).toBe(
      "at <url> and <url>.",
    );
    expect(redactReport("moz-extension://abc/page", home)).toBe("<url>");
  });

  it("keeps about: pages and plain words", () => {
    expect(redactReport("about:vimma report, mode: normal", home)).toBe(
      "about:vimma report, mode: normal",
    );
  });

  it("strips a home's trailing slashes in linear time (CodeQL js/polynomial-redos)", () => {
    const start = performance.now();
    const out = redactReport("/home/alice/x", `/${"/".repeat(200_000)}x`);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(out).toBe("/home/alice/x");
    expect(redactReport("/home/alice/x", "/home/alice///")).toBe("~/x");
  });

  it("does nothing special without a home", () => {
    expect(redactReport("/home/alice/x", "")).toBe("/home/alice/x");
  });
});

describe("describeOutcome", () => {
  it("names the action, or pass, cancel, pending", () => {
    expect(describeOutcome({ kind: "action", action: { id: "scroll.down" } })).toBe("scroll.down");
    expect(describeOutcome({ kind: "pass" })).toBe("pass");
    expect(describeOutcome({ kind: "cancel" })).toBe("cancel");
    expect(describeOutcome({ kind: "pending" })).toBe("…");
  });
});

describe("workspaceReport", () => {
  const window = [
    { name: "main", tabs: 1, panes: 1 },
    { name: "agent", tabs: 0, panes: 1 },
  ];
  const base = { count: 2, window, live: 1, pendingMs: null, recovered: null, lastError: null };

  it("lists the window's workspaces with the open tab count beside the model's", () => {
    expect(workspaceReport(base)).toEqual([
      "Workspaces: 2; this window: main 1t/1p, agent 0t/1p; open tabs 1, in workspaces 1",
    ]);
  });

  it("says when the model is out of step with the open tabs (issue #546)", () => {
    expect(workspaceReport({ ...base, live: 11 })[0]).toBe(
      "Workspaces: 2; this window: main 1t/1p, agent 0t/1p; open tabs 11, in workspaces 1" +
        " (out of step)",
    );
  });

  it("names a restore the window still waits for, and for how long", () => {
    expect(workspaceReport({ ...base, pendingMs: 3 * 3600e3 + 12 * 60e3 })[1]).toBe(
      "  restore pending: 3h 12m (SessionStore has not said it finished)",
    );
  });

  it("names a recovered restore and the last rebuild error", () => {
    const lines = workspaceReport({
      ...base,
      recovered: { reason: "timeout", afterMs: 5000, agoMs: 90e3 },
      lastError: "TypeError: x is undefined",
    });
    expect(lines.slice(1)).toEqual([
      "  recovered: a restore that never finished (timeout), rebuilt after 5s, 1m 30s ago",
      "  error: TypeError: x is undefined",
    ]);
  });

  it("keeps a long error to one short line", () => {
    const line = workspaceReport({ ...base, lastError: `a\n${"b".repeat(500)}` })[1];
    expect(line.startsWith("  error: a b")).toBe(true);
    expect(line.length).toBeLessThanOrEqual(210);
    expect(line.endsWith("…")).toBe(true);
  });

  it("says none for a window without workspaces, and leaves out an unknown tab count", () => {
    expect(workspaceReport({ ...base, window: [], live: null })).toEqual([
      "Workspaces: 2; this window: none",
    ]);
  });
});

describe("formatAge", () => {
  it("rounds to the two largest units", () => {
    expect(formatAge(0)).toBe("0s");
    expect(formatAge(4999)).toBe("4s");
    expect(formatAge(90e3)).toBe("1m 30s");
    expect(formatAge(3600e3)).toBe("1h");
    expect(formatAge(3 * 3600e3 + 12 * 60e3 + 5e3)).toBe("3h 12m");
    expect(formatAge(26 * 3600e3)).toBe("1d 2h");
  });
});
