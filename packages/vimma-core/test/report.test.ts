import { describe, expect, it } from "vitest";
import { describeOutcome, formatAge, redactReport, workspaceReport } from "../src/ui/report.mjs";
import { budget } from "./budget.ts";

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
    expect(performance.now() - start).toBeLessThan(budget(1000));
    expect(out).toBe("/home/alice/x");
    expect(redactReport("/home/alice/x", "/home/alice///")).toBe("~/x");
  });

  it("ends $HOME at a slash, the end, or a character that cannot continue a name", () => {
    expect(redactReport("/home/alice: no such file", "/home/alice")).toBe("~: no such file");
    expect(redactReport("(/home/alice)", "/home/alice")).toBe("(~)");
    expect(redactReport("/home/alice.bak /home/alice-2 /home/alice_x", "/home/alice")).toBe(
      "/home/alice.bak /home/alice-2 /home/alice_x",
    );
  });

  it("reads letters past ASCII as part of a name", () => {
    // /home/jos is not the home in /home/josé, and /home/josé is a whole home before a colon.
    expect(redactReport("/home/josé/notes.txt", "/home/jos")).toBe("/home/josé/notes.txt");
    expect(redactReport("/home/josé: denied, /home/josé/x", "/home/josé")).toBe("~: denied, ~/x");
    expect(redactReport("/home/ali/x", "/home/ali")).toBe("~/x");
    expect(redactReport("/é: denied", "/é")).toBe("~: denied");
    // A letter outside the Basic Multilingual Plane is one character, on either side.
    expect(redactReport("/home/a\u{1D49C}/x", "/home/a")).toBe("/home/a\u{1D49C}/x");
    expect(redactReport("/home/\u{1D49C}: denied", "/home/\u{1D49C}")).toBe("~: denied");
  });

  it("a home that ends in punctuation is whole before a slash, a space or the end", () => {
    expect(redactReport("/home/al-/x and /home/al-", "/home/al-")).toBe("~/x and ~");
    expect(redactReport("/home/al- x", "/home/al-")).toBe("~ x");
  });

  it("reads +, emoji, joiners and connector punctuation as part of a name (#1173)", () => {
    // Each is another user's home that starts with alice's: none of it is hers.
    for (const other of [
      "/home/alice+b/x",
      "/home/alice\u{1F600}/x",
      "/home/alice\u200Dx/x",
      "/home/alice\u{1F469}\u200D\u{1F4BB}/x",
      "/home/alice\u203Fb/x",
      "/home/alice\uFE4Fb/x",
      "/home/alice\u2040b/x",
      "/home/alice~b/x",
      "/home/alice@b/x",
      "/home/alice#b/x",
      "HOME=/home/alice|x",
      "/home/alice!x /home/alice=x /home/alice*x",
    ]) {
      expect(redactReport(other, "/home/alice")).toBe(other);
    }
    // And a home made of them is redacted whole.
    expect(redactReport("/home/a+\u{1F600}\u200D\u203F/x", "/home/a+\u{1F600}\u200D\u203F")).toBe(
      "~/x",
    );
  });

  it("ends a home at whitespace, a path separator or the punctuation that delimits a path", () => {
    const h = "/home/alice";
    for (const [text, want] of [
      ["/home/alice\\AppData", "~\\AppData"],
      ["/home/alice\tx", "~\tx"],
      ["/home/alice\u3000x", "~\u3000x"],
      ["\"/home/alice\" '/home/alice' `/home/alice`", "\"~\" '~' `~`"],
      ["[/home/alice] {/home/alice} </home/alice>", "[~] {~} <~>"],
      ["/home/alice; /home/alice, /home/alice:4", "~; ~, ~:4"],
      ["home is /home/alice. Or /home/alice? No, /home/alice!", "home is ~. Or ~? No, ~!"],
      ["/home/alice.", "~."],
      ["/home/alice... done, /home/alice?! ok", "~... done, ~?! ok"],
      [
        "/home/alice\u2026 \u201C/home/alice\u201D \u2018/home/alice\u2019",
        "~\u2026 \u201C~\u201D \u2018~\u2019",
      ],
      [
        "\u00AB/home/alice\u00BB \u300C/home/alice\u300D \u2039/home/alice\u203A",
        "\u00AB~\u00BB \u300C~\u300D \u2039~\u203A",
      ],
    ] as const) {
      expect(redactReport(text, h)).toBe(want);
    }
  });

  it("matches a home and a path in different Unicode normal forms (#1173)", () => {
    const nfc = "/home/jos\u00E9";
    const nfd = "/home/jose\u0301";
    // NFD $HOME (macOS) against an NFC path, and the reverse, keeping the rest of the text as is.
    expect(redactReport(`${nfc}/caf\u00E9: x`, nfd)).toBe("~/caf\u00E9: x");
    expect(redactReport(`${nfd}/cafe\u0301: x`, nfc)).toBe("~/cafe\u0301: x");
    // The accent at the start of the name as well as the end.
    expect(redactReport("/home/\u00C9mile/x", "/home/E\u0301mile")).toBe("~/x");
    expect(redactReport("/home/E\u0301mile/x", "/home/\u00C9mile")).toBe("~/x");
    // Text before the home in the other form stays in its own form.
    expect(redactReport(`\u00E9 e\u0301 ${nfd}/x`, nfc)).toBe("\u00E9 e\u0301 ~/x");
    // A home that is a prefix only before normalisation is still not the whole name.
    expect(redactReport(`${nfc}/x`, "/home/jose")).toBe(`${nfc}/x`);
    expect(redactReport(`${nfd}/x`, "/home/jose")).toBe(`${nfd}/x`);
    // What follows the home is read as written: U+037E (Greek question mark) is `;` only in NFD.
    expect(redactReport("/home/alice\u037Eb/x", "/home/alice")).toBe("/home/alice\u037Eb/x");
    // Hangul: a syllable and its jamo.
    expect(redactReport("/home/\uD55C/x", "/home/\u1112\u1161\u11AB")).toBe("~/x");
  });

  it("redacts a 3 MB report in linear time, in either normal form", () => {
    const line =
      "  error: /home/jos\u00E9/.config/vimma/c\u00F6nfig.toml:4: bad key (/home/alice+b/x)\n";
    const text = line.repeat(40_000);
    for (const home of ["/home/jos\u00E9", "/home/jose\u0301"]) {
      const start = performance.now();
      const out = redactReport(text, home);
      expect(performance.now() - start).toBeLessThan(budget(1000));
      expect(out).toBe(
        "  error: ~/.config/vimma/c\u00F6nfig.toml:4: bad key (/home/alice+b/x)\n".repeat(40_000),
      );
    }
  });

  it("stays linear on near misses and on one long run of non-ASCII text", () => {
    const cases: [string, string, string][] = [
      // A match on every line that the next character rules out.
      ["/home/jos\u00E9x".repeat(270_000), "/home/jos\u00E9", "/home/jos\u00E9x"],
      // A match on every line in the other normal form.
      ["/home/jose\u0301/".repeat(250_000), "/home/jos\u00E9", "~/"],
      // One 3 MB run that NFD changes, matched everywhere and ending nowhere.
      ["\uD55C".repeat(3_000_000), "\uD55C", "\uD55C"],
      ["\u00E9".repeat(3_000_000), "\u00E9\u00E9", "\u00E9"],
      // One 3 MB run whose only match ends a name.
      [`${"\u00E9".repeat(3_000_000)} \u00E9`, "\u00E9", "\u00E9"],
    ];
    for (const [text, home, unit] of cases) {
      const start = performance.now();
      const out = redactReport(text, home);
      expect(performance.now() - start).toBeLessThan(budget(1500));
      expect(out.startsWith(unit)).toBe(true);
    }
  });

  it("does not redact inside a home it has already replaced", () => {
    // The second /home/home starts inside the first one's match.
    expect(redactReport("/home/home/home/x", "/home/home")).toBe("~/home/x");
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

  it("names the kind when an action result has no action, or another kind carries one", () => {
    expect(describeOutcome({ kind: "action" })).toBe("action");
    expect(describeOutcome({ kind: "pass", action: { id: "scroll.down" } })).toBe("pass");
  });
});

