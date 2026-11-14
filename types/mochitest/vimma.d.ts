// Vimma's own types, for the browser tests to name a callback's parameter, a fixture or a cast.
// ChromeUtils.importESModule types each Vimma module by its URL (modules.d.ts); these name what
// a test writes down itself. Each is derived from a module under src/ (never from a vimma-core
// path), so it follows the product's own JSDoc. The ones that narrow a product type (a `Live`,
// `Contained`, `Refused` or `Offered` one) say what the test knows that the type does not: a
// test casts to one only where that holds, and would fail on the value otherwise.

/** A window's workspace, as WindowWorkspaces models it (core/workspaces.mjs, WorkspaceState). */
type WorkspaceState = NonNullable<
  import("../../src/browser/base/content/vimma/workspaces/WindowWorkspaces.sys.mjs").WindowWorkspacesImpl["model"]
>["workspaces"][number];

/** A workspace definition of the app (core/workspacedefs.mjs, WorkspaceDefinition). */
type WorkspaceDefinition =
  (typeof import("../../src/browser/base/content/vimma/workspaces/WorkspaceStore.sys.mjs"))["WorkspaceStore"]["definitions"]["workspaces"][number];

type AgentGateApi =
  (typeof import("../../src/browser/base/content/vimma/host/AgentGate.sys.mjs"))["AgentGate"];
/** A row of `:mcp log` (AgentGate.log). */
type GateLogRow = AgentGateApi["log"][number];
/** A grant in force (AgentGate.grants()). */
type GateGrant = ReturnType<AgentGateApi["grants"]>[number];
/** A question waiting for the user (AgentGate.waiting). */
type GateQuestion = AgentGateApi["waiting"][number];

type WindowWorkspacesImpl =
  import("../../src/browser/base/content/vimma/workspaces/WindowWorkspaces.sys.mjs").WindowWorkspacesImpl;
/**
 * A window's workspaces once they are built, as a test reads them: WindowWorkspaces.get(win) is
 * undefined for a window VimmaHost has not started, and `model` is null until the model is built
 * (and for a window without workspaces). A test whose window has workspaces casts
 * WindowWorkspaces.get(win) to this; were it wrong, the test would fail on reading `model`.
 */
type LiveWorkspaces = Omit<WindowWorkspacesImpl, "model" | "status"> & {
  readonly model: NonNullable<WindowWorkspacesImpl["model"]>;
  /** null only without a model */
  status(): NonNullable<ReturnType<WindowWorkspacesImpl["status"]>>;
};

/**
 * A question's `what` as a test reads it: plain data that ctl/agent-commands.mjs builds for each
 * tool, which AgentGate types as `object` and core/agent-prompt.mjs (the question line) reads as
 * this same Record. No field is typed until the product types `what` (issue #959).
 */
type AskedWhat = import("../../src/browser/base/content/vimma/core/agent-prompt.mjs").Asked["what"];
/** A question waiting for the user, with its `what` as the question line reads it. */
type AskedQuestion = Omit<GateQuestion, "what"> & { what: AskedWhat };

type McpHostApi =
  (typeof import("../../src/browser/base/content/vimma/host/mcp-ops.mjs"))["McpHost"];
/** `[agent]` as the config resolves it (core/config.mjs AgentConfig). */
type AgentConfig = NonNullable<Parameters<McpHostApi["configureAgent"]>[0]>;
/** A model provider of `[[agent.providers]]` (core/config.mjs AgentProviderConfig). */
type AgentProviderConfig = AgentConfig["providers"][number];

type VimmaUpdatesApi =
  (typeof import("../../src/browser/base/content/vimma/updates/VimmaUpdates.sys.mjs"))["VimmaUpdates"];
/** Firefox's updater as VimmaUpdates uses it, which a test fakes (VimmaUpdates._setFirefox). */
type FirefoxUpdater = NonNullable<Parameters<VimmaUpdatesApi["_setFirefox"]>[0]>;
/** How far Firefox got with a build (core/update-notices.mjs Stage). */
type UpdateStage = ReturnType<FirefoxUpdater["stage"]>;

