import { describe, expect, it } from "vitest";
import { CONSENT_SELECTORS, classifyPage, isRejectLabel } from "../classify.mjs";

/** @param {Partial<import("../classify.mjs").PageInfo>} over */
const page = (over) => ({
  url: "https://example.com/",
  title: "Example",
  text: "",
  frames: [],
  consent: [],
  ...over,
});

describe("classifyPage: bot checks", () => {
  it("Cloudflare's interstitial, by title and by challenge frame", () => {
    expect(classifyPage(page({ title: "Just a moment..." }))).toEqual({
      kind: "bot-check",
      reason: "Cloudflare challenge",
    });
    expect(
      classifyPage(
        page({ frames: ["https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/x"] }),
      ).kind,
    ).toBe("bot-check");
    expect(
      classifyPage(page({ title: "stackoverflow.com", text: "Verify you are human by completing" }))
        .kind,
    ).toBe("bot-check");
    expect(classifyPage(page({ title: "Attention Required! | Cloudflare" })).kind).toBe(
      "bot-check",
    );
  });

  it("Google's /sorry/ page and its unusual-traffic text", () => {
    expect(
      classifyPage(page({ url: "https://www.google.com/sorry/index?continue=https://x" })),
    ).toEqual({ kind: "bot-check", reason: "Google unusual traffic (/sorry/)" });
    expect(
      classifyPage(page({ text: "Our systems have detected unusual traffic from your network" }))
        .kind,
    ).toBe("bot-check");
  });

  it("reCAPTCHA and hCaptcha challenge frames", () => {
    expect(
      classifyPage(page({ frames: ["https://www.google.com/recaptcha/api2/anchor?k=1"] })).reason,
    ).toBe("reCAPTCHA");
    expect(
      classifyPage(page({ frames: ["https://newassets.hcaptcha.com/captcha/v1/x"] })).reason,
    ).toBe("hCaptcha");
  });

  it("Reddit, DuckDuckGo and Akamai blocks", () => {
    expect(
      classifyPage(page({ text: "whoa there, pardner! Your request has been blocked" })).reason,
    ).toBe("Reddit block");
    expect(
      classifyPage(page({ text: "You've been blocked by network security. To continue, log in" }))
        .reason,
    ).toBe("Reddit block");
    expect(
      classifyPage(page({ text: "Unfortunately, bots use DuckDuckGo too. Please complete" }))
        .reason,
    ).toBe("DuckDuckGo anomaly check");
    expect(classifyPage(page({ title: "Access Denied", text: "Reference #18.abc" })).reason).toBe(
      "Access denied (CDN)",
    );
  });

  it("an article that mentions captchas or Cloudflare is an ordinary page", () => {
    const article = page({
      url: "https://en.wikipedia.org/wiki/CAPTCHA",
      title: "CAPTCHA - Wikipedia",
      text: "A CAPTCHA is a type of challenge–response test. Cloudflare Turnstile and reCAPTCHA …",
    });
    expect(classifyPage(article)).toEqual({ kind: null, reason: "" });
  });

  it("a recaptcha frame used invisibly on an ordinary page still counts only with a challenge URL", () => {
    // reCAPTCHA v3 loads api.js without an anchor/bframe challenge frame
    expect(
      classifyPage(page({ frames: ["https://www.google.com/recaptcha/api.js?render=k"] })).kind,
    ).toBe(null);
  });
});

describe("classifyPage: consent walls", () => {
  it("Google's and YouTube's consent hosts", () => {
    expect(
      classifyPage(page({ url: "https://consent.google.com/m?continue=https://www.google.com/" })),
    ).toEqual({ kind: "consent", reason: "consent.google.com" });
    expect(classifyPage(page({ url: "https://consent.youtube.com/m?continue=x" })).reason).toBe(
      "consent.youtube.com",
    );
  });

  it("a 'Before you continue' dialog over the page", () => {
    expect(
      classifyPage(
        page({ url: "https://www.youtube.com/", text: "Before you continue to YouTube" }),
      ).kind,
    ).toBe("consent");
  });

  it("the same dialog in the IP's language, anywhere in the text (Google from Finland)", () => {
    const fi = page({
      url: "https://www.google.com/search?q=neovim",
      text: "Kirjaudu sisään\nEnnen kuin jatkat Googleen\nKäytämme evästeitä",
    });
    expect(classifyPage(fi).kind).toBe("consent");
    expect(classifyPage(page({ text: "x Bevor Sie zu Google weitergehen" })).kind).toBe("consent");
    expect(classifyPage(page({ text: "Avant d'accéder à YouTube" })).kind).toBe("consent");
  });

  it("a visible consent-manager container", () => {
    expect(classifyPage(page({ consent: ["#onetrust-banner-sdk"] }))).toEqual({
      kind: "consent",
      reason: "consent banner (#onetrust-banner-sdk)",
    });
  });

  it("knows YouTube's consent lightbox over a page (seen from Finland, 2026-10-12)", () => {
    expect(CONSENT_SELECTORS).toContain("ytd-consent-bump-v2-lightbox tp-yt-paper-dialog");
  });

  it("a bot check wins over a consent banner", () => {
    expect(
      classifyPage(page({ title: "Just a moment...", consent: ["#onetrust-banner-sdk"] })).kind,
    ).toBe("bot-check");
  });
});

describe("isRejectLabel", () => {
  it("accepts reject-only labels in English, Finnish, German and French", () => {
    for (const label of [
      "Reject all",
      "  REJECT ALL ",
      "Decline all",
      "Reject",
      "Hylkää kaikki",
      "Alle ablehnen",
      "Tout refuser",
      "Only necessary",
      "Use necessary cookies only",
      "Necessary cookies only",
    ]) {
      expect(isRejectLabel(label), label).toBe(true);
    }
  });

  it("never matches an accept, a settings or a mixed label", () => {
    for (const label of [
      "Accept all",
      "Accept",
      "Customize",
      "More options",
      "Reject all and subscribe",
      "Manage settings",
      "",
    ]) {
      expect(isRejectLabel(label), label).toBe(false);
    }
  });
});
