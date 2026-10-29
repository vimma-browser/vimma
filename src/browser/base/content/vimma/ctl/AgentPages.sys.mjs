/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The agent workspace's pages on a short leash (docs/specs/vimma-mcp.md decision 30): what an
// agent opens there runs with no one watching, so its pages get no permission and open no
// pop-up. Three hooks, all Firefox's own, no upstream patch:
// - Integration.contentPermission: every nsIContentPermissionPrompt request (geolocation,
//   notifications, XR, MIDI, persistent storage, storage access, local network, and any later
//   type) from the agent container is cancelled without a prompt
//   (browser/components/permissions/ContentPermissionPrompt.sys.mjs, createPermissionPrompt).
// - Camera, microphone and screen sharing do not go through it (browser/actors/WebRTCParent's
//   prompt): every document response in an agent tab gets a DENY for its origin scoped to that
//   tab (browser), before the page has it; WebRTCParent reads it as a temporary BLOCK and
//   denies without a prompt.
// - Pop-ups: every top-level browsing context in the agent container gets
//   SANDBOXED_AUXILIARY_NAVIGATION, as Firefox's own hidden page reader does
//   (toolkit/components/pageextractor/PageExtractorParent.sys.mjs); window.open and
//   target=_blank open nothing. CanonicalBrowsingContext::ReplacedBy copies the flags.
// - Downloads (decision 31): every agent tab's top browsing context downloads into the
//   quarantine folder (`downloadFolderOverride`), and AgentDownloads asks and checks each.
// The agent container is WorkspaceStore.agent's, read at each check.

import { WorkspaceStore } from "../workspaces/WorkspaceStore.sys.mjs";
import { AgentDownloads } from "./AgentDownloads.sys.mjs";

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  Integration: "resource://gre/modules/Integration.sys.mjs",
  nsContentDispatchChooser: "resource://gre/modules/ContentDispatchChooser.sys.mjs",
});

/** nsSandboxFlags.h: no new browsing contexts (window.open, target=_blank). */
export const SANDBOXED_AUXILIARY_NAVIGATION = 0x2;
/**
 * What every agent tab's browsing context is sandboxed against. Not SANDBOXED_DOWNLOADS:
 * downloads are allowed, asked and quarantined (decision 31).
 */
export const AGENT_SANDBOX = SANDBOXED_AUXILIARY_NAVIGATION;

/**
 * Prompts WebRTCParent shows itself, outside nsIContentPermissionPrompt (decision 30): denied
 * per agent tab. A browser-scoped DENY (Services.perms.addFromPrincipalForBrowser) is what
 * SitePermissions.getForPrincipal(principal, id, browser) reads as a temporary BLOCK, and
 * WebRTCParent then denies without a prompt. Browser-scoped, not the origin's permission: Vimma
 * isolates permissions by container (permissions.isolateBy.userContext, docs/specs/vimma-mcp.md:
 * site permissions per workspace), but that pref can be turned off in about:config, and an
 * origin-wide DENY would then reach the same site in `work`.
 */
export const AGENT_DENIED_PERMISSIONS = Object.freeze([
  "camera",
  "microphone",
  "screen",
  "speaker",
]);
/** How long each browser-scoped DENY lasts; every document load in the tab sets it again. */
const DENY_MS = 7 * 24 * 60 * 60 * 1000;

const RESPONSE_TOPICS = [
  "http-on-examine-response",
  "http-on-examine-cached-response",
  "http-on-examine-merged-response",
];

let initialised = false;

/** @param {number | null | undefined} userContextId */
function isAgentContainer(userContextId) {
  const agent = WorkspaceStore.agent?.userContextId;
  return typeof agent === "number" && agent > 0 && userContextId === agent;
}

/** @param {any} principal  nsIPrincipal, or null */
const isAgentPrincipal = (principal) =>
  !!principal && isAgentContainer(principal.originAttributes?.userContextId);

/**
 * The prompt Firefox would show, unless the request comes from the agent container: then a
 * prompt that cancels the request at once (the page is told "denied").
 * @param {any} base  ContentPermissionIntegration
 */
const permissionOverride = (base) => ({
  __proto__: base,
  /** @param {string} type @param {any} request  nsIContentPermissionRequest */
  createPermissionPrompt(type, request) {
    if (isAgentPrincipal(request.principal) || isAgentPrincipal(request.topLevelPrincipal)) {
      return { prompt: () => request.cancel() };
    }
    return base.createPermissionPrompt(type, request);
  },
});

/**
 * @param {any} bc  a top-level content BrowsingContext in the parent
 * @returns {boolean} whether the flag was missing (and is set now)
 */
