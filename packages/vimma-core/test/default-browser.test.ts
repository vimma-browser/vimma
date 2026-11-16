// #855: on Omarchy, GIO answers "which app opens http links" from hyprland-mimeapps.list, which
// names Omarchy's router, omarchy-browser.desktop; the router then opens the browser that
// mimeapps.list names. Vimma counts itself the default when that browser is its own entry.
import { describe, expect, test } from "vitest";
import {
  OMARCHY_ROUTER,
  commandProgram,
  dataDirs,
  defaultHandlers,
  desktopEntryExec,
  handlersRun,
  isDefaultThroughRouter,
  mimeappsLists,
  routedBrowser,
} from "../src/system/default-browser.mjs";
import { budget } from "./budget.mjs";

const OWN = "/opt/vimma/vimma-open";

const HYPRLAND_LIST = [
  "# Route links through omarchy-launch-browser",
  "[Default Applications]",
  "x-scheme-handler/http=omarchy-browser.desktop",
  "x-scheme-handler/https=omarchy-browser.desktop",
  "",
].join("\n");

const plainList = (id: string) =>
  [
    "[Added Associations]",
    "x-scheme-handler/http=firefox.desktop;",
    "",
    "[Default Applications]",
    `text/html=${id}`,
    `x-scheme-handler/http=${id}`,
    `x-scheme-handler/https=${id}`,
    "",
  ].join("\n");

describe("mimeappsLists", () => {
  test("reads each config dir's desktop-specific lists before its mimeapps.list, as Omarchy does", () => {
    expect(
      mimeappsLists({
        home: "/home/u",
        configHome: "",
        configDirs: "",
        currentDesktop: "Hyprland",
      }),
    ).toEqual([
      "/home/u/.config/hyprland-mimeapps.list",
      "/home/u/.config/mimeapps.list",
      "/etc/xdg/hyprland-mimeapps.list",
      "/etc/xdg/mimeapps.list",
    ]);
  });

  test("takes XDG_CONFIG_HOME and XDG_CONFIG_DIRS when set, and every listed desktop", () => {
    expect(
      mimeappsLists({
        home: "/home/u",
        configHome: "/tmp/c",
        configDirs: "/etc/a:/etc/b",
        currentDesktop: "Hyprland:wlroots",
      }),
    ).toEqual([
      "/tmp/c/hyprland-mimeapps.list",
      "/tmp/c/wlroots-mimeapps.list",
      "/tmp/c/mimeapps.list",
      "/etc/a/hyprland-mimeapps.list",
      "/etc/a/wlroots-mimeapps.list",
      "/etc/a/mimeapps.list",
      "/etc/b/hyprland-mimeapps.list",
      "/etc/b/wlroots-mimeapps.list",
      "/etc/b/mimeapps.list",
    ]);
  });

  test("skips relative dirs, which the XDG spec says to ignore, and desktop names that are not plain words", () => {
    expect(
      mimeappsLists({
        home: "",
        configHome: "relative",
        configDirs: "also/relative:/etc/xdg",
        currentDesktop: "../../x:GNOME",
      }),
    ).toEqual(["/etc/xdg/gnome-mimeapps.list", "/etc/xdg/mimeapps.list"]);
  });
});

describe("trailing slashes", () => {
  test("are trimmed in linear time, however many an environment value has", () => {
    const slashes = "/".repeat(200_000);
    const start = performance.now();
    const lists = mimeappsLists({
      home: `/a${slashes}x${slashes}`,
      configHome: "",
      configDirs: `/b${slashes}y${slashes}`,
      currentDesktop: "",
    });
    const dirs = dataDirs({ home: `/a${slashes}x${slashes}`, dataHome: "", dataDirs: "/" });
    expect(performance.now() - start).toBeLessThan(budget(500));
    expect(lists[0]?.endsWith("x/.config/mimeapps.list")).toBe(true);
    expect(lists[1]?.endsWith("y/mimeapps.list")).toBe(true);
    expect(dirs[0]?.endsWith("x/.local/share")).toBe(true);
    expect(dirs[1]).toBe("/");
  });
});

describe("defaultHandlers", () => {
  test("lists the entries of the first matching line in [Default Applications] only", () => {
    expect(defaultHandlers(plainList("vimma-vimma.desktop"), "x-scheme-handler/http")).toEqual([
      "vimma-vimma.desktop",
    ]);
    expect(
      defaultHandlers(
        "[Default Applications]\nx-scheme-handler/http=a.desktop;b.desktop;\nx-scheme-handler/http=c.desktop\n",
        "x-scheme-handler/http",
      ),
    ).toEqual(["a.desktop", "b.desktop"]);
  });

  test("reads a line only as Omarchy's launcher does: the key at column 1, no spaces", () => {
    for (const line of [
      "x-scheme-handler/http = vimma-vimma.desktop",
      " x-scheme-handler/http=vimma-vimma.desktop",
    ]) {
      expect(defaultHandlers(`[Default Applications]\n${line}\n`, "x-scheme-handler/http")).toEqual(
        [],
      );
    }
    expect(
      defaultHandlers(
        "[Default Applications]\nx-scheme-handler/http= vimma-vimma.desktop\n",
        "x-scheme-handler/http",
      ),
    ).toEqual([" vimma-vimma.desktop"]);
  });

  test("ignores comments, other sections and other types", () => {
    const text =
      "[Added Associations]\nx-scheme-handler/http=a.desktop\n[Default Applications]\n#x-scheme-handler/http=b.desktop\nx-scheme-handler/https=c.desktop\n";
    expect(defaultHandlers(text, "x-scheme-handler/http")).toEqual([]);
    expect(defaultHandlers(null, "x-scheme-handler/http")).toEqual([]);
  });
});

