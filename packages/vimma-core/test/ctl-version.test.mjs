// Spec: docs/specs/ship-vimma-ctl.md, behaviours 4-6: an agent connection names its vimma-ctl's
// version, and a client older than Vimma gets a one-line notice, never a refusal.
import { describe, expect, it } from "vitest";
import { validateMessage } from "../src/control.mjs";
import {
  compareVersions,
  ctlIsCurrent,
  ctlVersionNotice,
  isCtlVersion,
} from "../src/ctl-version.mjs";

describe("compareVersions", () => {
  it("orders by major, minor and patch as numbers", () => {
    expect(compareVersions("0.1.7", "0.1.8")).toBeLessThan(0);
    expect(compareVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "0.2.0")).toBe(0);
  });

  it("puts a pre-release before its release, and treats two pre-releases of one as equal", () => {
    expect(compareVersions("0.1.8-nightly.20261022", "0.1.8")).toBeLessThan(0);
    expect(compareVersions("0.1.8", "0.1.8-nightly.20261022")).toBeGreaterThan(0);
    expect(compareVersions("0.1.8-nightly.1", "0.1.8-nightly.2")).toBe(0);
    expect(compareVersions("0.1.8-nightly.1", "0.1.7")).toBeGreaterThan(0);
  });

  it("returns NaN for anything that is not a version", () => {
    expect(compareVersions("x", "0.1.8")).toBeNaN();
    expect(compareVersions("0.1.8", "1.2")).toBeNaN();
  });
});

describe("isCtlVersion", () => {
  it("accepts SemVer with an optional pre-release, at most 64 characters", () => {
    expect(isCtlVersion("0.1.8")).toBe(true);
    expect(isCtlVersion("0.1.8-nightly.20261022")).toBe(true);
    expect(isCtlVersion(`0.1.8-${"a".repeat(58)}`)).toBe(true);
    expect(isCtlVersion(`0.1.8-${"a".repeat(59)}`)).toBe(false);
  });

  it("refuses the rest", () => {
    for (const bad of ["", "1.2", "v0.1.8", "0.1.8 ", "0.1.8\n", "0.1.8+build", 8, null]) {
      expect(isCtlVersion(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("ctlVersionNotice", () => {
  it("says nothing for a client as new as Vimma or newer", () => {
    expect(ctlVersionNotice("0.1.8", "0.1.8")).toBeNull();
    expect(ctlVersionNotice("0.1.9", "0.1.8")).toBeNull();
  });

  it("names both versions for an older client", () => {
    expect(ctlVersionNotice("0.1.7", "0.1.8")).toBe(
      "vimma-ctl 0.1.7 is older than Vimma 0.1.8: agents get fewer tools until you update it",
    );
  });

  it("says older for a client that names no version: it predates the check", () => {
    expect(ctlVersionNotice(undefined, "0.1.8")).toBe(
      "vimma-ctl is older than Vimma 0.1.8: agents get fewer tools until you update it",
    );
  });

  it("says nothing when Vimma's own version is not one it can compare", () => {
    expect(ctlVersionNotice("0.1.7", "")).toBeNull();
    expect(ctlVersionNotice(undefined, "dev")).toBeNull();
  });
});

// Issue #592: a reply field newer than the client (a rate refusal's retryAfter) goes only to a
// vimma-ctl at least as new as Vimma, so an older client keeps working (decision 6).
describe("ctlIsCurrent", () => {
  it("is true for a client as new as Vimma or newer", () => {
    expect(ctlIsCurrent("0.1.8", "0.1.8")).toBe(true);
    expect(ctlIsCurrent("0.1.9", "0.1.8")).toBe(true);
    expect(ctlIsCurrent("0.1.8-nightly.2", "0.1.8-nightly.1")).toBe(true);
  });

  it("is false for an older client, or one that names no version", () => {
    expect(ctlIsCurrent("0.1.7", "0.1.8")).toBe(false);
    expect(ctlIsCurrent("0.1.8-rc.1", "0.1.8")).toBe(false);
    expect(ctlIsCurrent(undefined, "0.1.8")).toBe(false);
  });

  it("is false when either version cannot be compared", () => {
    expect(ctlIsCurrent("0.1.8", "dev")).toBe(false);
    expect(ctlIsCurrent("x", "0.1.8")).toBe(false);
  });
});

describe("agent-hello's ctl", () => {
  /** @param {Record<string, unknown>} args */
  const hello = (args) =>
    validateMessage(
      { type: "request", id: 1, command: "agent-hello", args: { client: { name: "a" }, ...args } },
      { kind: "request" },
    );

  it("is optional, and refused with the whole hello when it is not a version", () => {
    expect(hello({}).valid).toBe(true);
    expect(hello({ ctl: "0.1.8" }).valid).toBe(true);
    for (const ctl of ["v0.1.8", "", 8, "0.1.8\u001b[2J"]) {
      expect(hello({ ctl }).errors, JSON.stringify(ctl)).toContain(
        "ctl must be a Vimma version (X.Y.Z)",
      );
    }
  });
});
