# Spec: tab-line

Status: accepted · Area: `packages/vimma-core/src/ui/tabline.mjs` (new), `statusbar.mjs`,
`actions.mjs`, `defaults.mjs`, `config.mjs`, `cmdline.mjs`; `ui/tabline.mjs` (new),
`ui/statusbar.mjs`, `host/VimmaHost.sys.mjs`, `host/window-state.mjs`, `host/runners.mjs`,
`config/ConfigHost.sys.mjs`, `browser/themes/shared/vimma/tabline.css` (new) · Upstream patches:
none · ADR: none

Issue: [#1289](https://github.com/vimma-browser/vimma/issues/1289)

Builds on the status bar of [m2-statusbar-whichkey](m2-statusbar-whichkey.md), the hidden tab
strip of [m0-tabstrip-hidden](m0-tabstrip-hidden.md), the hidden toolbar of
[toolbar-toggle](toolbar-toggle.md), the side panel of [m3-workspaces](m3-workspaces.md) and the
hint labels of [m1-hints](m1-hints.md). Engine paths are relative to `engine/` and were checked
against Firefox 160.0.1.

## Summary

An optional tab line: one row of text at the top of the window that lists the current
workspace's tabs, as Vim's `tabline` lists its tab pages. `gb` puts a hint label on every tab in
the line, and one more key goes to that tab. The line is a picture of the tabs, not a panel: it
never takes focus or keys, so the page keeps every key it had. It is off by default and turned on
with `[ui] tabline` in `config.toml` or `:tabline`.

## Problem

- Vimma hides Firefox's tab strip ([m0-tabstrip-hidden](m0-tabstrip-hidden.md)). The only
  always-visible trace of the other tabs is the status bar's `tab 2/6` and the current tab's
  title. Which tabs are open, and which number each has for `alt+4` or `4gt`, takes the side
  panel (`ctrl+b b`) or the tab picker (`b`), and both take the keyboard until closed.
- Jumping to a tab past the ninth takes a count the user has to know (`12gt`) or a picker.
- Users coming from Vim, tmux or a tabbed browser expect a glance at the tabs to cost nothing.

## Behaviour

1. `[ui] tabline` in `config.toml` sets the line: `"off"` (the default) draws nothing,
   `"always"` draws it in every browser window, `"auto"` draws it only while the current
   workspace has two tabs or more. A change of that line in the file applies at the next read.
2. `:tabline` shows the line if the window does not draw it, and hides it if it does, in every
   window, until restart or until the `[ui] tabline` line changes in `config.toml`.
3. The line is the top row of the window. With the toolbar shown the window reads, top to
   bottom: tab line, address bar, page, status bar. With the toolbar hidden (`ctrl+b u`) the
   address bar goes away under the line: the line stays where it was, and the page starts under
   it. A revealed address bar (`I`, a permission prompt) shows under the line, over the page.
4. It lists the current workspace's tabs, in tab order, numbered as the side panel numbers them
   (the numbers `alt+N`, `ctrl+b N` and `{N}gt` take). A private window lists its own tabs; the
   agent workspace lists its own. No other workspace's tab is ever listed.
5. Each entry is the tab's number and its name: the tab's rename (`ctrl+b shift+t`) if it has one,
   else its title, else its URL, cut to `[ui] tabline_width` columns (default 14) with `…`: a
   tab with no title shows its URL as its name, as the side panel does. A tab
   playing sound ends with `♪`. A tab shown in a pane of the shown split has `▪` after its number.
   No favicons.
6. The current tab is drawn as a solid block in bold, as the side panel's active row, with its
   number in the accent colour, so it stands out without colour too.
7. When the entries do not fit, the line keeps the current tab in view, shows as many of its
   neighbours as fit, and shows `‹n` at the start and `n›` at the end for the `n` tabs hidden on
   each side. Numbers of two and three digits (tab 12, tab 120) are drawn whole and counted in
   the fit, in the entries and in the marks.
8. `gb` in normal mode puts a hint label (from `[modal] hint_chars`) before every tab in the line
   and shows the line if it was not drawn. Labels are the link hints' prefix-free labels over the
   same alphabet, drawn in the link hints' case, so with more tabs than letters they take two
   letters or more (30 tabs over the default nine letters take two, 120 take three). Every tab
   gets a label, and a label always keeps its tab's number beside it (`AS 12`): when they do not
   all fit, the names go first, and if the labels and numbers alone still do not fit, the line
   shows a run of them from the first tab, with the `n›` count. Each letter typed narrows the
   line to the tabs whose label it starts, which then show the letters still to type, and the
   tabs one letter from being chosen come first; with 70 columns or more and the default nine
   hint characters, every tab is in view before its last letter, including a tab that was
   scrolled out of view. With many tabs, `{N}gb` and `{N}gt` go to a tab by the number the line
   shows, and tab search (`b`, `:b name`) finds one by name. A letter typed with Shift or Caps Lock is that letter. Typing a
   whole label goes to that tab and removes the labels. `Backspace` takes back the last letter,
   and with none typed removes the labels. `Esc`, or any other key that is not the next letter
   of a label, removes the labels and does nothing else. The mode badge says `HINT` meanwhile.
9. `{N}gb` goes to tab `N` at once, with no labels, as `{N}gt` does, for any `N` (`12gb`,
   `120gb`). A number past the last tab moves nothing and the notice says so:
   `no tab 12: this workspace has 5 tabs`.
10. `alt+1`..`alt+9`, `ctrl+b 1`..`ctrl+b 9`, `gt`, `gT` and the side panel are unchanged.
11. `[statusbar] tab = false` drops the status bar's `tab 2/6` and title segments while the
    window draws the tab line, since the line shows both. Left out, it is `true`, and the status
    bar is unchanged. The URL segment is never dropped.
12. The line never takes focus, never takes a key, and does nothing on a click, a drag or the
    wheel. Pages keep every key they had.
13. The line takes its colours and font from Vimma's theme: the status bar's background and
    text colours, the accent for the current tab's number, the hint label colours for labels.
    It follows a theme change at once.
14. A screen reader is not told each change of the line. After a `gb` jump the status bar's live
    region says the tab's place, as "tab 4 of 6".
15. The line hides in the page's own full screen (a video) and in customize mode, as the status
    bar does, and with Firefox's toolbox in browser full screen (`F11`).
16. The `ctrl+b ?` overlay and `docs/bindings.md` list `gb` and `:tabline` from the keymap, so a
    remapped key shows as remapped.

## Research

### Where Firefox's chrome sits

- `browser/base/content/navigator-toolbox.inc.xhtml:5` opens `<toolbox id="navigator-toolbox">`,
  whose rows are the menu bar (`#toolbar-menubar`, line 9), the tab strip (`#TabsToolbar`, line 24) and the navigation toolbar (`#nav-bar`, line 109). The toolbox is the box above `#browser`.
- Vimma hides `#TabsToolbar` (`src/browser/themes/shared/vimma/tabstrip.css`, keyed on the root
  attribute `vimma-tabstrip-hidden` that `ui/tabstrip.mjs` sets).
- `src/browser/themes/shared/vimma/toolbar.css` hides `#nav-bar` for `ctrl+b u`. It takes the bar
  out of the flow (`position: absolute; inset-inline: 0`, no `top`), so the bar keeps its static
  position when it is revealed over the page, and `#navigator-toolbox` gets `overflow: visible`
  and `position: relative`. A row placed in the toolbox's flow before `#nav-bar` therefore stays
  in the flow when the bar is hidden, and a revealed bar's static position is just under it.
  That is the layout of Behaviour 3 with no change to the toolbar's rules.
- Browser full screen collapses the toolbox (`FullScreen.hideNavToolbox`,
  `browser/base/content/browser-fullScreenAndPointerLock.js:1138`), and with it any row inside.

### What Vimma already draws

- The status bar: `packages/vimma-core/src/ui/statusbar.mjs` turns a `StatusInput` into
  segments with theme token names and fits them to a width in columns (`fitStatus`, with
  `truncate` and `textWidth` from `text/textwidth.mjs`, which count East Asian wide characters as
  two columns). `ui/statusbar.mjs` renders it at most once per frame, measures the bar's width
  and one column of its font with a `ResizeObserver` (never on the render path), and redraws on
  `TabSelect`, `TabOpen`, `TabClose`, `TabMove`, `TabAttrModified`, `TabShow`, `SSTabRestoring`
  and the host's state changes (`VimmaHost.onStateChange`). Its `tab` segment is
  `tab {index}/{count}` and its `title` segment the tab's `displayLabel`.
- The side panel: `packages/vimma-core/src/ui/sidepanel.mjs` `openPanel` lists the active
  workspace's tabs (`model.workspaces[active].tabs`, in window order) as rows with `number`,
  `display` (`workspaces/tablabels.mjs` `displayLabel`: rename, else title, else URL), `active`,
  `playing` and `split`, and the shown split's tabs as `panes`. The host feeds it from
  `host/window-state.mjs`: `model` (with `privatePanel` for a private window), `info` (title,
  URL, rename, `tab.soundPlaying`, which `browser/components/tabbrowser/content/tab.mjs:303`
  defines) and `split` (`shownSplit`). Reusing these makes the line's numbers, names and
  membership the side panel's by construction.
- Tab numbers: `host/tab-ops.mjs` `selectTab` resolves `tab.goto` and a counted `tab.next`
  through core `workspaces/tabs.mjs` `tabTarget` over `gBrowser.visibleTabs`
  (`browser/components/tabbrowser/Tabbrowser.sys.mjs:631`), which in a window with workspaces
  are the active workspace's tabs, in the same order as the model's.
- Hint labels: `packages/vimma-core/src/page/hints.mjs` `hintLabels(n, chars)` gives the `n`
  shortest prefix-free labels over `[modal] hint_chars` (default `asdfghjkl`). Page hints run
  through `hintKey`, which ignores a key that is not a label character; the tab line's labels
  instead cancel on one (Behaviour 8), so they get their own key function. Labels are drawn
  with `--vimma-hint-bg` and `--vimma-hint-fg` (`hints.css`).
- Modes: `keys/modes.mjs` `MODES` is a closed set; `hint` is in `KEY_KEEPING_MODES`, so the
  agent question, the update question and Firefox's permission prompts stand back while it is
  on. `VimmaHost._mode` reports `hint` while a page hint session is on its page.
- Keys: `gb` is bound in no table of `config/defaults.mjs` (`modal.normal` binds `b`, `gt`, `gT`,
  `gi`, `gu`, `gU`, `gf`, `gF`, `gg`; `modal.pdf` binds no `g` key but `gg`), and no `[keys]`
  chord starts with `g`. `b` alone is the tab picker; `gb` is a separate two-key sequence after
  `g`, as `gt` is beside `t`.
- Config: `[ui]` holds `toolbar`, `bookmarks_toolbar` and `pdf_outline`
  (`config/config.mjs` `UI_KEYS`); `[ui] toolbar` is applied by `config/ConfigHost.sys.mjs` only
  when its value changes, so `ctrl+b u` lasts until restart or until that line is edited
  ([toolbar-toggle](toolbar-toggle.md) decision 4). There is no `[statusbar]` table yet.

### Other tools

- Vim 9.1 (`:help tabline`, `:help 'showtabline'`): `showtabline` 0 never, 1 only with two or
  more tab pages, 2 always; the current tab page is highlighted with `TabLineSel`, the rest with
  `TabLine`. Vimma's `off`, `auto` and `always` are those three.
- tmux 3.5 (`man tmux`, `window-status-format`, `window-status-current-format`): the status line
  lists windows as `index:name`, the current one in its own style, and scrolls the list around
  the current window when it does not fit, with `<` and `>` marks.

## Design

`packages/vimma-core/src/ui/tabline.mjs` (new, pure) decides what the line says: which entries,
their text, how they fit a width, the labels and the label keys. `ui/tabline.mjs` (new) renders
it into one `<div id="vimma-tabline">` inside `#navigator-toolbox`, right before `#nav-bar`, with
the status bar's way of measuring and drawing. The host hands the line the side panel's sources
(model, tab info, shown split), so the line and the panel cannot disagree.

### Decisions

1. **A top row, not a status bar segment.** The line is its own row at the top of the window, as
   Vim's tabline is, because the status bar is already full with the mode, the keys being
   typed, the workspace, the URL and the cues of a hidden toolbar, and tab names there would be
   cut to a few columns. Rejected: the tab list inside the status bar (tmux's style), because it
   would fight the URL, the security cues and the downloads for the same columns; a column of
   numbers at the left edge, because numbers without names say little and it narrows every
   page; tabs and the address field sharing one row (Safari's compact layout), because the
   field would move as tabs open and close.
2. **Above the address bar, and it never moves.** The line is the first row in
   `#navigator-toolbox` before `#nav-bar`, so the order is tab line, address bar, page, status
   bar, where Firefox's own tab strip was. With the toolbar hidden, `toolbar.css` takes `#nav-bar`
   out of the flow, so the line stays at the top and the page starts under it, and a revealed
   address bar appears under the line, because its static position is there. Rejected: the
   line under the address bar, because `ctrl+b u` would then move it up a row and the eye would
   have to find it again.
3. **Off by default, three settings.** `[ui] tabline` takes `"off"`, `"always"` and `"auto"`
   (only with two tabs or more), as Vim's `showtabline` takes 0, 2 and 1, and it is `"off"`
   until use shows whether it should be on, since it costs every page one row (20 px). Rejected:
   a boolean, because `"auto"` keeps a lone tab's window free of an empty-looking line.
4. **The setting lives in `[ui]`, beside `toolbar`.** `[ui]` holds the window's rows of chrome
   (`toolbar`, `bookmarks_toolbar`), and the line is one, so `tabline` goes there. The width of
   a name is `[ui] tabline_width` rather than `tab_width`, because every key in `[ui]` names the
   surface it sets, and `tab_width` alone would read as a property of tabs everywhere (the side
   panel, the pickers). It takes 4 to 60 columns, default 14, so that a name stays readable and
   one tab cannot fill the line.
5. **A pref carries the state, applied as `[ui] toolbar` is.** `vimma.ui.tabline` (`"off"`,
   `"always"` or `"auto"`) is read by every window and observed, so `:tabline` in one window
   changes every window at once, as `ctrl+b u` does. `ConfigHost` writes it only when the
   file's `[ui] tabline` value changes, so a `:tabline` toggle lasts until restart or until that
   line is edited, as with `[ui] toolbar` ([toolbar-toggle](toolbar-toggle.md) decision 4).
6. **`:tabline` flips what is seen.** In a window that draws the line it sets `"off"`; in one
   that does not it sets `"always"`, so the command always changes what the user sees, even
   under `"auto"` with one tab, where setting `"off"` would change nothing visible. Rejected:
   cycling the three settings, because two of the three steps can look the same.
7. **The side panel's list, numbers and names.** The entries are the rows of core
   `openPanel` for the window's model, built from the same `model`, `info` and `split` sources
   as the side panel's (`host/window-state.mjs`), so a tab's number in the line is the one
   `alt+N`, `{N}gt` and the panel use, a private window and the agent workspace list only their
   own tabs, and a rename shows in both at once. Rejected: reading `gBrowser.visibleTabs`
   directly, because the panel's private-window and workspace rules would then be written twice.
8. **Entries are text, cut to a fixed width.** An entry is `{number}{▪}{name}{ ♪}` with one
   column of padding on each side; the name is cut with `…` to `tabline_width` columns by core
   `truncate`, which never splits a grapheme cluster and counts wide characters as two columns.
   No favicons, because the line is a row of text in the bar's font, and an image would set its
   height and draw page-supplied pixels in chrome.
9. **The current tab as a bold block, its number in the accent colour.** The current entry is a
   block of `--vimma-selection` with its text in `--vimma-fg-bright` and bold, and its number in
   `--vimma-text-accent`, the side panel's active row, because the block and the weight mark it
   without relying on colour (m7-a11y: no meaning by colour alone), and every one of those pairs
   is covered by the theme's contrast check (`packages/vimma-core/src/config/theme.mjs`
   `TEXT_TOKENS` on `SURFACE_TOKENS`, enforced for chrome CSS by `tools/test/chrome-css.test.ts`).
   Rejected: reverse video (the bar's colours swapped, the number in the accent), because the
   accent on the bar's foreground colour is a pair no theme check covers, and a theme whose
   accent is close to its foreground would draw the number unreadable.
10. **Overflow keeps the current tab in view.** When the entries are wider than the line, core
    picks the run of entries around the current tab: it adds neighbours one at a time, right
    then left, while they fit with the `‹n` and `n›` marks for the tabs still hidden, so the
    current tab is always shown and the hidden counts are exact. Rejected: scrolling to keep the
    current tab at one edge, because every switch would then move the whole line.
11. **Splits: one line per window.** The line belongs to the window, not to a pane, since the
    window has one tab list; tabs shown in a pane of the shown split get `▪` after their
    number, as the side panel marks them.
12. **`gb` labels the line, with its own key rule.** `gb` (Vim's "go to buffer" mnemonic, free in
    every table) starts a label session on the line: core assigns `hintLabels(count,
hint_chars)` in tab order, and the host reports mode `hint` while the session lasts, so the
    mode badge, `KEY_KEEPING_MODES` and the permission prompts' stand-back work unchanged.
    Every key goes to the session first and is consumed: a label's next character narrows, a
    whole label goes to that tab, `Backspace` takes back the last character (or cancels with
    none), and any other key, Esc included, only cancels. A letter keeps its meaning with Shift
    or Caps Lock, which deliver it lower case with `shift` set (`keys.mjs` normaliseKey), as
    `hintKey` reads it, so a user with Caps Lock on can still jump. Backspace erases rather
    than cancels because it does so in link hints, and the same hand habit should work in both.
    The labels take the link hints' case from the same rule (core `tabLabelCase`, over
    `hintLabelCase`), upper case by CSS `text-transform` with the text left as typed, so a
    change to how hints are drawn reaches both.
    Rejected:
    page hints' rule of ignoring other keys (`hintKey`), because the session sits in a row the
    user is not looking at for long, and a stray key should end it rather than leave it waiting;
    passing the cancelling key on to its binding, because a mistyped label would then run an
    unrelated command.
13. **Labels reach every tab, and keep the tab's number.** While labels show, the names shrink
    first (the widest width at which every tab fits); if even no names do not fit, each entry is
    its label and its number (`AS 12`), and a run of them is drawn from the first tab whose
    label still matches, with the `n›` count. The number stays because a label alone says
    nothing about which tab it is: a row of `A S D F JA JS …` cannot be read against the tabs
    the user knows, while `A 1 S 2 … JA 7` can, and the number is the one `{N}gb` and `{N}gt`
    take. The run starts at the first matching tab because labels go shortest first in tab
    order (`hintLabels`), so the tabs one letter from being chosen are the first ones listed
    and so in view after each letter: at most nine entries of up to seven columns
    (`A 120`) and the count, so at 70 columns and more with the default nine hint characters
    every tab is in view before its last letter; narrower, the room goes to the tabs one letter
    away. The labels show only the letters still to type, since the typed ones have already
    narrowed the line; the typed letters drawn underlined (the link hints' way) were too faint
    to read at the bar's 12 px size. Rejected: labels alone without the number, because the
    line then no longer tells the tabs apart; labels only on the visible entries, because a
    tab scrolled out of view would then need a second step; keeping the run around the current
    tab while labelling, because it could hide the tabs one letter away.
14. **`gb` shows a hidden line for the session.** With the line off, `gb` draws it while its
    labels show and removes it after, so the key works under the default `"off"` and costs no
    row until used. Rejected: refusing with a notice, because `gb` would then do nothing out of
    the box.
15. **`{N}gb` goes straight there.** With a count, `gb` runs `tab.goto` with that number, as
    `{N}gt` does (core `tabTarget`), because a user who reads the number in the line has no
    need for a label. The count is the tab's number, not a label, and any number works (`12gb`).
    A number past the last tab moves nothing and the notice says
    `no tab 12: this workspace has 5 tabs`, so that a count typed against a line that has
    scrolled is not mistaken for a key that did nothing; `{N}gt` stays silent as before.
16. **`[statusbar] tab`.** A new `[statusbar]` table with one key, `tab` (default `true`):
    `false` drops the status bar's `tab` and `title` segments while the window draws the line,
    since the line shows both. It never drops the URL segment, because with the toolbar hidden
    the URL is the origin indicator (docs/security/06-chrome-ui-rendering.md C3). With the line
    not drawn the segments stay, so the window never loses the tab's place.
17. **No focus, no keys, no mouse in this version.** The line is a `<div>` with no tab stop,
    no key handler and no pointer handler, so it cannot take focus from the page or a key from
    the dispatcher, and a click on it does what a click on an empty toolbox does. A click to
    select a tab is left for later, because a pointer target in a row of 14-column entries
    needs its own design (drag, middle-click close) and the keys cover selection.
18. **Accessibility: speak the switch, not the list.** The line has `aria-label="Tab line"` and
    is not a live region, because re-reading the list on every title change would bury
    everything else a screen reader says. After a `gb` or `{N}gb` jump the status bar's live
    region says "tab N of M", the new place, which the status bar's own policy allows since it
    is no page text; the same words twice in a row get a no-break space at the end, so that the
    second jump is said too. `♪` and `▪` have their words ("playing sound", "in a pane") beside them for
    assistive technology, as the status bar's glyphs do.
19. **Theme and font from Vimma's tokens.** `tabline.css` uses only `--vimma-*` tokens and the
    status bar's font and height (`--vimma-font`, 12 px, 20 px), so the line follows the
    Omarchy theme and the built-in palettes, light and dark, and a theme switch, like the status
    bar. It hides where the status bar hides (`[inDOMFullscreen]`, `[customizing]`), and with
    the toolbox in browser full screen, because it is part of the toolbox.
20. **Rendering costs one frame at most.** The line redraws at most once per animation frame,
    on the tab events the status bar listens to, the host's state changes, the window's
    workspace changes and the pref. A fit is linear in the tabs: each name is measured once
    (printable ASCII without grapheme segmenting), the names' shrink width is found by
    bisection, the run of tabs in view grows with a running sum, and only the names drawn are
    cut, so 300 tabs with labels fit in well under a millisecond. With the line off, or under
    `"auto"` with one tab, and no labels showing, a redraw reads only the window's tab count
    and builds no rows. Its width is the toolbox's and its column a probe beside it, both from
    a `ResizeObserver` that keeps the last width while the toolbox is collapsed, so the render
    path reads no layout and `gb` on a line that is off fits at the real width at once. A
    redraw that would draw the same entries touches no DOM.

### Data flow

1. `ui/tabline.mjs` builds the row on `DOMContentLoaded` and observes `vimma.ui.tabline`.
2. On each frame it was asked for, it asks the host for the panel's rows (`openPanel` over the
   window's model, info and split), and core `tabLineShown(setting, count, labelling)` decides
   whether to draw. Core `tabLineEntries(rows)` makes the entries, and `fitTabLine(entries,
{ width, nameWidth, labels })` returns what to draw: the entries in view, each with its cut
   name, and the hidden counts on each side.
3. `gb`: the host runs action `tabline.hint`. With a count, `tab.goto`. Otherwise it asks the
   line for its tab ids in order, core `startTabLabels(ids, hint_chars)` makes a session, the
   host keeps it in the window's state and reports mode `hint`. Each key goes to core
   `tabLabelKey(session, chord)`: `narrow` redraws, `select` selects that tab and announces it,
   `cancel` ends the session.

## Security and privacy

- The line draws tab titles and renames in chrome. They are page-controlled text: they are set
  with `textContent`, never as markup, cut to a fixed width, and drawn in the bar's font and
  colours, so a page cannot style or script them. The current tab is marked by Vimma's own
  colours, not by anything the page sets.
- A URL shows in the line only as the name of a tab with no title, cut to `tabline_width` like
  any name. The line is not an origin indicator and makes no claim about where a page comes
  from; the status bar's URL segment stays the origin indicator
  (docs/security/06-chrome-ui-rendering.md C3), and it is kept even with `[statusbar] tab =
false`.
- It lists only the window's current workspace's tabs, from the same model as the side panel, so
  an agent's tabs show only while the user is in the agent workspace, and a private window shows
  only its own tabs.
- `gb` labels are typed in the window, not sent to any page; a session ends when a key is not a
  label, so no page can keep the window in hint mode.
- No new control socket command, pref read by content, or network access.

## Tests

vitest (`packages/vimma-core/test/tabline.test.ts`):

- `tabLineShown`: off, always, auto with one and two tabs; labelling shows an off line.
- `tabLineEntries`: numbers from 1 in row order, rename over title, `♪` for playing, `▪` for
  pane tabs, the current tab marked.
- `fitTabLine`: everything fits; names cut to the width with `…` and wide characters counted as
  two columns; overflow keeps the current tab in view at the start, middle and end, with exact
  `‹n` and `n›` counts; 30 and 120 tabs with the current tab first, at 12, in the middle and
  last, numbers of three digits counted whole; a property over up to 150 tabs with names of wide CJK characters, ZWJ emoji, flags and
  combining and precomposed accents, random pane and sound marks, any width: the current tab
  shows, counts add up, the line is never wider, and no hidden neighbour would fit; a width too small for one entry still shows the
  current tab cut.
- Labels: one label per tab in tab order from `hint_chars`; with 30 and 120 tabs every label is
  different, two and three letters long, and typing each tab's label reaches that tab, the
  line holding only the matching tabs after each letter; with labels, names shrink before
  any tab is hidden; after a typed character, only matching tabs are fitted.
- `tabLabelKey`: a one-character label selects; a two-character label narrows then selects;
  Shift letters (Caps Lock) select and narrow as plain ones; Backspace takes back a letter and
  with none typed cancels; Esc, a non-label character, a ctrl or alt chord and a digit cancel.
- Narrow lines: with names that do not fit, every entry is its label and its number, the run
  from the first tab; 30 and 120 tabs at 40, 60 and 110 columns: the run starts at the first
  matching tab, at 110 every tab is in view before its last letter, and narrower a tab out of
  view gives its room only to tabs one letter away; a property over up to 300 tabs with any
  names, marks, width and typed prefix: only matching tabs from the first, counts add up, never
  wider than the line, and no hidden neighbour would fit.
- A complexity check (`budget.ts`): fits of 3000 tabs, with and without labels, run within a
  budget that a fit quadratic in the tabs misses by far.
- config: `[ui] tabline` accepts the three words and refuses others; `tabline_width` bounds;
  `[statusbar] tab` boolean; an unknown `[statusbar]` key is an error; defaults.
- statusbar: `statusTab: false` drops `tab` and `title`, keeps `url`.
- `tabCountRefusal`: none for 12 of 120, the notice for 12 of 5 and for 2 of 1 tab.
- keymap: `gb` is bound to `tabline.hint` in normal mode and conflicts with nothing.

mochitest (`tests/browser/browser_vimma_tabline.js`):

- `off_draws_nothing`, `always_draws_the_workspace_tabs`: entries, numbers and order match the
  side panel's rows.
- `line_sits_above_the_address_bar`: with the toolbar shown the line's bottom is the nav bar's
  top; after `ctrl+b u` the line keeps its top and the page starts at its bottom.
- `auto_needs_two_tabs`: one tab hidden, a second tab shows it, closing it hides it.
- `config_reload_applies`: writing `[ui] tabline` turns the line on and off; `tabline_width`
  changes the cut; `[statusbar] tab = false` drops the status bar's tab segment.
- `tabline_command_toggles`: `:tabline` hides a drawn line in every window and shows it again.
- `gb_labels_and_jumps`, `gb_cancels_on_another_key`, `count_gb_jumps`: labels on every entry,
  a label key typed with Shift selects that tab and removes the labels, `x`, `Esc` and
  `Backspace` with nothing typed cancel without closing a tab,
  `4gb` selects tab 4.
- `gb_with_the_line_off`: the line shows for the session and goes after it.
- `overflow_keeps_the_current_tab`, once with 30 tabs and once with 120: the current tab's entry
  is in the line and the counts add up, numbers past 9 are drawn whole and in order, the last
  entry is not cut off, `12gb` goes to tab 12, and `gb` gives every tab a distinct label of
  several letters, by which a tab out of view scrolls in and is reached.
- `count_gb_jumps` also checks the notice for a number past the last tab.
- `private_and_agent_workspaces_list_their_own`: a private window and the agent workspace list
  only their own tabs, and back in the home workspace with an agent tab still open, the line
  lists none of the agent's tabs.
- `a_title_is_text_never_markup`: a page titled `<img src=x onerror=...><b>x</b>` shows that
  text, cut, with no element made from it.
- `split_marks_pane_tabs`: two tabs shown together carry `▪`.
- `never_takes_focus`: focus stays in the page after drawing, labelling and a click on the line.

## Docs and changelog

- `docs/guide.md`: a "Tab line" section under "Status bar", with the config lines, `:tabline`,
  `gb` and `{N}gb`, and a line in "Features at a glance".
- `docs/bindings.md` and `defaults.toml`: regenerated (`npm run gen-docs`) for `gb`, `:tabline`
  and the new `[ui]` and `[statusbar]` lines in the config template.
- `CHANGELOG.md`: written by release-please from the commit,
  `feat(ui): an optional tab line, with gb to jump to a tab`.

## Delivery

One pull request after this spec: core module and tests, the line, `gb`, `:tabline`, the config
keys, docs and the help snapshot. The line is off by default, so it needs no feature pref:
`main` stays releasable with it merged.

## Open questions

None.
