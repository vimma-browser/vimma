// The types the agent and MCP browser tests name (issue #1243). Those of Vimma's own (what the
// gate tells its listeners, what an agent command answers, an element list's lines) are derived
// from a module under src/, so they follow the product's own JSDoc; the Firefox members at the
// end are the engine's, each with the file that defines it.

/** What AgentGate's listeners hear (AgentGate.addListener; host/AgentGate.sys.mjs GateEvent). */
type GateEvent = NonNullable<Parameters<Parameters<AgentGateApi["addListener"]>[0]>[0]>;
/** A gate event about one question: asked, answered or timed out. */
type GateQuestionEvent = Extract<GateEvent, { question: unknown }>;
/** A call that ran under a grant. */
type GateRanEvent = Extract<GateEvent, { kind: "ran" }>;

/** Each agent command's result, as its handler gives it (ctl/agent-commands.mjs AgentResults). */
type AgentCommandResults =
  import("../../src/browser/base/content/vimma/ctl/agent-commands.mjs").AgentResults;
/** A tab of `agent-tabs`'s list. */
type AgentListedTab = AgentCommandResults["agent-tabs"]["tabs"][number];

/** A refusal in a response (ctl/VimmaControl.sys.mjs ProtocolError). */
type ControlError =
  import("../../src/browser/base/content/vimma/ctl/VimmaControl.sys.mjs").ProtocolError;
/** A response as VimmaControl writes it (Connection.respond): its result, or the refusal. */
type ControlResponse = {
  type: "response";
  /** null only for a request too broken to read its id */
  id: number | null;
  ok: boolean;
  result?: object;
  error?: ControlError;
};

// engine/js/src/vm/TypedArrayObject.cpp (TC39 Uint8Array base64), which the es2024 lib lacks.
interface Uint8ArrayConstructor {
  fromBase64(string: string): Uint8Array<ArrayBuffer>;
}

/**
 * What a window's chat reaches of the app (ui/agent-chat.mjs AgentChatServices). A test hands
 * the chat a fake of only the parts it reaches, cast through unknown.
 */
type AgentChatServices = ConstructorParameters<
  (typeof import("../../src/browser/base/content/vimma/ui/agent-chat.mjs"))["AgentChatWindow"]
>[2];

/** What a frame says of a field a fill would set (actors/agent-fields.mjs FillTargetRaw). */
type FillTargetRaw =
  import("../../src/browser/base/content/vimma/actors/agent-fields.mjs").FillTargetRaw;

// engine/dom/chrome-webidl/WindowGlobalActors.webidl: the window global's inner window id.
interface WindowGlobalChild {
  readonly innerWindowId: number;
}

// engine/editor/nsIEditor.idl: whether the editor's transactions have one to undo.
interface nsIEditor {
  readonly canUndo: boolean;
}

/**
 * One element's line of an element list, as a model reads it (core/agent-act.mjs elementObject):
 * its label, what its frame said of it (core/agent-element.mjs AgentElementInfo), a link's
 * href and the site of the frame it is in.
 */
type ListedElement =
  import("../../src/browser/base/content/vimma/core/agent-element.mjs").AgentElementInfo & {
    label: string;
    href?: string;
    frame?: string;
  };

// engine/dom/webidl/ShadowRoot.webidl (dom.shadowdom.referenceTarget.enabled): the id of the
// element in the root that the host forwards to, as a label's `for` or a button's `form`.
interface ShadowRoot {
  referenceTarget: string | null;
}

/** Vimma's frame actor, as a content task reaches it to stub its messages (actors/VimmaChild.sys.mjs). */
type VimmaChildActor =
  import("../../src/browser/base/content/vimma/actors/VimmaChild.sys.mjs").VimmaChild;
/** A message the parent sends the frame actor (VimmaChild ChildMessage). */
type VimmaChildMessage = Parameters<VimmaChildActor["receiveMessage"]>[0];

// engine/dom/webidl/EventTarget.webidl (chrome-only): a listener in the system group, which a
// page's own listeners cannot stop.
interface AddEventListenerOptions {
  mozSystemGroup?: boolean;
}

// engine/toolkit/components/alerts/nsIAlertsService.idl: the alert's body text.
interface nsIAlertNotification {
  readonly text: string;
}
