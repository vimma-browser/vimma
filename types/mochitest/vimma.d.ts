// Vimma's own types, for the browser tests to name a callback's parameter or a fixture while
// ChromeUtils.importESModule returns `any` here. Each is derived from a module under src/ (never
// from a vimma-core path), so it follows the product's own JSDoc.

/** A window's workspace, as WindowWorkspaces models it (core/workspaces.mjs, WorkspaceState). */
type WorkspaceState =
  import("../../src/browser/base/content/vimma/workspaces/WindowWorkspaces.sys.mjs").WindowWorkspacesImpl["model"]["workspaces"][number];

/** A workspace definition of the app (core/workspacedefs.mjs, WorkspaceDefinition). */
type WorkspaceDefinition =
  (typeof import("../../src/browser/base/content/vimma/workspaces/WorkspaceStore.sys.mjs"))["WorkspaceStore"]["definitions"]["workspaces"][number];

type AgentGateApi =
  (typeof import("../../src/browser/base/content/vimma/ctl/AgentGate.sys.mjs"))["AgentGate"];
/** A row of `:mcp log` (AgentGate.log). */
type GateLogRow = AgentGateApi["log"][number];
/** A grant in force (AgentGate.grants()). */
type GateGrant = ReturnType<AgentGateApi["grants"]>[number];
/** A question waiting for the user (AgentGate.waiting). */
type GateQuestion = AgentGateApi["waiting"][number];