/** A window's split view (split/PaneView.mjs); PaneViews.get(win) is undefined before it starts. */
type PaneView = import("../../src/browser/base/content/vimma/split/PaneView.mjs").PaneView;
/**
 * A tab as PaneView types it: a real tab, with its panel (`linkedPanel` set), which the tabs a test
 * splits have; Firefox's own type allows a tab without one.
 */
type PaneTab = Parameters<PaneView["showTabs"]>[1];

/** A service of the host's registry (host/host-services.mjs ServiceName). */
type HostServiceName = keyof Parameters<
  (typeof import("../../src/browser/base/content/vimma/host/host-services.mjs"))["HostServices"]["provide"]
>[0];

/**
 * A workspace definition with its container. Every workspace has one while containers are on, as
 * they are in the browser tests; userContextId is null only with containers off. A test's helper
 * that looks up a workspace it knows exists casts the lookup to this.
 */
type ContainedWorkspace = WorkspaceDefinition & {
  userContextId: NonNullable<WorkspaceDefinition["userContextId"]>;
};
/** The user's answer to a question (AgentGate.answer). */
type GateAnswer = Parameters<AgentGateApi["answer"]>[1];

type VimmaActorsApi =
  (typeof import("../../src/browser/base/content/vimma/actors/VimmaActors.sys.mjs"))["VimmaActors"];
/** An element the hints found in a page (VimmaActors.collectHints). */
type HintTarget = Parameters<VimmaActorsApi["activateHint"]>[0];
/**
 * A frame's console error entry, as the child makes it (core/agent-act.mjs ConsoleEntry);
 * VimmaActors.agentConsole passes the child's entries on as `unknown` for its caller to check.
 */
type ConsoleEntry = import("../../src/browser/base/content/vimma/core/agent-act.mjs").ConsoleEntry;
/** `[mcp]` as the config resolves it (core/config.mjs McpConfig). */
type McpConfig = NonNullable<Parameters<McpHostApi["configure"]>[0]>;

/** A check's result (VimmaUpdates.check, VimmaUpdates.status). */
type UpdateState = Awaited<ReturnType<VimmaUpdatesApi["check"]>>;
/** A check that was refused or failed: `reason` says why. */
type RefusedUpdate = UpdateState & { reason: NonNullable<UpdateState["reason"]> };
/** A check that verified an answer: when, and the key that signed it. */
type VerifiedUpdate = UpdateState & {
  okAt: NonNullable<UpdateState["okAt"]>;
  key: NonNullable<UpdateState["key"]>;
};
/** A check that found an update. */
type OfferedUpdate = UpdateState & { offer: NonNullable<UpdateState["offer"]> };
/** What about:vimma shows of updates (VimmaUpdates.describe). */
type UpdateDescription = Awaited<ReturnType<VimmaUpdatesApi["describe"]>>;
/** about:vimma with an update offered to an AppImage: the offer, and how its replacement went. */
type AppImageOffer = UpdateDescription & {
  offer: NonNullable<UpdateDescription["offer"]>;
  appImage: NonNullable<UpdateDescription["appImage"]>;
};
/** An AppImage's replacement that failed: `reason` says why. */
type AppImageRefusal = AppImageOffer & {
  appImage: { reason: NonNullable<AppImageOffer["appImage"]["reason"]> };
};
/** about:vimma with an update offered to a tarball that Firefox's updater updates. */
type FirefoxOffer = UpdateDescription & {
  offer: NonNullable<UpdateDescription["offer"]>;
  firefox: NonNullable<UpdateDescription["firefox"]>;
};

type VimmaHostApi =
  (typeof import("../../src/browser/base/content/vimma/host/VimmaHost.sys.mjs"))["VimmaHost"];
/** The hint mode of a window, while it is on (VimmaHost._hints). */
type HostHints = NonNullable<ReturnType<VimmaHostApi["_hints"]>>;
/** One label of it and the element it stands for. */
type HostHint = HostHints["hints"][number];
/** A split's tree of panes (core/panes.mjs Panes); PaneView.panes is null with one pane. */
type Panes = NonNullable<PaneView["panes"]>;