describe("redactReport on a workspace error cut to length", () => {
  it("redacts a home the cut leaves right before its …", () => {
    // workspaceReport cuts a long error with … and the cut can fall right after the home.
    const error = `${"e".repeat(187)} /home/alice/.config/vimma/workspaces.json: bad`;
    const [, line] = workspaceReport({
      count: 1,
      window: [],
      live: 0,
      pendingMs: null,
      recovered: null,
      lastError: error,
    });
    expect(line).toMatch(/ \/home\/alice…$/);
    expect(redactReport(line ?? "", "/home/alice")).toBe(`  error: ${"e".repeat(187)} ~…`);
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
    expect(line?.startsWith("  error: a b")).toBe(true);
    expect(line?.length).toBeLessThanOrEqual(210);
    expect(line?.endsWith("…")).toBe(true);
  });

  it("says none for a window without workspaces, and leaves out an unknown tab count", () => {
    expect(workspaceReport({ ...base, window: [], live: null })).toEqual([
      "Workspaces: 2; this window: none",
    ]);
    expect(workspaceReport({ ...base, window: [], live: 3 })).toEqual([
      "Workspaces: 2; this window: none",
    ]);
    expect(workspaceReport({ ...base, live: null })).toEqual([
      "Workspaces: 2; this window: main 1t/1p, agent 0t/1p",
    ]);
  });

  it("flattens an error's white space and keeps one of 200 characters whole", () => {
    expect(workspaceReport({ ...base, lastError: "  a \n\t b  " })[1]).toBe("  error: a b");
    const exact = "x".repeat(200);
    expect(workspaceReport({ ...base, lastError: exact })[1]).toBe(`  error: ${exact}`);
    expect(workspaceReport({ ...base, lastError: `${exact}y` })[1]).toBe(
      `  error: ${"x".repeat(199)}…`,
    );
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
