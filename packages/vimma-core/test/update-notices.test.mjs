// docs/specs/update-notices.md: when a check is due at startup, the one-time message per new
// version, and the once-per-session question for a security update. Pure rules; no clock.
import { describe, test, expect } from "vitest";
import {
  CHECK_RETRY_MS,
  QUESTION_HINT,
  RESTART_HINT,
  RESTART_REASK_MS,
  announcement,
  checkDue,
  questionAnswer,
  restartQuestion,
  securityQuestion,
  shouldAsk,
  shouldAskRestart,
} from "../src/update-notices.mjs";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 17, 12);

/** @param {Partial<import("../src/updates.mjs").Offer>} [o] */
const offer = (o = {}) => ({
  appVersion: "158.0.2",
  buildId: "20261017000000",
  displayVersion: "0.1.3",
  detailsUrl: "https://github.com/vimma-browser/vimma/releases/tag/v0.1.3",
  urgent: false,
  advisories: [],
  assets: {},
  ...o,
});

describe("checkDue (a check at startup and on the hourly timer)", () => {
  const base = {
    enabled: true,
    installType: /** @type {const} */ ("tarball"),
    okAt: null,
    triedAt: null,
    now: NOW,
    intervalSeconds: 43200,
  };

  test("never checked: due", () => {
    expect(checkDue(base)).toBe(true);
  });

  test("a successful check within the interval: not due", () => {
    expect(checkDue({ ...base, okAt: NOW - 11 * HOUR, triedAt: NOW - 11 * HOUR })).toBe(false);
  });

  test("the last successful check is older than the interval: due", () => {
    expect(checkDue({ ...base, okAt: NOW - 12 * HOUR, triedAt: NOW - 12 * HOUR })).toBe(true);
    expect(checkDue({ ...base, okAt: NOW - 30 * 24 * HOUR, triedAt: NOW - 30 * 24 * HOUR })).toBe(
      true,
    );
  });

  test("a failed attempt does not count as a check, but is not retried within 10 minutes", () => {
    expect(CHECK_RETRY_MS).toBe(600_000);
    const stale = { ...base, okAt: NOW - 13 * HOUR };
    expect(checkDue({ ...stale, triedAt: NOW - 11 * 60_000 })).toBe(true);
    expect(checkDue({ ...stale, triedAt: NOW - 9 * 60_000 })).toBe(false);
    expect(checkDue({ ...base, okAt: null, triedAt: NOW - 60_000 })).toBe(false);
  });

  test("a clock set back before the last check: due, so a wrong clock never stops checks", () => {
    expect(checkDue({ ...base, okAt: NOW + 5 * HOUR, triedAt: NOW + 5 * HOUR })).toBe(true);
  });

  test("the interval is at least an hour, as the timer polls hourly", () => {
    const at = { ...base, okAt: NOW - 30 * 60_000, triedAt: NOW - 30 * 60_000 };
    expect(checkDue({ ...at, intervalSeconds: 60 })).toBe(false);
    expect(checkDue({ ...at, intervalSeconds: 0 })).toBe(false);
  });

  test("checks off or a source build: never due", () => {
    expect(checkDue({ ...base, enabled: false })).toBe(false);
    expect(checkDue({ ...base, installType: "source" })).toBe(false);
  });
});

describe("announcement (the one-time message per new version)", () => {
  const base = {
    enabled: true,
    installType: /** @type {const} */ ("deb"),
    offer: offer(),
    announced: "",
  };

  test("a version not announced yet: the message, naming :update", () => {
    expect(announcement(base)).toBe("Vimma 0.1.3 is available · :update shows the command");
  });

  test("a security release says so", () => {
    expect(announcement({ ...base, offer: offer({ urgent: true }) })).toBe(
      "Vimma 0.1.3 fixes security issues · :update shows the command",
    );
  });

  test("the same version again: nothing", () => {
    expect(announcement({ ...base, announced: "0.1.3" })).toBeNull();
    expect(
      announcement({ ...base, announced: "0.1.3", offer: offer({ urgent: true }) }),
    ).toBeNull();
  });

  test("a newer version than the one announced: the message again", () => {
    expect(announcement({ ...base, announced: "0.1.2" })).toBe(
      "Vimma 0.1.3 is available · :update shows the command",
    );
  });

  test("an AppImage that is downloading its update waits; once replaced, it says restart", () => {
    const appimage = { ...base, installType: /** @type {const} */ ("appimage") };
    expect(announcement({ ...appimage, stage: "pending" })).toBeNull();
    expect(announcement({ ...appimage, stage: "staged" })).toBe(
      "Vimma 0.1.3 is installed · restart Vimma to use it",
    );
    expect(announcement({ ...appimage, stage: "staged", offer: offer({ urgent: true }) })).toBe(
      "Vimma 0.1.3 fixes security issues · restart Vimma to use it",
    );
    // The replacement failed: the AppImage gets the command, as before.
    expect(announcement({ ...appimage, stage: "none" })).toBe(
      "Vimma 0.1.3 is available · :update shows the command",
    );
  });

  test("no offer, checks off or a source build: nothing", () => {
    expect(announcement({ ...base, offer: null })).toBeNull();
    expect(announcement({ ...base, enabled: false })).toBeNull();
    expect(announcement({ ...base, installType: "source" })).toBeNull();
  });
});