describe("routedBrowser", () => {
  const installed = (id: string) => id !== "gone.desktop";

  test("skips Omarchy's router and takes the browser mimeapps.list names", () => {
    expect(
      routedBrowser(
        [HYPRLAND_LIST, plainList("vimma-vimma.desktop")],
        "x-scheme-handler/http",
        installed,
      ),
    ).toBe("vimma-vimma.desktop");
  });

  test("skips an entry that is no longer installed, as Omarchy's launcher does", () => {
    const text =
      "[Default Applications]\nx-scheme-handler/http=gone.desktop;omarchy-browser.desktop;firefox.desktop\n";
    expect(routedBrowser([HYPRLAND_LIST, text], "x-scheme-handler/http", installed)).toBe(
      "firefox.desktop",
    );
  });

  test("returns null when nothing past the router is listed", () => {
    expect(routedBrowser([HYPRLAND_LIST, null], "x-scheme-handler/http", installed)).toBeNull();
  });
});

describe("commandProgram", () => {
  test("takes the command line up to its first space, as Omarchy's launcher does", () => {
    expect(commandProgram("/opt/vimma/vimma-open %u")).toBe(OWN);
    expect(commandProgram("vimma-open")).toBe("vimma-open");
  });

  test("keeps quotes and tabs, so a quoted program never matches", () => {
    expect(commandProgram('"/opt/vimma/vimma-open" %u')).toBe('"/opt/vimma/vimma-open"');
    expect(commandProgram(`${OWN}\t%u`)).toBe(`${OWN}\t%u`);
    expect(commandProgram("")).toBe("");
  });
});

describe("dataDirs", () => {
  test("XDG_DATA_HOME then XDG_DATA_DIRS, with the spec's defaults, absolute only", () => {
    expect(dataDirs({ home: "/home/u", dataHome: "", dataDirs: "" })).toEqual([
      "/home/u/.local/share",
      "/usr/local/share",
      "/usr/share",
    ]);
    expect(dataDirs({ home: "/home/u", dataHome: "/d", dataDirs: "rel:/s/" })).toEqual([
      "/d",
      "/s",
    ]);
  });
});

describe("desktopEntryExec", () => {
  test("takes the first Exec= line, as Omarchy's launcher does", () => {
    const text = [
      "[Desktop Entry]",
      "Name=Vimma",
      `Exec=${OWN} %u`,
      "",
      "[Desktop Action new-window]",
      "Exec=/usr/bin/other --new-window",
    ].join("\n");
    expect(desktopEntryExec(text)).toBe(`${OWN} %u`);
    expect(desktopEntryExec(null)).toBeNull();
    expect(desktopEntryExec("")).toBeNull();
  });

  test("never reads an indented or spaced Exec, which Omarchy's sed skips", () => {
    expect(desktopEntryExec(`[Desktop Entry]\n Exec=${OWN} %u\n`)).toBeNull();
    expect(desktopEntryExec(`[Desktop Entry]\nExec = ${OWN} %u\n`)).toBeNull();
  });
});

