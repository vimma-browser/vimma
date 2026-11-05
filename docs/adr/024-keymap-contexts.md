# ADR-024: Keymap contexts: a key's binding can depend on the document

- Status: Accepted
- Date: 2026-11-04

## Context

Vimma's dispatcher maps a key to an action by mode alone: `dispatch(mode, chord)` looks the key up
in that mode's trie, and `[modal.<mode>]` tables merge user bindings over the defaults per mode
([m0-core-dispatcher](../specs/m0-core-dispatcher.md)). No binding has depended on the page.

The PDF mode ([pdf-mode](../specs/pdf-mode.md)) gives keys zathura's meaning in Firefox's PDF
viewer: `d` is dual page there and half a page down on other pages, `r` rotates there and reloads
elsewhere. The tab is still in normal mode in the viewer: insert mode, hints, copy mode, `Esc`,
the status bar's `NORMAL` badge and every check of `mode === "normal"` in the host apply as on any
page. Only which binding a key has changes.

## Decision

1. **A context selects normal mode's trie.** The keymap builds one trie per mode, as before, and
   one more for normal mode in the `pdf` context. `trie(mode, context)` and
   `sequences(mode, context)` take the context, `page` by default; any other mode has the same
   trie in every context.
2. **The `pdf` trie is normal's with `[modal.pdf]` merged over it.** Every binding normal mode has
   (from `[keys]` and `[modal.normal]`, defaults and the user's) is in the `pdf` trie unless
   `[modal.pdf]` binds the same sequence, as `[modal.normal]` shadows `[keys]`. `[unbind] pdf`
   removes a binding only there; `[unbind] normal` removes it in both, since `pdf` inherits
   normal's. `[modal.pdf]` cannot bind the prefix, which works in every mode and context. A
   `[modal.pdf]` binding is listed with ` [pdf]` after its keys, as other modes' are.
3. **The dispatcher takes the context.** `dispatch(mode, chord, context)` resets a pending
   sequence and count when the context changes, as it does when the mode changes, so that a
   sequence started under one set of bindings never finishes under another.
4. **The host decides the context**, never the page: `pdf` only while the selected tab's top
   document has pdf.js's principal, as the parent sees it (pdf-mode decision 4 and
   `docs/security.md` section 18).
5. **Firefox's keys:** a chord bound only in `[modal.pdf]` counts as bound ("bound means off",
   [firefox-keys](../specs/firefox-keys.md) decision 2) in every tab, because the set of Firefox
   keys that are off is applied per window, not per tab.

## Consequences

- Contexts are not modes: nothing in the host that tests the mode changes, and the status bar
  still says `NORMAL` in the PDF viewer.
- A further context (another kind of document) is one name in `CONTEXTS` (`modes.mjs`), one table
  and one trie.
- `ctrl+b ?` and the generated bindings docs can show each context's bindings under their own
  heading, since every binding records where it applies.

## Alternatives rejected

- **A `pdf` mode replacing normal mode in the viewer**, because every host path that tests for
  normal mode would need a second case, and `Esc` and the mode badge would differ from other
  pages for no gain.
- **Branching in the host on the same action** (`G` meaning a page only in a PDF), because `d`,
  `r`, `H` and `L` would need two meanings under one action name, and `ctrl+b ?` could not show
  which meaning applies where.
