/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Parent side of the Vimma actor (spec: docs/specs/m1-actor-insert-scroll.md): hands focus
// reports and mouse selections (m1-copy-mode) to the host for the tab's <browser>. Commands go
// out through VimmaActors and, for an agent's, AgentActors.

import { parseDescriptor } from "../core/editable.mjs";
import { VimmaHost } from "./VimmaHost.sys.mjs";
import { AgentActors } from "../actors/AgentActors.sys.mjs";
import { PdfOps } from "./pdf-ops.mjs";
import { fieldsOf } from "./browser-ops.mjs";

/** @import { InsertTrigger } from "../core/editable.mjs" */

const TRIGGERS = new Set(["focusin", "recheck"]);
const MESSAGES = new Set(["Vimma:Focus", "Vimma:MouseSelection", "Vimma:Click", "Vimma:UserInput"]);

/** Element focus (docs/specs/element-focus.md): from the frames of a focused block. */
const BLOCK_REPORTS = new Map([
  ["Vimma:BlockMoved", "moved"],
  ["Vimma:BlockGone", "gone"],
]);

/**
 * @param {unknown} trigger
 * @returns {trigger is InsertTrigger}
 */
const isTrigger = (trigger) => typeof trigger === "string" && TRIGGERS.has(trigger);

export class VimmaParent extends JSWindowActorParent {
  /** @param {{ name: string, data: unknown }} msg */
  receiveMessage(msg) {
    if (msg.name === "Vimma:AgentSkipped") {
      // An agent's click or submit was skipped in this frame (docs/specs/mcp-forms.md F16;
      // security.md M28): the tab's allowed submission is withdrawn. From any frame of the tab,
      // a forged one can only take an allowance away, and say its own frame's click was skipped.
      // First, so that no check of the actor's own state comes before taking it away.
      AgentActors.agentSkipped(this.browsingContext, this.manager, msg.data);
      return undefined;
    }
    // An actor that gets a message has its manager, and browsingContext throws rather than give
    // null without one (JSWindowActorParent.cpp): this check only narrows the declared types.
    const bc = this.browsingContext;
    const wg = this.manager;
    if (!bc || !wg) return undefined;
    const data = fieldsOf(msg.data);
    // A focused block's frame need not have focus (a block in a frame of the focused page):
    // the host hears only the frames of its block, with the documents they had (ElementFocus).
    const report = BLOCK_REPORTS.get(msg.name);
    if (report) {
      VimmaHost.onBlockReport(/** @type {"moved" | "gone"} */ (report), bc, wg, data.gen);
      return undefined;
    }
    if (msg.name === "Vimma:HoverEnded") {
      // The user's hover ended in this frame by itself (docs/specs/hover.md decisions 5 and 13).
      // Taken only from the frame that holds it: a forged one ends that frame's own hover.
      VimmaHost.onHoverEnded(wg);
      return undefined;
    }
    if (msg.name === "Vimma:PdfState") {
      // PdfOps takes it only from the top viewer's current document (security.md section 20).
      PdfOps.onState(this, msg.data);
      return undefined;
    }
    if (msg.name === "Vimma:PdfTheme") {
      // The token sheet, only for the top viewer's current document (V12); null for any other.
      return PdfOps.theme(this);
    }
    if (msg.name === "Vimma:PdfOutline") {
      // Taken only after the user's Tab, from the same actor, and parsed (V8).
      PdfOps.onOutline(this, msg.data);
      return undefined;
    }
    if (!MESSAGES.has(msg.name)) return undefined;
    // From a content process, which may be compromised: only the frame that has focus speaks
    // for the tab (a hidden cross-origin frame must not flip its mode), and only a well-formed
    // report is taken. The focus manager learns of a focus change before the child's report,
    // which follows it on the same IPC channel. Parent-process pages (Settings) are privileged
    // and may focus a field while their tab is still being selected, before the focus manager
    // moves: they are exempt from the focus check.
    const focused = Services.focus.focusedContentBrowsingContext;
    if (!wg.isInProcess && bc !== focused) return undefined;
    // A top context's embedder in the parent is its <browser>; the actor is only in the
    // `browsers` message manager group (VimmaActors.init): a tab's.
    const browser = /** @type {MozTabBrowser | null} */ (bc.top.embedderElement);
    if (msg.name === "Vimma:MouseSelection") {
      // The user selected text with the mouse in the focused frame: copy mode takes it.
      if (browser) VimmaHost.onMouseSelection(browser);
      return undefined;
    }
    if (msg.name === "Vimma:Click") {
      // The user clicked in the focused frame: a page focus after Esc may enter insert again.
      if (browser) VimmaHost.onUserClick(browser);
      return undefined;
    }
    if (msg.name === "Vimma:UserInput") {
      // The user put text into the focused frame without a key the window saw as one (an IME,
      // a drop): a field the page focused is theirs (mcp-drive D13). A forged one only makes
      // the tab look in use to an agent.
      if (browser) VimmaHost.onUserInput(browser);
      return undefined;
    }
    const trigger = data.trigger;
    const descriptor = parseDescriptor(data.descriptor);
    if (!browser || !isTrigger(trigger) || !descriptor) return undefined;
    // `user` and `gen` only narrow what a report may do after Esc (docs/specs/insert-focus.md):
    // a forged one can do no more than any report could before them. `user` also says whose
    // insert it is (mcp-drive D13): a forged true only makes the tab look in use to an agent,
    // and a forged false never outweighs the user's keys, which the window itself sees.
    const gen = typeof data.gen === "number" && Number.isSafeInteger(data.gen) ? data.gen : 0;
    VimmaHost.onFocusReport(browser, {
      descriptor,
      trigger,
      frame: bc,
      windowId: wg.innerWindowId,
      user: data.user === true,
      gen,
    });
    return undefined;
  }

  didDestroy() {
    PdfOps.dropActor(this);
    // The document went away (a navigation, a closed tab): element focus in it ends.
    try {
      const wg = this.manager;
      if (wg) VimmaHost.onFrameGone(wg);
    } catch {
      // no manager left to compare: the next key finds the frame gone instead
    }
  }
}
