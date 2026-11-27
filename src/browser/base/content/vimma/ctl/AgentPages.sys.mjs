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
// - Modified clicks (issue #1568): Firefox opens a ctrl-, shift- or middle-clicked link itself
//   (ClickHandlerChild sends it, ClickHandlerParent.contentAreaClick calls openLinkIn), outside
//   the sandbox flags, and a page with the user's activation can script that click. The method
//   is wrapped, so such a click in an agent tab opens nothing.
// - Dragged links (issue #1592): a link dragged out of an agent tab and dropped on the tab strip,
//   the new-tab button or anywhere else in the window's interface would open (or load) what the
//   page put in the drag data; each window refuses such a drop, and an agent tab's own content
//   area loads only the first of several dropped links (handleDroppedLink would open the rest in
//   new tabs).
// - Downloads (decision 31): every agent tab's top browsing context downloads into the
//   quarantine folder (`downloadFolderOverride`), and AgentDownloads asks and checks each.
// The agent container is WorkspaceStore.agent's, read at each check.

import { WorkspaceStore } from "../workspaces/WorkspaceStore.sys.mjs";
import { AgentDownloads } from "./AgentDownloads.sys.mjs";

const lazy = /** @type {Lazy<"BrowserUtils" | "Integration" | "nsContentDispatchChooser">} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
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

/** @param {nsIPrincipal | null | undefined} principal */
const isAgentPrincipal = (principal) =>
  !!principal && isAgentContainer(principal.originAttributes?.userContextId);

/**
 * The prompt Firefox would show, unless the request comes from the agent container: then a
 * prompt that cancels the request at once (the page is told "denied").
 * @param {ContentPermissionIntegration} base
 */
const permissionOverride = (base) => ({
  __proto__: base,
  /** @param {string} type @param {nsIContentPermissionRequest} request */
  createPermissionPrompt(type, request) {
    if (isAgentPrincipal(request.principal) || isAgentPrincipal(request.topLevelPrincipal)) {
      return { prompt: () => request.cancel() };
    }
    return base.createPermissionPrompt(type, request);
  },
});

/**
 * @param {CanonicalBrowsingContext} bc  a top-level content context
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
 * @param {CanonicalBrowsingContext} bc
 */
function quarantine(bc) {
  try {
    const dir = AgentDownloads.overrideDir();
    if (bc.downloadFolderOverride !== dir) bc.downloadFolderOverride = dir;
  } catch (e) {
    console.error("vimma agent pages: no quarantine folder", e);
  }
}

/** @param {unknown} subject  a BrowsingContext, just attached */
function onAttached(subject) {
  // The topic's subject is the context (BrowsingContext::Attach notifies with it); in the parent
  // every context is canonical.
  const bc = /** @type {CanonicalBrowsingContext | null} */ (subject);
  if (!bc?.isContent || bc.parent) return;
  if (isAgentContainer(bc.originAttributes?.userContextId)) sandbox(bc);
}

