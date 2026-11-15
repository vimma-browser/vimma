/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The built-in agent's API key entry (docs/specs/builtin-agent.md Behaviour 3; security.md M46,
// M40): the masked key field and what never lets it show the key, and asking for, storing,
// clearing and deleting a hosted provider's key. A key typed here goes only to the AgentKeys
// the host hands the window (`chat.services.keys`); it is never drawn, logged or kept. The state
// stays on the AgentChatWindow (ui/agent-chat.mjs) passed in, which is never imported here, so
// the two do not form a cycle.

/** @import { AgentChatWindow } from "./agent-chat.mjs" */
/** @typedef {import("../core/config.mjs").AgentProviderConfig} AgentProviderConfig */

export const CHAT_KEY_ID = "vimma-agent-chat-key";

const HTML_NS = "http://www.w3.org/1999/xhtml";
// The key field's eye button: `::-moz-reveal` parses only in user-agent sheets, so this one rule
// goes in as an agent sheet (an author sheet such as side-panel.css drops it).
const NO_REVEAL_SHEET =
  "data:text/css," + encodeURIComponent(`#${CHAT_KEY_ID}::-moz-reveal { display: none; }`);
/** @type {WeakSet<BrowserWindow>} windows NO_REVEAL_SHEET is loaded into (a second load throws) */
const noReveal = new WeakSet();

/**
 * Whether two providers are the same model at the same endpoint under the same name.
 * @param {AgentProviderConfig} a @param {AgentProviderConfig} b
 */
export const sameProvider = (a, b) =>
  a.endpoint === b.endpoint && a.model === b.model && a.name === b.name;

/**
 * The masked key field (Behaviour 3), built once per window by agent-chat-view.mjs's `build`:
 * a password field that never reveals the key (M46).
 * @param {BrowserWindow} win
 */
export function keyField(win) {
  const doc = win.document;
  const keyInput = /** @type {HTMLInputElement} */ (doc.createElementNS(HTML_NS, "input"));
  keyInput.id = CHAT_KEY_ID;
  keyInput.type = "password";
  keyInput.autocomplete = "off";
  keyInput.className = "vimma-agent-chat-input";
  if (!noReveal.has(win)) {
    noReveal.add(win);
    try {
      win.windowUtils.loadSheetUsingURIString(NO_REVEAL_SHEET, win.windowUtils.AGENT_SHEET);
    } catch (e) {
      // The button would then show but do nothing: the listeners below still cancel it.
      console.error("vimma agent: the key field's sheet did not load", e);
    }
  }
  // An entered key is never shown again (M46). NO_REVEAL_SHEET hides the eye button, and every
  // reveal a user can ask for (that button, the textbox context menu's item, `revealPassword`)
  // goes through the cancelable MozWillToggleReveal; a masked field already refuses copy and cut. The context
  // menu goes too, since its only use here would be that reveal item; ctrl+v still pastes.
  for (const type of ["MozWillToggleReveal", "contextmenu", "copy", "cut", "dragstart"]) {
    keyInput.addEventListener(type, (e) => e.preventDefault());
  }
  return keyInput;
}

/**
 * The masked key field for `provider` (Behaviour 3): what is typed there goes only to login
 * storage, encrypted with OSKeyStore (B8), and is never drawn, logged or kept by the window.
 * @param {AgentChatWindow} chat
 * @param {AgentProviderConfig} provider
 */
export function askKey(chat, provider) {
  if (!chat.opened) chat.open();
  chat.clearKey();
  chat.keyFor = provider;
  chat.view = "key";
  chat.listed++;
  chat.render();
  /** @type {HTMLInputElement} */ (chat.keyInput).focus();
}

/**
 * Esc in the key field: back to the transcript, which empties the field.
 * @param {AgentChatWindow} chat
 */
export function cancelKey(chat) {
  chat.insert();
}

