# Spec: m2-picker-rename

Status: implemented · Milestone: M2 (completes it) · Area: host
(`host/VimmaHost.sys.mjs`, `host/tab-labels.mjs`), UI (`ui/picker.mjs`, `ui/rename-prompt.mjs`)

## User story

As a user, `ctrl+b g` lists my tabs in an overlay: I move with `j`/`k` (or `ctrl+n`/`ctrl+p`),
press `/` and type a few letters of a title, URL or rename (Finnish letters exact first: `kä` puts
"Käyttäjät" on top, `ka` still finds it, lower), `Enter` goes to the tab and `Esc` backs out, the
page never seeing a key. `ctrl+b shift+t` (or `:tabrename name`) names the tab; the name replaces
the title in the status bar and the picker, survives a restart, and an empty name restores the
title.

## Scope

- **Goto picker** (`goto.picker`: `prefix+g`, `b` in normal mode, `:ls`): `ui/picker.mjs` `GotoPicker`, a modal
  `<dialog id="vimma-picker">` like the help overlay (same `showModal`, focus and close handling,
  `help-overlay.css` look in `picker.css`). Rows `li[role=option]` with `data-tab-id`,
  `aria-selected`, the tab number, the display label (rename > title > URL, core `displayLabel`)
  with core's highlight ranges as `<mark>`, and the URL's host. A query line shows `/query` in
  search mode. All logic is core `picker.mjs` (`pickerItems`, `openPicker`, `pickerKey`,
  `setPickerItems`); the UI only renders the state.
- **Keys.** While the picker is open the host gives it every key (`formatKey(chord)` to
  `pickerKey`) and consumes each one, bare keys included, before the dispatcher sees it: the
  picker's `j`, `/`, `q` are not keymap bindings, so they cannot go through `help`-mode bindings.
  The status bar shows `HELP`, the mode of a modal overlay (no new core mode for M2).
- **Items now (M3 seam).** One pseudo-workspace: the window's `selectableTabs` (visible tabs, the
  same order `ctrl+b 1..9` counts), tab ids `tab.linkedPanel`. `pickerWorkspaces(win)` in the host
  (now `host/goto.mjs`) is the one place M3 replaces with its workspace model (every workspace's
  tabs).
- **Tab rename** (`tab.rename`: `prefix+shift+t`, `:tabrename [name]`): with text (`:tabrename
foo`, the command line's text side channel) the label is set directly; without, a one-line
  prompt `ui/rename-prompt.mjs` (`div#vimma-rename`, the command line's panel, row, prompt and
  input styling) opens at the window's foot, prefilled with the current label and selected.
  `Enter` applies (empty clears), `Esc` or focus leaving cancels, a tab switch closes it.
- **Labels** (`host/tab-labels.mjs`): `getTabLabel(tab)` / `setTabLabelOf(tab, text)` over
  `SessionStore.setCustomTabValue(tab, "vimma.tabLabel", label)`, normalised by core's
  `normalizeTabLabel` (bidi and format characters stripped, whitespace collapsed, 100 clusters);
  an empty result deletes the value. SessionStore restores custom values with the tab (restart,
  undo close, `setTabState`). The status bar's `labelFor` reads it; it re-renders on
  `SSTabRestoring` too, so a restored label shows without a tab switch. (Since changed: the
  labels are `workspaces/tab-labels.mjs`, in the folder of the snapshot that saves them,
  ADR-026.)

## Tests (written first)

- `tests/browser/browser_vimma_picker.js`: `ctrl+b g` from a page lists every tab with number,
  label and host, the current tab selected; `j`/`k`/`ctrl+n`/`ctrl+p` move; `/kä` ranks
  "Käyttäjät" first with `<mark>Kä</mark>`; `/ka` lists it after "Kalenteri"; `Enter` selects
  that tab and closes; `Esc` in browse closes and focus returns to the page; the page records no
  key throughout; `q` closes; `:ls` and `b` open it; a tab switch underneath closes it.
- `tests/browser/browser_vimma_rename.js`: the prompt (focused, prefilled); `Enter` sets the label
  (status bar `title` segment, the picker row, `SessionStore.getCustomTabValue`); an empty name
  clears it (title back); `Esc` cancels; bidi/format characters stripped; `:tabrename foo` sets
  it and `:tabrename` alone opens the prompt; the label survives `getTabState` → `setTabState`
  onto a fresh tab (a SessionStore restore) and shows in the status bar.
- `browser_vimma_help_overlay.js`: the "marked not yet" rows swap `rename_tab` and `goto_picker`
  (now built) for `workspace_picker` and `rename_workspace`; the assertion is unchanged.

## Out of scope

Workspaces in the picker (M3: sections, `left`/`right` jumps, the "moving reopens" warning),
M3's snapshot `tabLabels` (it takes over persistence; see Settled), the side panel, a picker
badge colour in the theme.

## Settled (2026-10-09)

- **Current window only** until M3: plan §2 says "every tab, all workspaces"; there are no
  workspaces yet, and a tab in another window is not selectable by `gBrowser`. M3 replaces
  `pickerWorkspaces`.
- **Persistence via SessionStore custom tab values now; M3's snapshot later.** m2-core-logic
  decided `tabLabels` in snapshot v1; the snapshot is written by M3's workspace persistence, which
  does not exist yet. `host/tab-labels.mjs` is the one seam: M3 reads the custom values once into
  its `TabLabels` (core `readTabLabels`), then writes the snapshot field and drops the custom
  value.
- **A prompt, not the command line,** for `prefix+shift+t`: prefilling `:tabrename <label>` would
  leave no way to clear (`:tabrename` alone means "prompt"). The prompt reuses the command line's
  classes; its input is a chrome text field, so the host is in `insert` and keys type.
- **The status bar test** asserted `#browser` is the bar's previous sibling; with the prompt row
  (zero height, like the command line's) it now skips our zero-height rows and asserts each has
  no height, then `#browser`.
- **Verified:** red (tests, no picker or prompt): picker 23/32 (9 unexpected: no dialog, `q` and
  `/` reached the page, `:ls` timed out), rename 13/18 (5: no prompt, `:tabrename foo` set
  nothing). Green: picker 56/56, rename 30/30, help overlay 62/0; full
  `tests/browser/` 1456/0 on the artifact build. Mutation: `setTabLabel` storing the raw text
  (`text || normalizeTabLabel(text)`) fails "format characters gone, spaces collapsed"; reverted.