describe("shouldAsk (the security question, once per session)", () => {
  const base = {
    enabled: true,
    installType: /** @type {const} */ ("tarball"),
    offer: offer({ urgent: true }),
    asked: /** @type {string[]} */ ([]),
    privateWindow: false,
  };

  test("an urgent offer not asked about in this session: ask", () => {
    expect(shouldAsk(base)).toBe(true);
  });

  test("asked about already in this session: not again", () => {
    expect(shouldAsk({ ...base, asked: ["0.1.3"] })).toBe(false);
  });

  test("a newer urgent version in the same session: ask about it", () => {
    expect(shouldAsk({ ...base, asked: ["0.1.2"] })).toBe(true);
  });

  test("an ordinary release never asks", () => {
    expect(shouldAsk({ ...base, offer: offer() })).toBe(false);
    expect(shouldAsk({ ...base, offer: null })).toBe(false);
  });

  test("an AppImage that replaces its file itself is not asked to show a command", () => {
    expect(shouldAsk({ ...base, installType: "appimage", stage: "pending" })).toBe(false);
    expect(shouldAsk({ ...base, installType: "appimage", stage: "staged" })).toBe(false);
    expect(shouldAsk({ ...base, installType: "appimage", stage: "none" })).toBe(true);
  });

  test("checks off, a source build or a private window: never", () => {
    expect(shouldAsk({ ...base, enabled: false })).toBe(false);
    expect(shouldAsk({ ...base, installType: "source" })).toBe(false);
    expect(shouldAsk({ ...base, privateWindow: true })).toBe(false);
  });
});

describe("the question and its keys", () => {
  test("the question names the version and ends in (y/N)", () => {
    expect(securityQuestion(offer({ urgent: true }))).toBe(
      "Vimma 0.1.3 fixes security issues. Show the update command? (y/N)",
    );
    expect(QUESTION_HINT).toBe("y show · n or Esc: not this session");
  });

  test("y or Y shows the steps; n, Esc, Enter and any other key dismiss", () => {
    expect(questionAnswer("y")).toBe("yes");
    expect(questionAnswer("Y")).toBe("yes");
    expect(questionAnswer("shift+y")).toBe("yes");
    for (const key of ["n", "N", "escape", "enter", "j", ":", "space"]) {
      expect(questionAnswer(key)).toBe("no");
    }
  });
});

describe("shouldAskRestart (the restart question for an installed security update)", () => {
  const base = {
    enabled: true,
    installType: /** @type {const} */ ("appimage"),
    offer: offer({ urgent: true }),
    stage: /** @type {const} */ ("staged"),
    dismissed: /** @type {Record<string, number>} */ ({}),
    now: NOW,
    privateWindow: false,
  };

  test("an urgent update in place, not asked about in this session: ask", () => {
    expect(shouldAskRestart(base)).toBe(true);
  });

  test("only once it is installed: not while it downloads, not for an offer alone", () => {
    expect(shouldAskRestart({ ...base, stage: "pending" })).toBe(false);
    expect(shouldAskRestart({ ...base, stage: "none" })).toBe(false);
  });

  test("an ordinary update in place never asks: the status bar says it applies on restart", () => {
    expect(shouldAskRestart({ ...base, offer: offer() })).toBe(false);
    expect(shouldAskRestart({ ...base, offer: null })).toBe(false);
  });

  test("answered in this session: asked again 24 hours later, not sooner", () => {
    const at = NOW - RESTART_REASK_MS + 1;
    expect(shouldAskRestart({ ...base, dismissed: { "0.1.3": at } })).toBe(false);
    expect(shouldAskRestart({ ...base, dismissed: { "0.1.3": NOW - RESTART_REASK_MS } })).toBe(
      true,
    );
    expect(RESTART_REASK_MS).toBe(24 * HOUR);
  });

  test("a clock set back since the answer asks again, so a wrong clock never silences it", () => {
    expect(shouldAskRestart({ ...base, dismissed: { "0.1.3": NOW + HOUR } })).toBe(true);
  });

  test("a newer urgent version is a new question", () => {
    expect(shouldAskRestart({ ...base, dismissed: { "0.1.2": NOW } })).toBe(true);
  });

  test("checks off, a source build or a private window: never", () => {
    expect(shouldAskRestart({ ...base, enabled: false })).toBe(false);
    expect(shouldAskRestart({ ...base, installType: "source" })).toBe(false);
    expect(shouldAskRestart({ ...base, privateWindow: true })).toBe(false);
  });

  test("the restart question replaces the steps question once the update is in place", () => {
    const asked = /** @type {string[]} */ ([]);
    const steps = { ...base, asked, stage: /** @type {const} */ ("staged") };
    expect(shouldAsk(steps)).toBe(false);
    expect(shouldAskRestart(base)).toBe(true);
  });
});

describe("the restart question", () => {
  test("names the version, says the tabs come back and ends in (y/N) (Behaviour 6)", () => {
    expect(restartQuestion(offer({ urgent: true }), { privateTabs: false, tabsKept: true })).toBe(
      "Security update 0.1.3 is ready. Restart now? Tabs come back. (y/N)",
    );
    expect(RESTART_HINT).toBe("y restart · n or Esc: not now");
  });

  test("with private tabs open it says they will close", () => {
    expect(restartQuestion(offer({ urgent: true }), { privateTabs: true, tabsKept: true })).toBe(
      "Security update 0.1.3 is ready. Restart now? Tabs come back. Private tabs will close. (y/N)",
    );
  });

  test("when the restart keeps no tab (history cleared on close), it says so", () => {
    for (const privateTabs of [false, true]) {
      expect(restartQuestion(offer({ urgent: true }), { privateTabs, tabsKept: false })).toBe(
        "Security update 0.1.3 is ready. Restart now? Tabs will not come back. (y/N)",
      );
    }
  });
});