/**
 * The field holds a key only while it is typed: any way out of it empties it (M46).
 * @param {AgentChatWindow} chat
 */
export function clearKey(chat) {
  if (chat.keyInput) chat.keyInput.value = "";
  chat.keyFor = null;
}

/** @param {AgentChatWindow} chat */
export async function storeKey(chat) {
  const field = /** @type {HTMLInputElement} */ (chat.keyInput);
  const provider = chat.keyFor;
  // Out of the field at once: it holds the key only while it is typed.
  const key = field.value.trim();
  field.value = "";
  if (chat.storing) {
    chat.host.say("agent: a key is still being stored; enter this one again once it is", true);
    return undefined;
  }
  if (!provider) return chat.insert();
  if (!key) {
    chat.host.say(`agent: ${provider.name} needs an API key`, true);
    return undefined;
  }
  // One store at a time: a second Enter while this one runs neither errs nor races it.
  chat.storing = true;
  chat.keyFor = null;
  // Login storage can wait on the keyring. A user who leaves the field meanwhile still has
  // the key stored, as Enter asked, but the view and the conversation's model stay as they
  // are: they may be typing another provider's key, which the transcript would empty.
  const shownAt = chat.listed;
  let hint;
  try {
    await chat.services.keys.set(provider.name, key, provider.endpoint);
    hint = await chat.services.keys.hint(provider.name, provider.endpoint);
  } catch (e) {
    // The error's text is not shown: it could carry what was typed.
    console.error("vimma agent: the key could not be stored", /** @type {any} */ (e)?.name);
    chat.host.say(`agent: the key for ${provider.name} could not be stored`, true);
    // Typed again only by a user still in the field.
    if (chat.listed === shownAt) chat.keyFor = provider;
    return undefined;
  } finally {
    chat.storing = false;
  }
  // A user who clicked away (a page, the address bar) keeps their focus, and the model too;
  // the emptied key field, for no provider now, gives way to the transcript, unfocused.
  const stayed = chat.listed === shownAt && chat.focused;
  if (stayed) {
    chat.useProvider(provider);
    chat.insert();
  } else if (chat.listed === shownAt) {
    chat.toTranscript({ focus: false });
  }
  // Its provider is kept either way, so that the stored key has one after a restart.
  const note = await chat.remember(provider);
  const failed = note.startsWith(";");
  // The model and the key's end only, never the key (M46).
  const what = `${provider.name} · ${provider.model}`;
  // A key asked for the shown conversation's own model (a send's) leaves nothing to pick.
  const own =
    chat.conversation !== null &&
    sameProvider(chat.services.chat.get(chat.conversation).provider, provider);
  const unchanged =
    stayed || own
      ? ""
      : failed
        ? `; the model was left as it was: add ${what} in :agent model again to use it`
        : `; the model was left as it was: pick ${what} in :agent model to use it`;
  chat.host.say(`agent: ${provider.name}: ${hint ?? "key stored"}${note}${unchanged}`, failed);
  return undefined;
}

/**
 * `x` on a provider in the picker: its stored key goes, after a y (Behaviour 3).
 * @param {AgentChatWindow} chat
 */
export function deleteKey(chat) {
  const p = chat.rows[chat.row]?.provider;
  if (!p) return;
  chat.host.ask(`Delete the API key of ${p.name}? y/N`, () => {
    chat.services.keys.delete(p.name).then(
      (/** @type {boolean} */ had) => {
        chat.host.say(had ? `agent: deleted the key of ${p.name}` : `agent: ${p.name} has no key`);
        // Any model list shown, a picker opened again since included, since its hints were
        // read before the key went; setup's agent CLI list is left alone (issue #1001).
        if (chat.opened && chat.view === "models" && chat.listed === chat.modelsAt) {
          chat.reloadedAt = chat.listed;
          chat.loadModels();
        }
      },
      (/** @type {any} */ e) => console.error("vimma agent: deleting the key failed", e?.name),
    );
  });
}