describe("isDefaultThroughRouter", () => {
  const entries: Record<string, string> = {
    "vimma-vimma.desktop": `[Desktop Entry]\nExec=${OWN} %u\n`,
    "firefox.desktop": "[Desktop Entry]\nExec=/usr/lib/firefox/firefox %u\n",
    "gone.desktop": "[Desktop Entry]\nExec=/opt/gone/gone %u\n",
    "path.desktop": "[Desktop Entry]\nExec=firefox %u\n",
  };
  const onDisk = new Set([OWN, "/usr/lib/firefox/firefox", "/usr/bin/firefox"]);

  const check = (over: Partial<Parameters<typeof isDefaultThroughRouter>[0]> = {}) =>
    isDefaultThroughRouter({
      defaultFor: () => OMARCHY_ROUTER,
      lists: [HYPRLAND_LIST, plainList("vimma-vimma.desktop")],
      entryFor: (id) => entries[id] ?? null,
      resolves: (program) => onDisk.has(program) || program === "firefox",
      appPath: OWN,
      ...over,
    });

  test("is true when Omarchy's router handles both schemes and routes them to Vimma's own entry", () => {
    expect(check()).toBe(true);
  });

  test("is false when the routed browser is another one", () => {
    expect(check({ lists: [HYPRLAND_LIST, plainList("firefox.desktop")] })).toBe(false);
    expect(check({ lists: [HYPRLAND_LIST, plainList("path.desktop")] })).toBe(false);
  });

  test("skips an entry whose program is gone, as Omarchy's launcher does", () => {
    const text = `[Default Applications]\nx-scheme-handler/http=gone.desktop;vimma-vimma.desktop\nx-scheme-handler/https=missing.desktop;vimma-vimma.desktop\n`;
    expect(check({ lists: [HYPRLAND_LIST, text] })).toBe(true);
  });

  test("is false when GIO's handler is not Omarchy's router", () => {
    expect(check({ defaultFor: () => "firefox.desktop" })).toBe(false);
    expect(check({ defaultFor: (s) => (s === "https" ? "firefox.desktop" : OMARCHY_ROUTER) })).toBe(
      false,
    );
  });

  test("is false when one scheme routes elsewhere", () => {
    const mixed =
      "[Default Applications]\nx-scheme-handler/http=vimma-vimma.desktop\nx-scheme-handler/https=firefox.desktop\n";
    expect(check({ lists: [HYPRLAND_LIST, mixed] })).toBe(false);
  });

  test("matches the program by its exact absolute path, never by name or a relative one", () => {
    const exec = (line: string) => () => `[Desktop Entry]\nExec=${line}\n`;
    expect(check({ entryFor: exec("vimma-open %u"), appPath: "vimma-open" })).toBe(false);
    expect(check({ entryFor: exec("/usr/bin/vimma-open %u") })).toBe(false);
    expect(check({ entryFor: exec(`${OWN}x %u`), resolves: () => true })).toBe(false);
    expect(check({ appPath: "" })).toBe(false);
  });

  test("a quoted Exec never counts, since Omarchy's launcher cannot run it", () => {
    expect(
      check({ entryFor: () => `[Desktop Entry]\nExec="${OWN}" %u\n`, resolves: () => true }),
    ).toBe(false);
  });

  test("is false when Vimma's entry or its program is missing", () => {
    expect(check({ entryFor: () => null })).toBe(false);
    expect(check({ resolves: () => false })).toBe(false);
  });

  test("never looks up an entry id that is not a plain file name", () => {
    const asked: string[] = [];
    const text = `[Default Applications]\nx-scheme-handler/http=../../x.desktop;vimma-vimma.desktop\nx-scheme-handler/https=vimma-vimma.desktop\n`;
    expect(
      check({
        lists: [HYPRLAND_LIST, text],
        entryFor: (id) => (asked.push(id), entries[id] ?? null),
      }),
    ).toBe(true);
    expect(asked).not.toContain("../../x.desktop");
  });
});

// #855: when something started Firefox's shell service before Vimma could name vimma-open as its
// command (a dedicated profile made at startup, `vimma -setDefaultBrowser`), the service compares
// GIO's handlers with the binary, so the package's own entry never counted as the default.
describe("handlersRun", () => {
  /** `found`: where `which` finds each program. */
  const which = (found: Record<string, string>) => (program: string) => found[program] ?? "";
  const both = (command: string) => () => command;

  test("says yes when GIO's http and https handlers both run the command", () => {
    expect(
      handlersRun({ commandFor: both(`${OWN} %u`), which: which({ [OWN]: OWN }), appPath: OWN }),
    ).toBe(true);
    expect(
      handlersRun({
        commandFor: both("vimma-open %u"),
        which: which({ "vimma-open": OWN }),
        appPath: OWN,
      }),
    ).toBe(true);
  });

  test("says no when one scheme has another handler, or none", () => {
    const commands = {
      http: `${OWN} %u`,
      https: "/usr/lib/firefox/firefox %u",
    } as Record<string, string>;
    const found = which({ [OWN]: OWN, "/usr/lib/firefox/firefox": "/usr/lib/firefox/firefox" });
    expect(handlersRun({ commandFor: (s) => commands[s] ?? "", which: found, appPath: OWN })).toBe(
      false,
    );
    expect(handlersRun({ commandFor: () => "", which: found, appPath: OWN })).toBe(false);
  });

  test("says no for a program that resolves elsewhere, or not at all", () => {
    expect(handlersRun({ commandFor: both("vimma-open %u"), which: which({}), appPath: OWN })).toBe(
      false,
    );
    expect(
      handlersRun({
        commandFor: both("vimma-open %u"),
        which: which({ "vimma-open": "/home/u/bin/vimma-open" }),
        appPath: OWN,
      }),
    ).toBe(false);
  });

  test("never counts a quoted or escaped program, which it does not parse", () => {
    for (const command of [`"${OWN}" %u`, `'${OWN}' %u`, "/opt/vimma\\ x/vimma-open %u"]) {
      expect(
        handlersRun({ commandFor: both(command), which: (p) => p, appPath: OWN }),
        command,
      ).toBe(false);
    }
  });

  test("needs an absolute command to compare with", () => {
    expect(handlersRun({ commandFor: both("vimma-open %u"), which: (p) => p, appPath: "" })).toBe(
      false,
    );
    expect(
      handlersRun({ commandFor: both("vimma-open %u"), which: (p) => p, appPath: "vimma-open" }),
    ).toBe(false);
  });
});