function sandbox(bc) {
  quarantine(bc);
  try {
    if ((bc.sandboxFlags & AGENT_SANDBOX) !== AGENT_SANDBOX) {
      bc.sandboxFlags |= AGENT_SANDBOX;
      return true;
    }
  } catch (e) {
    console.error("vimma agent pages: cannot sandbox", e);
  }
  return false;
}

/**
 * The tab downloads into the quarantine folder (decision 31 b): nsExternalAppHandler puts its
 * `.part` file in a top browsing context's `downloadFolderOverride`. Not copied when the context
 * is replaced, so set at every attach.
 * @param {any} bc
 */
function quarantine(bc) {
  try {
    const dir = AgentDownloads.overrideDir();
    if (bc.downloadFolderOverride !== dir) bc.downloadFolderOverride = dir;
  } catch (e) {
    console.error("vimma agent pages: no quarantine folder", e);
  }
}

/** @param {any} subject  a BrowsingContext, just attached */
function onAttached(subject) {
  const bc = subject;
  if (!bc?.isContent || bc.parent) return;
  if (isAgentContainer(bc.originAttributes?.userContextId)) sandbox(bc);
}

/** @param {any} subject  an nsIHttpChannel with a response */
function onResponse(subject) {
  let channel;
  try {
    channel = subject.QueryInterface(Ci.nsIHttpChannel);
  } catch {
    return;
  }
  const loadInfo = channel.loadInfo;
  const type = loadInfo?.externalContentPolicyType;
  if (type !== Ci.nsIContentPolicy.TYPE_DOCUMENT && type !== Ci.nsIContentPolicy.TYPE_SUBDOCUMENT) {
    return;
  }
  if (!isAgentContainer(loadInfo.originAttributes?.userContextId)) return;
  if (type === Ci.nsIContentPolicy.TYPE_DOCUMENT) dropOpenerPolicy(channel);
  // A frame asks with its top-level document's principal (permission delegation): deny the
  // top-level page's origin, in this tab only.
  const top = loadInfo.browsingContext?.top;
  if (!top?.browserId) return;
  const uri = type === Ci.nsIContentPolicy.TYPE_DOCUMENT ? channel.URI : top.currentURI;
  denyFor(uri, loadInfo.originAttributes, top.browserId);
}

/**
 * An agent tab's top-level page loads without its Cross-Origin-Opener-Policy (issue #640).
 * Firefox fails a top-level load whose browsing context has sandbox flags and whose response
 * has an opener policy other than unsafe-none with NS_ERROR_DOM_COOP_FAILED
 * (HttpBaseChannel::ComputeCrossOriginOpenerPolicyMismatch, which runs after the
 * http-on-examine-* observers), and every agent tab is sandboxed against pop-ups. What the
 * policy guards, a cross-origin window keeping a reference to the page, cannot happen there:
 * the tab has no opener (it is opened from chrome) and its pages open no window. The page still
 * runs in its site's own process; it loses only `crossOriginIsolated` (SharedArrayBuffer). A
 * page a service worker serves reaches no observer and keeps its policy, and loads all the same:
 * InterceptedHttpChannel ignores that error.
 * @param {any} channel  nsIHttpChannel of a top-level document in the agent container
 */
function dropOpenerPolicy(channel) {
  try {
    if (channel.getResponseHeader("Cross-Origin-Opener-Policy") === "") return;
  } catch {
    return;
  }
  try {
    channel.setResponseHeader("Cross-Origin-Opener-Policy", "", false);
  } catch (e) {
    console.error("vimma agent pages: cannot drop an opener policy", e);
  }
}

/**
 * A browser-scoped DENY for each WebRTC prompt on `uri`'s origin, in the agent tab `browserId`.
 * @param {any} uri @param {object} originAttributes @param {number} browserId
 */
function denyFor(uri, originAttributes, browserId) {
  if (!uri?.schemeIs("https") && !uri?.schemeIs("http")) return;
  const services = /** @type {any} */ (Services);
  const principal = services.scriptSecurityManager.createContentPrincipal(uri, originAttributes);
  for (const type of AGENT_DENIED_PERMISSIONS) {
    services.perms.addFromPrincipalForBrowser(
      principal,
      type,
      services.perms.DENY_ACTION,
      browserId,
      DENY_MS,
    );
  }
}

/**
 * A document's window global was created (security.md M10): whatever served it (the network,
 * a service worker, the cache, bfcache), a top-level agent document gets its WebRTC deny before
 * it can ask. Frames ask with the top-level principal (permission delegation).
 * @param {any} wgp  a WindowGlobalParent
 */