/** @param {unknown} subject  an nsIHttpChannel with a response */
function onResponse(subject) {
  let channel;
  try {
    // QueryInterface gives the object as the interface asked or throws, as a subject without it
    // does: either way the catch below.
    const qi = /** @type {{ QueryInterface(iid: unknown): nsIHttpChannel }} */ (subject);
    channel = qi.QueryInterface(Ci.nsIHttpChannel);
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
 * @param {nsIHttpChannel} channel  of a top-level document in the agent container
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
 * @param {nsIURI | null | undefined} uri @param {OriginAttributes} originAttributes @param {number} browserId
 */
function denyFor(uri, originAttributes, browserId) {
  if (!uri?.schemeIs("https") && !uri?.schemeIs("http")) return;
  const services = Services;
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
 * @param {unknown} subject  the WindowGlobalParent (WindowGlobalParent::Init notifies with it)
 */
function onWindowGlobal(subject) {
  const wgp = /** @type {WindowGlobalParent} */ (subject);
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
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
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

/** @param {unknown} subject @param {string} topic */
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
    /** @param {nsIJSIID<unknown>} iid @returns {unknown} */
    createInstance(iid) {
      const inner = AgentPages._chooserForTests ?? new lazy.nsContentDispatchChooser();
      const chooser = {
        QueryInterface: ChromeUtils.generateQI(["nsIContentDispatchChooser"]),
        /**
         * nsIContentDispatchChooser.handleURI's: handler, uri, principal, browsingContext, …
         * @param {Parameters<ContentDispatchChooser["handleURI"]>} args
         */
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

/**
 * Modified clicks (security.md M10, issue #1568): ClickHandlerParent.contentAreaClick opens a
 * link clicked with ctrl or cmd, shift or the middle button with openLinkIn, which no sandbox
 * flag reaches; ClickHandlerChild accepts a page's scripted click while the page holds the
 * user's activation, so a page could open one tab or window per gesture, in the agent
 * container and counted by neither agent rate. In an agent tab (by its top browsing context,
 * so a frame's click too) such a click is dropped: the page stays as it is, as with a pop-up.
 * A plain click ("current") goes to Firefox unchanged; the page's own navigation follows it.
 * The wrapper is on the prototype, which every ClickHandler actor shares; the module is the one
 * the actor loads (resource:///actors/, a singleton in the parent).
 */
function guardModifiedClicks() {
  const { ClickHandlerParent } = ChromeUtils.importESModule(
    "resource:///actors/ClickHandlerParent.sys.mjs",
  );
  const proto = ClickHandlerParent.prototype;
  const original = proto.contentAreaClick;
  if (typeof original !== "function") throw new Error("no ClickHandlerParent.contentAreaClick");
  /** @this {typeof proto} @param {ClickHandlerData} data */
  proto.contentAreaClick = function (data) {
    const top = this.manager?.browsingContext?.top;
    if (
      isAgentContainer(top?.originAttributes?.userContextId) &&
      lazy.BrowserUtils.whereToOpenLink(data) !== "current"
    ) {
      console.warn("vimma: a modified click in an agent tab opens no new tab or window");
      return undefined;
    }
    return original.call(this, data);
  };
}

/**
 * The top browsing context of the page a drag in `win` started in, null for a drag from the
 * window's interface or from outside the app. A drag a content process starts reaches the parent
 * with its page's window context (nsBaseDragSession::InvokeDragSessionWithRemoteImage).
 * @param {ChromeWindow} win
 */
function dragSource(win) {
  if (AgentPages._dragSourceForTests) return AgentPages._dragSourceForTests;
  // A drag that started in another window reads the same: the parent has one drag session
  // whatever widget is asked (nsBaseDragService::GetCurrentSession).
  let session;
  try {
    session = win.windowUtils.dragSession;
  } catch {
    return null;
  }
  return session?.sourceTopWindowContext?.browsingContext ?? null;
}

/**
 * Per window, the <browser> of another workspace that the window's last drop, dragged from an
 * agent tab, landed on: its page hands the drop's links back (BrowserParent::RecvDropLinks) after
 * the drop event, and they load nothing. Every drop in the window replaces it.
 * @type {WeakMap<ChromeWindow, MozBrowser | null>}
 */
const refusedDrop = new WeakMap();

/**
 * Dragged links (security.md M10, issue #1592): a drop on the tab strip, the new-tab or
 * new-window button, the address bar or another part of the window's interface opens or loads
 * the drag's links (drag-and-drop.js handle_drop, ToolbarDropHandler, UrlbarInput), in a new
 * tab outside both agent rates of M3, and a page chooses its drag data, so it can name a link
 * other than the one shown. When the drag started in an agent tab (its top browsing context,
 * so a frame's drag too), the drop is refused there: the window's own listeners never see the
 * dragover, which stays uncancelled, so no drop happens, and a drop sent anyway is stopped. A
 * drop on a content area (a <browser>) reaches its page, which may read it; on another
 * workspace's page, Firefox's own load of its links is refused. A non-remote <browser>'s page is
 * not a <browser> target here (its nodes are), so a drop on it is refused outright.
 * @param {DragEvent} event
 */
function refuseAgentDrop(event) {
  const target = /** @type {Element | null} */ (event.originalTarget);
  const win = /** @type {ChromeWindow} */ (event.currentTarget);
  const fromAgent = isAgentContainer(dragSource(win)?.originAttributes?.userContextId);
  if (target?.localName === "browser") {
    // A chrome listener cannot keep a drop from a remote <browser>'s page (EventStateManager
    // forwards it after dispatch), so the load the page hands back is refused instead
    // (guardContentDrops). Only another workspace's page: an agent tab's keeps its first link.
    if (event.type === "drop") {
      const browser = /** @type {MozBrowser} */ (/** @type {unknown} */ (target));
      const own = isAgentContainer(browser.browsingContext?.originAttributes?.userContextId);
      refusedDrop.set(win, fromAgent && !own ? browser : null);
    }
    return;
  }
  if (event.type === "drop") refusedDrop.set(win, null);
  if (!fromAgent) return;
  event.stopPropagation();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
  if (event.type === "drop") {
    event.preventDefault();
    console.warn("vimma: a link dragged from an agent tab opens nothing here");
  }
}

/**
 * Several links dropped on an agent tab's own page (a page may drag from one of its frames to
 * its document, which Firefox allows): the content process hands them to the parent
 * (BrowserParent::RecvDropLinks, MozBrowser.dropLinks), and handleDroppedLink loads the first in
 * the tab and opens the others in new agent tabs, uncounted. The tab keeps the first, a load
 * the page could make itself. Each window has its own MozBrowser class (browser-custom-element.mjs
 * is loaded with global "current").
 * @param {BrowserWindow} win
 */
function guardContentDrops(win) {
  const proto = /** @type {MozBrowser} */ (win.customElements.get("browser")?.prototype);
  const original = proto?.dropLinks;
  if (typeof original !== "function") throw new Error("no MozBrowser.dropLinks");
  /** @this {MozBrowser} @param {string[]} links @param {nsIPrincipal} principal */
  proto.dropLinks = function (links, principal) {
    if (refusedDrop.get(win) === this) {
      console.warn("vimma: a link dragged from an agent tab loads nothing in another workspace");
      return false;
    }
    // Three strings per link: its URL, name and type.
    if (
      isAgentContainer(this.browsingContext?.originAttributes?.userContextId) &&
      links.length > 3
    ) {
      console.warn("vimma: an agent tab loads only the first of the links dropped on it");
      return original.call(this, links.slice(0, 3), principal);
    }
    return original.call(this, links, principal);
  };
}

export const AgentPages = {
  /**
   * Test-only: the top browsing context a drag is taken to start in. Headless Firefox has no
   * drag service (nsDragService::GetInstance), so a browser test cannot start a drag session.
   * @type {BrowsingContext | null}
   */
  _dragSourceForTests: null,

  /**
   * Test-only: the chooser agent-free loads go to, in place of Firefox's.
   * @type {({ QueryInterface?: unknown } & ContentDispatchChooser) | null}
   */
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
    try {
      guardModifiedClicks();
    } catch (e) {
      console.error("vimma agent pages: modified clicks not guarded", e);
    }
    Services.obs.addObserver(observe, "browsing-context-attached");
    Services.obs.addObserver(observe, "window-global-created");
    for (const topic of RESPONSE_TOPICS) Services.obs.addObserver(observe, topic);
    Services.obs.addObserver(observe, "vimma-mcp-changed");
    sweep();
  },

  /**
   * Once per browser window (vimma.js): dragged links from agent tabs (issue #1592). The
   * listeners go with the window.
   * @param {BrowserWindow} win
   */
  watchWindow(win) {
    for (const type of ["dragover", "drop"]) {
      win.addEventListener(type, /** @type {EventListener} */ (refuseAgentDrop), true);
    }
    // MozBrowser is defined with the window's first tab, after this runs; no drop comes before
    // the window has started up.
    win.delayedStartupPromise
      .then(() => guardContentDrops(win))
      .catch((e) => console.error("vimma agent pages: links dropped on agent tabs not guarded", e));
  },
};
