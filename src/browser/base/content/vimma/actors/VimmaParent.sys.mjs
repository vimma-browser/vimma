/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Parent side of the Vimma actor (spec: docs/specs/m1-actor-insert-scroll.md): hands focus
// reports and mouse selections (m1-copy-mode) to the host for the tab's <browser>. Commands go
// out through VimmaActors.

import { parseDescriptor } from "../core/editable.mjs";
import { VimmaHost } from "../host/VimmaHost.sys.mjs";
import { VimmaActors } from "./VimmaActors.sys.mjs";

const TRIGGERS = new Set(["focusin", "recheck"]);
const MESSAGES = new Set(["Vimma:Focus", "Vimma:MouseSelection", "Vimma:Click"]);

/** Element focus (docs/specs/element-focus.md): from the frames of a focused block. */
const BLOCK_REPORTS = new Map([
  ["Vimma:BlockMoved", "moved"],
  ["Vimma:BlockGone", "gone"],
]);

export class VimmaParent extends JSWindowActorParent {
  /** @param {{ name: string, data: any }} msg */
  receiveMessage(msg) {
    // A focused block's frame need not have focus (a block in a frame of the focused page):
    // the host hears only the frames of its block, with the documents they had (ElementFocus).
    const report = BLOCK_REPORTS.get(msg.name);
    if (report) {
      VimmaHost.onBlockReport(
        /** @type {"moved" | "gone"} */ (report),
        this.browsingContext,
        this.manager,
        msg.data?.gen,
      );
      return;
    }
    if (msg.name === "Vimma:AgentSkipped") {
      // An agent's click or submit was skipped in this frame (docs/specs/mcp-forms.md F16;
      // security.md M28): the tab's allowed submission is withdrawn. From any frame of the tab,
      // a forged one can only take an allowance away.
      VimmaActors.agentSkipped(this.browsingContext);
      return;
    }
    if (!MESSAGES.has(msg.name)) return;
    // From a content process, which may be compromised: only the frame that has focus speaks
    // for the tab (a hidden cross-origin frame must not flip its mode), and only a well-formed
    // report is taken. The focus manager learns of a focus change before the child's report,
    // which follows it on the same IPC channel. Parent-process pages (Settings) are privileged
    // and may focus a field while their tab is still being selected, before the focus manager
    // moves: they are exempt from the focus check.
    const focused = Services.focus.focusedContentBrowsingContext;
    if (!this.manager.isInProcess && this.browsingContext !== focused) return;
    const browser = this.browsingContext.top.embedderElement;
    if (msg.name === "Vimma:MouseSelection") {
      // The user selected text with the mouse in the focused frame: copy mode takes it.
      if (browser) VimmaHost.onMouseSelection(browser);
      return;
    }
    if (msg.name === "Vimma:Click") {
      // The user clicked in the focused frame: a page focus after Esc may enter insert again.
      if (browser) VimmaHost.onUserClick(browser);
      return;
    }
    const trigger = msg.data?.trigger;
    const descriptor = parseDescriptor(msg.data?.descriptor);
    if (!browser || !TRIGGERS.has(trigger) || !descriptor) return;
    // `user` and `gen` only narrow what a report may do after Esc (docs/specs/insert-focus.md):
    // a forged one can do no more than any report could before them.
    const gen = Number.isSafeInteger(msg.data?.gen) ? msg.data.gen : 0;
    VimmaHost.onFocusReport(browser, {
      descriptor,
      trigger,
      frame: this.browsingContext,
      windowId: this.manager.innerWindowId,
      user: msg.data?.user === true,
      gen,
    });
  }

  didDestroy() {
    // The document went away (a navigation, a closed tab): element focus in it ends.
    try {
      VimmaHost.onFrameGone(this.manager);
    } catch {
      // no manager left to compare: the next key finds the frame gone instead
    }
  }
}