function onWindowGlobal(wgp) {
  const bc = wgp?.browsingContext;
  if (!bc?.isContent || bc.parent || !bc.browserId) return;
  const principal = wgp.documentPrincipal;
  if (!principal?.isContentPrincipal) return;
  if (!isAgentContainer(principal.originAttributes?.userContextId)) return;
  denyFor(principal.URI, principal.originAttributes, bc.browserId);
  // A page is showing: what the tab downloads from now on is the page's, not the agent-open's.
  const browser = bc.embedderElement;
  if (browser && principal.URI?.spec !== "about:blank") AgentDownloads.committed(browser);
}

/** Every agent tab open now: sandboxed, and its origin denied (the agent workspace changed). */
function sweep() {
  for (const win of /** @type {any} */ (Services.wm).getEnumerator("navigator:browser")) {
    for (const tab of win.gBrowser?.tabs ?? []) {
      if (!isAgentContainer(tab.userContextId)) continue;
      const browser = tab.linkedBrowser;
      const bc = browser?.browsingContext;
      // A document keeps the flags it loaded with (security.md M10): a page already loaded
      // without the flag is reloaded, so the flag applies to it now, not at its next navigation.
      const loaded = !tab.hasAttribute("pending") && browser?.currentURI?.spec !== "about:blank";
      if (bc && sandbox(bc) && loaded) browser.reload();
      const uri = tab.linkedBrowser?.currentURI;
      const browserId = tab.linkedBrowser?.browserId;
      if (uri && browserId) denyFor(uri, { userContextId: tab.userContextId }, browserId);
    }
  }
}

/** @param {any} subject @param {string} topic */
function observe(subject, topic) {
  if (topic === "browsing-context-attached") onAttached(subject);
  else if (topic === "window-global-created") onWindowGlobal(subject);
  else if (topic === "vimma-mcp-changed") {
    // The folder is checked first, so each tab's download folder is the checked one.
    AgentDownloads.ensureQuarantine().then(sweep);
  } else onResponse(subject);
}

/**
 * Firefox's chooser for external protocols (uriloader/exthandler/nsIContentDispatchChooser). The
 * wrapper constructs upstream's class (toolkit/mozapps/handling/components.conf) directly:
 * Firefox 158 removed nsIComponentManager.getClassObject, and script cannot create an instance
 * by CID once the contract points at our factory.
 */
const CHOOSER_CONTRACT = "@mozilla.org/content-dispatch-chooser;1";
const CHOOSER_CID = Components.ID("{a69ebe05-6906-408c-b7ed-a626713b04f3}");

/**
 * External protocols (security.md M10): an agent page that sets `location = "zoommtg:…"`
 * would launch another app, and Firefox's "always open" choice for a site is not per
 * container. The chooser is wrapped, so a load in the agent container launches nothing; every
 * other load goes to Firefox's own chooser unchanged.
 */
function wrapChooser() {
  const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
  const factory = {
    QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
    /** @param {any} iid */
    createInstance(iid) {
      const inner = AgentPages._chooserForTests ?? new lazy.nsContentDispatchChooser();
      const chooser = {
        QueryInterface: ChromeUtils.generateQI(["nsIContentDispatchChooser"]),
        /** @param {any[]} args  handler, uri, principal, browsingContext, … */
        handleURI(...args) {
          const [, uri, principal, bc] = args;
          const context = bc?.top?.originAttributes?.userContextId;
          if (isAgentContainer(context) || isAgentPrincipal(principal)) {
            console.warn(`vimma: an agent page's ${uri?.scheme}: link opens no app`);
            return undefined;
          }
          return inner.handleURI(...args);
        },
      };
      return chooser.QueryInterface(iid);
    },
  };
  registrar.registerFactory(
    CHOOSER_CID,
    "Vimma: no app launches from agent pages",
    CHOOSER_CONTRACT,
    factory,
  );
}

export const AgentPages = {
  /** Test-only: the chooser agent-free loads go to, in place of Firefox's. @type {any} */
  _chooserForTests: null,

  /** Once per app (vimma.js): the hooks stay for the session. */
  init() {
    if (initialised) return;
    initialised = true;
    lazy.Integration.contentPermission.register(permissionOverride);
    AgentDownloads.init();
    AgentDownloads.ensureQuarantine().then(sweep);
    try {
      wrapChooser();
    } catch (e) {
      console.error("vimma agent pages: external protocols not guarded", e);
    }
    Services.obs.addObserver(observe, "browsing-context-attached");
    Services.obs.addObserver(observe, "window-global-created");
    for (const topic of RESPONSE_TOPICS) Services.obs.addObserver(observe, topic);
    Services.obs.addObserver(observe, "vimma-mcp-changed");
    sweep();
  },
};
