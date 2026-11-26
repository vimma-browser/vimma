// MacApplicationDelegate-mm.patch's helpers (docs/specs/app-routes.md, decision 11), compiled
// from the patch's own lines against the macOS SDK and run: the token check, the sender of
// events that are not a running app's kAEGetURL, and VIMMA_FROM at a cold start. The routing
// itself needs a window server and Apple Events, which macos.yml's smoke covers
// (tools/e2e/macos-app-routes.ts). Skipped where there is no clang with the macOS SDK.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PATCH = fileURLToPath(
  new URL("../../../src/toolkit/xre/MacApplicationDelegate-mm.patch", import.meta.url),
);
const canBuild =
  process.platform === "darwin" &&
  spawnSync("xcrun", ["--show-sdk-path"], { stdio: "ignore" }).status === 0;

/** The patch's added C helpers: from its first Vimma comment up to `- (BOOL)openURLs:`. */
export function patchHelpers(patch: string): string {
  const lines = patch.split("\n").filter((l) => !l.startsWith("+++") && !l.startsWith("---"));
  const start = lines.findIndex((l) => l.startsWith("+// Vimma (app-routes"));
  if (start < 0) throw new Error("no Vimma helpers in the patch");
  const end = lines.findIndex((l, i) => i > start && l.slice(1).startsWith("- (BOOL)openURLs:"));
  return lines
    .slice(start, end < 0 ? undefined : end)
    .filter((l) => l.startsWith("+"))
    .map((l) => l.slice(1))
    .join("\n");
}

const HARNESS = String.raw`
#import <Cocoa/Cocoa.h>
#import <Carbon/Carbon.h>
#include <stdio.h>
#include <stdlib.h>
#include "helpers.inc"
static void out(const char* key, NSString* v) {
  printf("%s=%s\n", key, v ? [[v stringByReplacingOccurrencesOfString:@"\n" withString:@"\\n"] UTF8String] : "(nil)");
}
static void env(const char* key) { const char* v = getenv("VIMMA_FROM"); printf("%s=%s\n", key, v ? v : "(unset)"); }
int main(int argc, char** argv) {
  @autoreleasepool {
    NSString* mode = [NSString stringWithUTF8String:argv[1]];
    if ([mode isEqualToString:@"token"]) {
      for (int i = 2; i < argc; i++) out(argv[i], VimmaToken([NSString stringWithUTF8String:argv[i]]));
      out("trailing-newline", VimmaToken(@"ghostty\n"));
      out("nil", VimmaToken(nil));
    } else if ([mode isEqualToString:@"sender"]) {
      NSAppleEventDescriptor* self_ = [NSAppleEventDescriptor descriptorWithProcessIdentifier:getpid()];
      out("nil-event", VimmaSenderNames(nil));
      out("unsent-geturl", VimmaSenderNames([NSAppleEventDescriptor appleEventWithEventClass:kInternetEventClass
          eventID:kAEGetURL targetDescriptor:self_ returnID:kAutoGenerateReturnID transactionID:kAnyTransactionID]));
      out("open-documents", VimmaSenderNames([NSAppleEventDescriptor appleEventWithEventClass:kCoreEventClass
          eventID:kAEOpenDocuments targetDescriptor:self_ returnID:kAutoGenerateReturnID transactionID:kAnyTransactionID]));
    } else {
      // cold: each later argument is one event's names ("-" for none), in order
      setenv("VIMMA_FROM", "inherited", 1);
      for (int i = 2; i < argc; i++) {
        VimmaSetColdStartNames(strcmp(argv[i], "-") ? [NSString stringWithUTF8String:argv[i]] : nil);
      }
      env("after");
    }
  }
  return 0;
}
`;

let dir = "";
let bin = "";

/** The harness's `key=value` lines for one run. */
function run(...args: string[]): Record<string, string> {
  const r = spawnSync(bin, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`harness failed: ${r.stderr}`);
  return Object.fromEntries(
    r.stdout
      .trim()
      .split("\n")
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

describe("patchHelpers", () => {
  it("takes the patch's added lines from the Vimma comment up to openURLs:", () => {
    const patch = [
      "+++ b/x.mm",
      " context",
      "+// Vimma (app-routes, decision 11): x",
      "+static int f() { return 1; }",
      " - (BOOL)openURLs:(NSArray<NSURL*>*)urls {",
      "+  more",
    ].join("\n");
    expect(patchHelpers(patch)).toBe(
      "// Vimma (app-routes, decision 11): x\nstatic int f() { return 1; }",
    );
  });
});

describe.skipIf(!canBuild)("MacApplicationDelegate-mm.patch's helpers, compiled", () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "vimma-sender-names-"));
    writeFileSync(join(dir, "helpers.inc"), patchHelpers(readFileSync(PATCH, "utf8")));
    writeFileSync(join(dir, "harness.mm"), HARNESS);
    bin = join(dir, "harness");
    // Without ARC, as Firefox builds its Objective-C.
    const cc = spawnSync(
      "xcrun",
      ["clang++", "-std=c++17", "-fno-objc-arc", "-Wall", "-Werror", "-Wno-unused-function"]
        .concat(["-framework", "Cocoa", "-framework", "Carbon"])
        .concat([join(dir, "harness.mm"), "-o", bin]),
      { encoding: "utf8" },
    );
    if (cc.status !== 0) throw new Error(`the patch's helpers do not compile:\n${cc.stderr}`);
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a lower-cased app token of 1 to 64 characters and nothing else", () => {
    const max = "a".repeat(64);
    const r = run("token", "Ghostty", "com.microsoft.teams2", max, `${max}a`, "", "-x", "a b");
    expect(r.Ghostty).toBe("ghostty");
    expect(r["com.microsoft.teams2"]).toBe("com.microsoft.teams2");
    expect(r[max]).toBe(max);
    expect(r[`${max}a`]).toBe("(nil)");
    expect(r[""]).toBe("(nil)");
    expect(r["-x"]).toBe("(nil)");
    expect(r["a b"]).toBe("(nil)");
    expect(r.nil).toBe("(nil)");
  });

  it("refuses a name with a trailing newline", () => {
    expect(run("token")["trailing-newline"]).toBe("(nil)");
  });

  it("names nothing for no event, an event with no sender, or one that is not kAEGetURL", () => {
    expect(run("sender")).toEqual({
      "nil-event": "(nil)",
      "unsent-geturl": "(nil)",
      "open-documents": "(nil)",
    });
  });

  it("at a cold start, the first event's names replace an inherited VIMMA_FROM", () => {
    expect(run("cold", "com.mitchellh.ghostty,ghostty").after).toBe(
      "com.mitchellh.ghostty,ghostty",
    );
  });

  it("at a cold start, an event with no names unsets VIMMA_FROM", () => {
    expect(run("cold", "-").after).toBe("(unset)");
  });

  it("at a cold start, a second event leaves VIMMA_FROM unset, whatever it names", () => {
    expect(run("cold", "-", "com.mitchellh.ghostty,ghostty").after).toBe("(unset)");
    expect(run("cold", "slack", "com.mitchellh.ghostty,ghostty").after).toBe("(unset)");
  });
});
