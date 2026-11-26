// docs/specs/builtin-agent-cli.md C4 (Since changed, issue #1518): on macOS, setup searches the
// login shell's PATH, which an app started from the Dock, Finder or `open` does not get, and the
// CLI runs with it. The output below is what a zsh whose .zshrc prints a banner gave, cut short.
import { describe, expect, test } from "vitest";
import {
  LOGIN_PATH_LIMIT,
  MAC_FOLDERS,
  launchdPath,
  loginPathArgs,
  loginPathFrom,
  searchFolders,
} from "../src/agent/agent-cli.mjs";

const MARK = "5f0c1e9a7b3d2468ace0";

describe("the login shell's PATH (macOS)", () => {
  test("the shell prints PATH between two marks, with no shell syntax of its own", () => {
    expect(loginPathArgs(MARK)).toEqual([
      "-l",
      "-i",
      "-c",
      `echo ${MARK}; /usr/bin/printenv PATH; echo ${MARK}`,
    ]);
  });

  test("a mark that is not plain hex is refused, since it goes into a command line", () => {
    expect(() => loginPathArgs("a; rm -rf ~")).toThrow();
    expect(() => loginPathArgs("")).toThrow();
    expect(() => loginPathArgs("abc")).toThrow();
  });

  test("what an rc file prints around it is ignored", () => {
    const out =
      "\u001b[40m   \u001b[m  OS: macOS 27.2.1\nzoxide: detected a possible issue\n" +
      `${MARK}\n/Users/u/.local/bin:/opt/homebrew/bin:/usr/bin:/bin\n${MARK}\n`;
    expect(loginPathFrom(out, MARK)).toEqual([
      "/Users/u/.local/bin",
      "/opt/homebrew/bin",
      "/usr/bin",
      "/bin",
    ]);
  });

  test("relative and empty entries are dropped, as setup never searches them", () => {
    expect(loginPathFrom(`${MARK}\n.:bin::/usr/bin:~/x\n${MARK}\n`, MARK)).toEqual(["/usr/bin"]);
  });

  test("no answer when a mark is missing, the line is broken or too long, or holds nothing", () => {
    expect(loginPathFrom(`/usr/bin\n${MARK}\n`, MARK)).toBeNull();
    expect(loginPathFrom(`${MARK}\n/usr/bin\n`, MARK)).toBeNull();
    expect(loginPathFrom("", MARK)).toBeNull();
    expect(loginPathFrom(`${MARK}\n/usr/bin\n/bin\n${MARK}\n`, MARK)).toBeNull();
    expect(loginPathFrom(`${MARK}\n/usr/bin\u0007:/bin\n${MARK}\n`, MARK)).toBeNull();
    expect(loginPathFrom(`${MARK}\n${"/x".repeat(LOGIN_PATH_LIMIT)}\n${MARK}\n`, MARK)).toBeNull();
    expect(loginPathFrom(`${MARK}\nrelative:only\n${MARK}\n`, MARK)).toBeNull();
    expect(loginPathFrom(`${MARK}\n\n${MARK}\n`, MARK)).toBeNull();
  });

  test("a mark the rc file printed itself does not start the answer", () => {
    // The shell's own echo is the last pair; a stray one before it is noise.
    const out = `${MARK}\nnoise\n${MARK}\n/usr/bin:/bin\n${MARK}\n`;
    expect(loginPathFrom(out, MARK)).toEqual(["/usr/bin", "/bin"]);
  });
});

describe("when the login shell is asked (macOS)", () => {
  test("only when Vimma's PATH is launchd's, as an app the Dock starts gets", () => {
    expect(launchdPath("/usr/bin:/bin:/usr/sbin:/sbin")).toBe(true);
    expect(launchdPath("/usr/bin:/bin")).toBe(true);
    expect(launchdPath("")).toBe(true);
  });

  test("not when a terminal gave Vimma its PATH, since the shell would share that terminal", () => {
    expect(launchdPath("/Users/u/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin")).toBe(false);
    expect(launchdPath("/opt/homebrew/bin:/usr/bin:/bin")).toBe(false);
    expect(launchdPath("/usr/local/bin")).toBe(false);
  });
});

describe("the folders setup searches on macOS", () => {
  test("the login shell's PATH, then Vimma's own, then the usual install folders", () => {
    expect(
      searchFolders({
        login: ["/Users/u/.nvm/versions/node/v22/bin", "/usr/bin", "/bin"],
        env: "/usr/bin:/bin:/usr/sbin:/sbin",
        home: "/Users/u",
      }),
    ).toEqual([
      "/Users/u/.nvm/versions/node/v22/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      "/Users/u/.local/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ]);
  });

  test("without the login shell's answer, launchd's PATH and the install folders", () => {
    expect(
      searchFolders({ login: null, env: "/usr/bin:/bin:/usr/sbin:/sbin", home: "/Users/u" }),
    ).toEqual([
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      "/Users/u/.local/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ]);
  });

  test("relative entries of Vimma's PATH and a relative home are left out", () => {
    expect(searchFolders({ login: null, env: ".:bin:/usr/bin", home: "" })).toEqual([
      "/usr/bin",
      ...MAC_FOLDERS,
    ]);
  });

  test("the install folders are the native installer's and Homebrew's", () => {
    expect(MAC_FOLDERS).toEqual(["/opt/homebrew/bin", "/usr/local/bin"]);
  });
});
