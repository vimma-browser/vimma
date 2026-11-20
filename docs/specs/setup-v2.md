# Spec: setup-v2

Status: implemented · Area: core
(`packages/vimma-core/src/system/setup.mjs`, `packages/vimma-core/src/system/setup-steps.mjs`,
`packages/vimma-core/src/config/toml.mjs`),
chrome (`src/browser/base/content/vimma/setup/` (`setup.html`, `setup.mjs`, `flow.mjs`,
`SetupHost.sys.mjs`),
`config/ConfigHost.sys.mjs`, `services/AppLauncher.sys.mjs`), theme
(`src/browser/themes/shared/vimma/setup.css`), prefs
(`src/browser/branding/vimma/pref/firefox-branding.js`) · Upstream patches: none · ADR: none

Issues: [#1290](https://github.com/vimma-browser/vimma/issues/1290) (tracking); slices
[#1292](https://github.com/vimma-browser/vimma/issues/1292),
[#1293](https://github.com/vimma-browser/vimma/issues/1293),
[#1294](https://github.com/vimma-browser/vimma/issues/1294),
[#1295](https://github.com/vimma-browser/vimma/issues/1295),
[#1296](https://github.com/vimma-browser/vimma/issues/1296),
[#1297](https://github.com/vimma-browser/vimma/issues/1297),
[#1298](https://github.com/vimma-browser/vimma/issues/1298),
[#1299](https://github.com/vimma-browser/vimma/issues/1299)

## Summary

`:setup` grows from two steps and a summary into a short, optional tour in chapters. Each step
asks one question, shows the `config.toml` line it will write, and saves that line the moment
the user presses `enter` on it. `q` or `esc` leaves at any point and keeps every step already
finished, so a user can stop after the essentials, or after any step, without losing what they
chose. The keys a step mentions are read from the keymap in force, so a user who rebinds a key
sees their own key.

## Problem

The setup of [first-run-setup](first-run-setup.md) offers two things, add-ons and the search
engine, and applies nothing until its summary is confirmed. That leaves three gaps:

- **Leaving loses work.** Closing the tab or pressing `esc` before the summary keeps nothing
  (first-run-setup, behaviour 6). Any longer setup built that way punishes the user for stopping
  half-way, which is the most common way to leave a tour.
- **The first choices people make are elsewhere.** The colours, the address bar shown or hidden,
  the prefix key, the hint letters for a non-QWERTY layout, the default browser, bringing
  bookmarks over and whether agents may connect are each a `config.toml` key, a command or a
  Settings page a new user has to find in the guide.
- **Key hints go stale.** The current page names its own page keys only, but any hint about
  Vimma's keys written into the page would be wrong for a user who rebound that key, and wrong
  for every later step once the prefix changes.

## Behaviour

### Leaving and saving

1. On the first start of a profile, the welcome screen is shown once, as today
   (first-run-setup, decision 1). `:setup` and the about:vimma link open it at any time.
2. The welcome screen **must** say, above its buttons, that the setup is optional, that it can
   be left at any time with `q` or `esc`, that only finished steps are saved to `config.toml`,
   and that `:setup` brings it back. It lists the chapters, each with its steps and, on a later
   run, a tick for each chapter finished before.
3. `enter` on the welcome screen starts at the first chapter; a digit `1` to `5` starts at that
   chapter (the chapters of the first version, decision 11). `q` or `esc` closes the page and
   changes nothing.
4. `enter` on a step **must** save that step at once: a setting step writes its key to
   `config.toml` and the change applies live, as any edit of the file does; an action step runs
   its action. Then the next step opens.
5. `s` on a step **must** move on without writing anything for that step, so its default stays
   in force.
6. `h` on a step returns to the previous step, with the value in force selected. `enter` there
   saves again, overwriting that one key, and the line it writes replaces the one listed for
   that step this run. A step that writes nothing on the way back (the value in force, **Keep**,
   or `s`) keeps the lines it saved earlier this run, since that write is still in
   `config.toml`; an action done earlier this run (an add-on installed, the default browser
   asked) stays listed, since it cannot be undone. Add-ons installed on a second pass are
   listed with those installed before, each once.
7. `q` or `esc` on any step or stop screen closes the page. Steps already saved stay saved;
   nothing is undone, and nothing for the open step is written. Closing the tab or the window
   does the same. In the content blocker step's search field, the first `esc` leaves the field
   and a second one leaves the page; `q` there is typed.
8. Choosing the value already in force **must** write nothing, so that `enter` through every
   step leaves `config.toml` unchanged. The comparison is made at `enter`, against the file as
   it is then (decision 4). The one exception is the hint letters step's layout guess: with the
   built-in QWERTY letters in force and keys pressed that fit Colemak or Dvorak, that layout is
   selected first, so plain `enter` writes `[modal] hint_chars`; the step shows that line
   ("Writes …") and the guess before `enter` (behaviour 26, decision 10).
9. Each step opens with the value in force selected: the value in `config.toml`, else the
   built-in default (or, for the colours and agents steps, the value `:theme` or `:mcp`
   remembered). For the colours step, the value in force is the effect: the palette and
   appearance the window shows (decision 12). When the value in force is none of the step's
   choices (a custom prefix or `hint_chars`, a search engine that is not installed), the step
   lists **Keep** with that value as its first choice and selects it; **Keep** writes nothing.
10. After the last step of each chapter, a stop screen lists what was saved in that chapter
    and names the next chapter. `enter` goes on; `q` or `esc` closes the page. After the last
    chapter, the stop screen says the setup is done, lists everything this run saved, and
    names `:setup` to come back; `enter`, `q` and `esc` close the page.
11. Every step and stop screen has a footer with the step's place in its chapter, the list of
    what this run saved so far, and the page keys: `j`/`k` choose, `enter` save and go on, `s`
    skip, `h` back, `q` leave.

### Writing `config.toml`

12. A setting step **must** show the exact line it will write for the selected choice (for
    example `[ui] toolbar = "hidden"`) before `enter`, and "Writes nothing" for **Keep** or the
    value in force. When `config.toml` is read again while the step is open, the step redraws
    that line from the new value in force. After `enter`, the footer reports what was actually
    written, or that nothing was (decision 4).
13. A `config.toml` that does not parse **must** never be written. The welcome screen names the
    file and line; setting steps show the same notice and only skip; action steps work.
14. An edit made to `config.toml` by another program while a step is open is kept: the step's
    edit applies to the file's text as it is at `enter`, changing only its own key.
15. In a private window, setting steps show that they cannot save there and only skip; action
    steps work.
16. A write that fails leaves the file as it was, shows the reason on the step, and keeps the
    step open.

### Keys named on the page

17. Every Vimma key a step names (outside the page's own `j`, `k`, `enter`, `s`, `h`, `q`,
    `esc`, `space`, `/` and digits) **must** come from the keymap in force: the defaults plus
    the user's `config.toml`. A rebound key shows as the user bound it; an unbound key is left
    out; an action with no key at all is named by its `:` command instead.
18. After the prefix step saves a new prefix, every later step shows keys with the new prefix.

### The steps of the first version

The chapters and steps below are the first version (decision 11): eleven steps in five
chapters, the tab line step among them (decision 15).
`Saves` is the `config.toml` line a setting step writes, or "action" for a step that does
something and saves nothing. Every setting step also offers **Keep** when the value in force is
none of its choices (behaviour 9).

| Chapter               | Step            | Choices                                                                                               | Saves                                                                      |
| --------------------- | --------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1. Essentials         | Content blocker | uBlock Origin, AdGuard AdBlocker, Privacy Badger, an AMO search; none                                 | action: installs the marked add-ons, each with Firefox's permission prompt |
|                       | Search engine   | the installed engines                                                                                 | `[search] default`                                                         |
|                       | Colours         | the Omarchy theme (only where found); "Vimma light", "Vimma dark", "Vimma, following the system"      | `[theme] appearance`, and `source` or `name` when needed (decision 12)     |
| 2. Moving in          | Default browser | make Vimma the default browser, or not now                                                            | action: the system's default browser                                       |
|                       | Bring your data | open the import wizard (Chrome, Chromium, Brave, Edge, Opera, Vivaldi); from Firefox, how to use Sync | action: Firefox's import wizard                                            |
| 3. The window         | Address bar     | shown, hidden                                                                                         | `[ui] toolbar`                                                             |
|                       | Tab line        | off, always, only with two or more tabs                                                               | `[ui] tabline` (decision 15)                                               |
| 4. Your keys          | Prefix key      | `ctrl+b`, `ctrl+a`                                                                                    | `[keys] prefix`                                                            |
|                       | Hint letters    | the home row of QWERTY (`asdfghjkl`), Colemak (`arstdhneio`), Dvorak (`aoeuidhtns`)                   | `[modal] hint_chars`                                                       |
| 5. Privacy and agents | Updates         | tell me when a release is out, or never check                                                         | `[updates] check`                                                          |
|                       | Agents          | off, or on for local AI agents through `vimma-ctl mcp`                                                | `[mcp] enabled`                                                            |

19. **Content blocker.** As step 1 of first-run-setup (curated list, `/` searches AMO, `space`
    marks), except that `enter` installs the marked add-ons there and then, one after another,
    each through Firefox's permission prompt, and the step reports each result before moving
    on. `enter` with nothing marked moves on.
20. **Search engine.** As step 2 of first-run-setup; `enter` writes `[search] default`. The
    engine is the one at the chosen place in the list the host sent the page; when that engine
    is no longer installed at `enter`, nothing is written and the step redraws with the current
    list.
21. **Colours.** The page itself takes the colours as soon as the step saves. The Omarchy choice
    is listed only where an Omarchy theme is found, and comes first. The other three are the
    appearances of Vimma's own built-in palette (`vimma`), and their labels say so: "Vimma
    light", "Vimma dark" and "Vimma, following the system". `vimma` is the only built-in palette
    (#1383), so a choice writes `name` only when another name is in force; a config.toml that
    still names a removed palette has `vimma` in force.
22. **Default browser.** Shows whether Vimma is the default browser now. `enter` on "make
    Vimma the default" asks the system through the same path as Settings' Make Default; when
    Vimma already is the default, the step says so and `enter` moves on.
23. **Bring your data.** `enter` on "import" opens Firefox's import wizard as a dialog over the
    setup tab; the next step opens when the dialog closes (decision 17). The step says that a
    Firefox profile is not in the wizard, and that Firefox data comes over with Firefox Sync
    (`:settings sync`).
24. **Address bar.** The step names every key bound to `focus_urlbar` and `toggle_toolbar` that
    works from a page (`ctrl+l`, `alt+d`, `I` and `ctrl+b u` with the default keymap), so that
    the user knows how to reach the address bar once it is hidden.
25. **Prefix key.** With each candidate prefix, the step shows the key that opens the list of
    keys (`show_keybinds`, `ctrl+b ?` with `ctrl+b`), drawn with that candidate (decision 8).
26. **Hint letters.** The layout the user types on is selected first (decision 10).
27. **Updates.** Says what the check sends (the update channel and the platform) and that
    "never check" stops every request to `updates.vimma.dev`.
28. **Agents.** "Off" is selected first unless agents are on. The step says, in two lines, that
    agents reach only the agent workspace, and that sending a form, paying and showing a page
    always ask the user. `enter` on "on" is the user's consent, as answering `y` to `:mcp on`
    is. The step also says that `:mcp off` turns agents off until Vimma restarts, whatever the
    file says and however often it is read again (decision 16). That `enter` is checked and
    applied as the yes is (decision 20).
29. Neither the control socket nor an MCP agent can open, read or drive the page (unchanged
    from first-run-setup, behaviour 10).

## Research

Firefox paths are in Vimma's engine tree at Firefox 160.0.1 (`surfer.json`,
`engine/config/milestone.txt`).

- **Today's setup.** `packages/vimma-core/src/system/setup.mjs` holds the state machine
  (`setupKey`: `welcome`, `addons`, `engine`, `summary`, `closed`) and `planSetup`, which
  returns a plan only from the summary. `setup/setup.mjs` draws the page and applies the plan;
  `setup/SetupHost.sys.mjs` does the AMO requests, the installs (`installAddonFromAOM`) and the
  `[search] default` write (`writeEngine`). The page's step text is static HTML
  (`setup/setup.html`: "Step 1 of 2", the hard-coded `enter` and `esc` hints).
- **The page owns its plain keys.** `VimmaHost._onKeyDown` returns early for any chord without
  ctrl, alt or meta while `about:vimma-setup` has focus (`host/VimmaHost.sys.mjs:1345-1353`), so
  `j`, `k`, `s`, `h`, `q` and digits reach the page, and a prefix chord stays Vimma's.
- **Config writers.** `SetupHost.writeEngine` writes through a temporary file and a rename, but
  it predates `ConfigHost`'s shared `rewriteConfig` (`config/ConfigHost.sys.mjs:508-583`, added
  with `:siteunbind --save` in #1269), which follows a symlinked `config.toml` to its target,
  sets the temporary file's mode before any text goes in, and queues edits so two writes never
  race. Its changed-meanwhile check compares the file's text and time only between its own read
  and the rename (lines 527-575), so it guards against a write racing another write, not
  against an edit made while a step was open: such an edit is read, and the step's key is set
  in it. `addAgentProvider` and `editSiteUnbind` use `rewriteConfig`; `writeEngine` does not,
  and neither does `addRoute` (`:route add`, lines 642-670), a plain append outside the queue.
- **`setTomlKeys`** (`packages/vimma-core/src/config/toml.mjs`) edits one key of a top-level
  table in place, keeping comments and order, and takes a string, boolean or number
  (`TomlEdit.value`). It has no array value, and `valueEnd` returns -1 for any existing value
  that starts with `[` or `{`; no step of the first version writes an array. One limit matters
  here: a table that exists only through sub-tables (`[theme.colors]` without `[theme]`,
  `[modal.normal]` without `[modal]`) is refused as "not a plain table" (lines 533-534),
  although TOML 1.0 allows the `[theme]` header after its sub-tables.
- **The keymap in force.** `ConfigHost.keymap` is the compiled keymap. Its `keysFor(name)`
  (`packages/vimma-core/src/keys/keymap.mjs:540-551` and 643) returns every binding of an
  action as the
  user presses it, with the prefix and leader substituted (`ctrl+b u`); bindings of a mode
  other than normal carry the mode. For `focus_urlbar` it returns `ctrl+l`, `alt+d`, `I`,
  `I [visual]` and `I [panel]` (`docs/bindings.md`). `bindingsFor(name)` returns the binding
  texts as written (`prefix+?`), and `displayBinding(text, { prefix, leader })`
  (`packages/vimma-core/src/keys/keys.mjs:286`) draws one with any prefix. The help overlay
  (`bindingTable` in `packages/vimma-core/src/ui/help.mjs`) and `docs/bindings.json` are built
  from `keysFor`.
- **Keys and values in `defaults.toml`** (`packages/vimma-core/defaults.toml`): prefix
  `ctrl+b`, `toggle_toolbar = ["prefix+u"]`, `focus_urlbar = ["ctrl+l", "alt+d"]` plus `I` in
  `[modal.normal]`, hint characters `asdfghjkl`, theme
  `source = "omarchy"` and `name = "vimma"` with `appearance` left out, `toolbar = "shown"`,
  update `check = true`, and `[mcp] enabled` left out.
- **File versus command.** `[theme] appearance` and `[mcp] enabled` set in the file win over
  `:theme` and `:mcp on|off`, which then change nothing and say so (`docs/guide.md`, "Colours
  and themes" and the `:mcp` table). `:mcp on` asks `y/N` before it turns agents on.
- **Default browser.** `ShellService.setDefaultBrowser`
  (`browser/components/shell/ShellService.sys.mjs:482`) checks the `setDefaultBrowser` policy
  first. Vimma wraps it in `AppLauncher.wrapSetDefault` (`services/AppLauncher.sys.mjs`) so a
  packaged install sets its own desktop entry, and wraps `isDefaultBrowser` so Omarchy's link
  router counts (#855, `packages/vimma-core/src/system/default-browser.mjs`).
- **Import.** The File menu's `cmd_file_importFromAnotherBrowser` calls
  `MigrationUtils.showMigrationWizard` with the `FILE_MENU` entry point
  (`browser/base/content/browser-sets.js:69-72`). With an opener that has `openPreferences`, that
  opens a Settings tab at `about:preferences#general-migrate`, and the returned promise
  resolves when that tab is selected, not when the wizard closes
  (`browser/components/migration/MigrationUtils.sys.mjs:610-613` and 687-697). With
  `tabModal: true` it opens `migration-dialog-window.html` through
  `gBrowser.getTabDialogBox(selectedBrowser).open(...)` over the current tab (lines 671-684),
  but drops the result. `TabDialogBox.open` returns `{ closedPromise, dialog }`, and
  `closedPromise` resolves once the dialog closes (`browser/base/content/browser.js:4526-4594`).
  The wizard's Firefox entry looks for profiles in Vimma's own folder, not Firefox's, so a
  Firefox profile is not offered (`docs/guide.md`, "Moving over from Firefox or Chrome").
- **No keyboard-layout API.** Firefox 160 has no `navigator.keyboard` (no `getLayoutMap` in
  `dom/webidl/Navigator.webidl`). A `KeyboardEvent` carries both `code` (the physical key) and
  `key` (the character), so the page can tell the layout from the keys the user already pressed
  on it: `j` is on `KeyJ` on QWERTY, `KeyY` on Colemak and `KeyC` on Dvorak.
- **`ctrl+space`** is the usual input-method toggle of ibus and fcitx on Linux, so it is not
  offered as a prefix.
- **Private windows** do not save `:siteunbind` keys (spec
  [site-unbind-command](site-unbind-command.md), decision 12), because a private window leaves
  no trace on disk.
- **The tab line** (`[ui] tabline = "off" | "always" | "auto"`, default `"off"`) is on `main`
  since [#1314](https://github.com/vimma-browser/vimma/pull/1314)
  ([#1289](https://github.com/vimma-browser/vimma/issues/1289)).

## Design

1. **Each step saves on `enter`; there is no summary.** A setting step writes its key through
   the config writer when the user presses `enter`, and the change applies live, so that
   leaving at any point keeps every finished step and loses only the open one. This replaces
   first-run-setup's decision 2 ("nothing applies before the summary"), which suited two steps
   but makes a longer setup all-or-nothing. Rejected: a summary per chapter, because a user
   leaving mid-chapter would still lose the chapter.
2. **`q` and `esc` leave; `s` skips; `h` goes back.** Leaving and skipping are different keys so
   that a user who wants to keep a default for one step is never one key away from closing the
   page, and `h` is Vim's "left", the direction of the previous step. The page keeps owning
   only plain keys (Research), so the prefix chord still reaches Vimma.
3. **Skip and Keep write nothing.** A skipped step, and the **Keep** choice, leave the file as
   it is, so that a later change to Vimma's default still reaches the user and a value the user
   set by hand is never replaced by a setup choice. Rejected: writing the default on skip,
   because it pins today's default in the file.
4. **Only real changes are written, judged at `enter`.** Inside the write, the host parses the
   file's current text, resolves the value in force from it (with the built-in default, and for
   colours the effect, decision 12), and writes nothing when the choice equals it, so that a
   run of plain `enter` keeps the file as it was and every line in it was a choice. Because the
   comparison and the edit both use the text at `enter`, an edit made by another program while
   the step was open is kept and only the step's own key changes (behaviour 14). Rejected: a
   snapshot taken when the step opens and refusing the write when the file differs, because
   the user would then have to redo a step for an unrelated edit.
5. **One config writer.** Setting steps call a new `ConfigHost.setConfigKeys(edits)`, which runs
   `setTomlKeys` inside `rewriteConfig`, so that the setup gets the symlink handling, the
   private temporary file and the queue that `:siteunbind --save` has. `SetupHost.writeEngine`
   moves to it and its own writer is removed, and `addRoute` becomes an append run inside the
   `rewriteConfig` queue, because
   two copies of the same safety checks drift and an append outside the queue can race a
   rewrite. The edited text is parsed with `parseConfig` before the rename and nothing is
   written when it reports an error, so a step can never leave a file that does not load.
6. **`setTomlKeys` learns one case.** A table that exists only through sub-tables gets its
   `[table]` header added before the first sub-table, with the key under it, because TOML 1.0
   allows it and `[theme.colors]` without `[theme]` or `[modal.normal]` without `[modal]` is a
   common file. Array values are left out, since no step of the first version writes one now
   that the Firefox's keys step is dropped (decision 11); a later step that needs one adds them.
7. **Values come from a fixed table.** Each setting step's choices are constants in
   `packages/vimma-core/src/system/setup-steps.mjs` (table, key and value per choice), except
   the search engine, which is one of the installed engines' names. The page sends the host a
   step id and a choice index, never a key or a value, so that the page cannot write an
   arbitrary key to `config.toml`. For the search engine, the host resolves the index against
   the list it sent the page, and checks that the engine is still installed (behaviour 20).
8. **Steps are data, and key hints come from the keymap in force.** `setup-steps.mjs` lists the
   chapters, their steps, each step's kind (`setting` or `action`), its choices, the actions
   its text may name, and its text with placeholders such as `{keys:focus_urlbar}`, so that a
   later step is one table entry and its test, not new page code. A placeholder is filled from
   `keysFor(<action>)` of `ConfigHost.keymap`, keeping only the bindings without a mode suffix
   (`I [visual]` and `I [panel]` are dropped), because those are the keys that work from a
   page; with none left, the action's `:` command is shown. On the prefix step, a placeholder
   is drawn for each candidate from `bindingsFor(<action>)` through
   `displayBinding(text, { prefix: candidate, leader })`, because the keymap only knows the
   prefix in force. Reason for the keymap as source: the help overlay and `docs/bindings.json`
   already use it, so the setup cannot disagree with them, and a step drawn after the prefix
   step reads the new prefix because the write reloads the keymap.
9. **Key notation in step text is checked.** Every key in a step's text is written as `<kbd>`
   (in the source table, the placeholder output or a page key), and the vitest runs each one
   through the key-notation parser (`parseKey`): it fails when a `<kbd>` is neither a page key
   nor the output of a placeholder, and when a placeholder names an action the step does not
   declare. Choice labels that look like keys (`ctrl+a`, `ctrl+b`, `asdfghjkl`) are choice data,
   not step text, and are exempt by construction, so that the check has no false alarms on
   them.
10. **The hint letters step guesses the layout from keys already pressed.** The page keeps the
    `code` and `key` of the letter keys pressed on it (`j` and `k` at least, by the time the
    step opens) and selects the layout they match, QWERTY when none matches. Reason: Firefox has
    no layout API (Research), and running a system tool (`hyprctl`, `setxkbmap`) for one
    preselection is not worth a process launch. The keys are kept in the page only and never
    written anywhere. The guess moves the selection only off the built-in QWERTY letters, because
    a layout the user saved before, or custom letters under **Keep**, is a choice already made
    (behaviour 9), while QWERTY in force is most often the default nobody chose; with no letter
    pressed, or keys no layout fits, the value in force stays selected.
11. **The first version has the eleven steps in the table, in five chapters,** because these
    cover the settings a new user changes first and each maps to one existing key or one
    existing action. The Firefox's keys step (`[firefox] disable`) is not in it, because the
    default, with all of Firefox's own shortcuts off, suits nearly everyone; the key stays in
    `config.toml` and the guide. After the alpha, these come as rows added to the step table,
    before Privacy and agents, with chapter digits following the list's order: Workspaces (names,
    sites that open there, new tab in a split), Feel (scrolling, side panel numbers, split layout)
    and the other steps (search shortcuts, bookmarks toolbar, font, leader key, editing keys in text
    fields).
12. **The colours step is the third essential,** because it is quick and its effect is the most
    visible one in the setup. Its value in force is the
    effect: whether the Omarchy theme is shown, else the built-in palette and its appearance.
    A choice writes only the keys that change that effect, so that plain `enter` writes
    nothing (behaviour 8): **Omarchy** writes `source = "omarchy"` when it is not in force;
    **light**, **dark** and **follow the system** write `appearance`, and `source = "file"`
    only when an Omarchy theme is shown now, and `name = "vimma"` only when another name is in
    force (none can be since #1383 left `vimma` the only built-in palette).
13. **Moving in comes right after the essentials,** because the default browser and the
    imported bookmarks decide whether the user keeps using Vimma at all, and both are one-off
    actions a user is most likely to take on the first day. Every chapter can still be skipped
    from its stop screen.
14. **The agents step is in the first version, with "off" selected first,** because agents
    are one of Vimma's features and turning them on is otherwise a command the user must find
    (`:mcp on`); the step explains the agent workspace before the choice, as `:mcp on` asks
    before it acts.
15. **The tab line step ships with setup v2,** because `[ui] tabline` is on `main` since #1314,
    so chapter 3 has both the address bar and the tab
    line step from the first release, and the next release waits for setup v2.
16. **Setting steps write the file; `:mcp off` still turns agents off.** Every setting step
    saves to `config.toml`, so `[theme] appearance` written there overrides `:theme` from then
    on, and the colours step says so. For agents, the file would also take away `:mcp off` as a
    way to stop every agent at once: today `[mcp] enabled` decides on every read of the file
    (`host/mcp-ops.mjs:74-82`, the `state` getter; `docs/guide.md`, the `:mcp` table), so a
    setup write, or any edit the file watcher picks up, would turn agents back on. `:mcp off`
    therefore becomes a flag held in memory that wins over the file: a config reload never
    clears it, and only `:mcp on` or a restart does; it says that the file turns agents on
    again at the next start. Reason: a kill switch that depends on editing a file, or that the
    next file read undoes, is no kill switch. This applies to every user, not only behind
    `vimma.feature.setupV2`, because it is a fix in its own right for anyone who sets
    `[mcp] enabled = true` by hand, and it lands in slice 1. Decided with decision 14.
    Rejected: setting the prefs the commands use, because the setup would then save some
    choices outside the file it shows.
17. **Action steps keep Firefox's own paths.** The content blocker installs through
    `installAddonFromAOM` as first-run-setup decision 3; the default browser step calls
    `ShellService.setDefaultBrowser`, which Vimma's wrapper already routes for packaged installs
    and which honours the enterprise policy. The import step opens the wizard as Firefox's
    `tabModal` path does, calling `gBrowser.getTabDialogBox(setupBrowser).open()` with
    `migration-dialog-window.html`, `features: "resizable=no"`, the content modal type and
    `{ options: { entrypoint: MigrationUtils.MIGRATION_ENTRYPOINTS.FILE_MENU, tabModal: true } }`
    (Research), and opens the next
    step when its `closedPromise` resolves, because `showMigrationWizard` itself gives no close
    signal. Reason: each prompt, check and policy stays Firefox's and is tested there. When the
    dialog cannot be opened over the setup page (slice 3 checks this first), the step falls
    back to `showMigrationWizard` with the Settings tab and opens the next step when the user
    comes back to the setup tab. The check passed: the wizard opens over the setup page, which
    loads in the parent process, takes the theme in force, closes with its own Cancel or `esc`,
    and `closedPromise` resolves then, so the fallback is not built. `SetupHost.openImportWizard`
    opens it only over a browser showing `about:vimma-setup`, never where the
    `DisableProfileImport` policy forbids it, and a second request while it is open waits for
    the same dialog, because a repeated `enter` must not stack wizards.
    Both steps offer the action first and "not now" second, and save no key: "Saved this run"
    lists what the action did ("made the default browser", "import wizard closed"). Where the
    action cannot run (Vimma already the default; Make Default hidden by a policy, a locked
    pref or Flatpak; import turned off by policy), the step says why and offers only to go on,
    because a choice that cannot act would only fail. A failed Make Default keeps the step open
    and says so, as a failed write does (behaviour 16). When the wizard closes, the setup
    page takes the focus back, because the dialog leaves it nowhere on the page. The wizard has
    square corners and the theme's font, as Settings has (firefox-surfaces-trim, decision 8).
18. **A feature pref while it lands.** `vimma.feature.setupV2` (default `false`) switches the
    page from today's flow to the chapters while the slices land (`CONTRIBUTING.md`,
    "Unfinished features"), because the summary flow must keep working on `main` until the new
    one is complete. The last slice removes the pref and the old flow. (Since changed: #1298 removed
    both; the chapters are the only flow.)
19. **Finished chapters are a pref, not a config key.** `vimma.setup.chapters` holds the ids
    of the chapters whose stop screen was reached, for the ticks on the welcome screen, because
    it is a record of the setup and not a setting of the browser. It is not written in a
    private window.

20. **The agents step's "on" is a yes to `:mcp on`, in every respect.** It is refused, with
    nothing written, where that yes is refused: without an agent workspace, when the agent
    workspace changed, or when `:mcp off` ran after the user arrived at the step. What it is
    checked against is taken when the user arrives at the step and kept when the step is drawn
    again for a config read or an `:mcp on|off` elsewhere, because a redraw is no new consent; a
    redraw that changes the row in force moves the cursor to it. After a refusal the step is
    drawn anew with the cursor on the row in force, so that a new consent takes `j` and `enter`.
    Once its `[mcp] enabled = true` is written (or the file says so already), it ends
    `:mcp off`'s hold as the yes does, after the same checks; the write alone never does
    (decision 16), and a refusal at that second check holds agents off until `:mcp on` or a
    restart, so that the file just written does not turn them on in this session; it does at
    the next start, as any `enabled = true` does. With the hold in force, "off" is the value
    in force and writes nothing (behaviour 8), and the step says that the file turns agents on
    again at the next start; "on" says that it also ends `:mcp off`. For a workspace Vimma did
    not make, "on" shows `:mcp on`'s warning that agents will read it. Reason: two ways to turn
    agents on that check different things would leave the weaker one as the way around the
    other, and a hold that a setup page could lift silently would undo decision 16.
    Decided for the two cases the behaviours above leave open:
    - **"Off" under the hold, with `[mcp] enabled = true` in the file, writes nothing** and
      keeps its note that agents come back at the next start, because plain `enter` through
      every step must leave the file unchanged (behaviour 8), and the note tells the user that
      the file, not the step, decides at the next start. Rejected: writing `enabled = false`,
      because a plain `enter` would then change a file the user set by hand.
    - **"On" without an agent workspace is refused**, with nothing written, as `:mcp on`
      refuses it, because the step's consent checks what that yes checks (above). Rejected:
      writing `enabled = true` anyway, because the step would then turn agents on in a way
      `:mcp on` cannot.

### Page layout

- **Welcome screen.** The logo as today, the heading "Set up Vimma", the promise of behaviour 2
  as the first paragraph, the chapter list (number, name, steps, a tick when finished), and
  the buttons `enter` **Set up** and `q` **Not now**.
- **A step.** Chapter and step ("Address bar · step 1 of 1"), one question, its choices as a
  list with the one in force marked, the line it will write (behaviour 12), and the footer of
  behaviour 11. A step that changes the window (address bar, tab line) shows a small drawing
  of the window with each choice.
- **A stop screen.** A heading ("The essentials are saved"), one line per saved step with its
  `config.toml` line, the next chapter's name and steps, and `enter` **Go on**, `q` **Done**.
  The last one is described in behaviour 10.
- **Layout.** Every step and stop screen starts at the same height: the progress line and the
  question sit a fixed distance from the top whatever the list holds, and a stop screen's
  heading sits where the steps' progress line does, so nothing jumps from one screen to the
  next. The footer stays at the bottom of the window. A list longer than the space left (the
  search engines, the add-ons, the window drawings, the saved lines) scrolls in its own box
  under a header that stays put, and the row under the cursor is kept in view; a new screen
  opens its boxes at their top. A list shrinks to about two and a half add-on rows at the
  least. A short window, one whose page is under 40rem (640 px) high, such as 800×600,
  tightens the spacing and draws the window drawings smaller, so at 800×600 the content
  blocker shows two and a half add-ons without the step scrolling, even with the notice that
  addons.mozilla.org is not answering. A window too short for even that scrolls the step,
  header and all, and never puts anything under the footer. The welcome screen stays centred.
- **Theme.** Theme variables only, as first-run-setup's welcome screen, so Omarchy, light and
  dark need no per-theme rules; no animation, as Vimma's chrome CSS tests require.

### Workspaces, containers and agents

Every setting the setup writes is profile-wide, as `config.toml` is. Add-ons run in every
workspace, the agent workspace too, and the content blocker step says so (unchanged). The
default browser and the import are per profile. Turning agents on does not create or open the
agent workspace; the first agent request does.

## Security and privacy

- **Config writes.** Every write goes through `rewriteConfig` (decision 5): one at a time,
  through a temporary file created with the old file's mode (0600 for a new file in a 0700
  folder) before any text is written, renamed over the target of a symlinked `config.toml`,
  and never when the file does not parse, would not load with the edit, or changed during the
  write itself. An edit made while a step is open is kept, not overwritten (decision 4). The
  page can only name a step and a choice (decision 7); the search engine name is written as one
  escaped TOML string by `tomlLiteral`. `docs/security/08-config-toml.md` F1 becomes: Vimma
  changes an existing `config.toml` only from `:route add`, `:siteunbind --save`,
  `:sitebind --delete`, the built-in agent's setup and the setup page's setting steps, each
  through `rewriteConfig`; `:route add` stays an append, run inside the `rewriteConfig` queue
  (slice 1).
- **Trusted input only.** The page acts only on trusted key and click events (unchanged), the
  control socket has no command for it, and the agent role's `open` refuses
  `about:vimma-setup`, so no agent can write `config.toml`, install an add-on, change the
  default browser or turn agents on through it.
- **Agents.** The agents step is the one step that widens what can reach the browser:
  `enabled = true` under `[mcp]` lets the control socket's agent role start. It is never
  preselected, and the step explains the agent workspace and the prompts before the choice.
  Written to the file, the value would win over `:mcp off`, so the user would lose the one
  command that stops every agent at once; decision 16 keeps `:mcp off` working until restart.
  Its flag lives in memory and no config reload clears it (today every read of the file
  re-applies `[mcp] enabled`), only `:mcp on` or a restart. `docs/security/12-agents-mcp.md`
  gains both rules: `:mcp off` always turns MCP off for the session, whatever the file says
  and however often it is read (slice 1), and the setup can turn MCP on only from a trusted
  `enter` on that step (slice 6). Both slices get a review by a fresh session before merging.
- **Add-ons.** Installs keep first-run-setup's rules (AMO only, signed, Firefox's permission
  prompt, Vimma never answers it); only the moment changes. Until setup v2 is turned on,
  `docs/security/05-add-ons.md` A1 names both paths: after the summary with
  `vimma.feature.setupV2` off, and after the content blocker step's `enter` with it on. The
  slice that turns setup v2 on drops the summary path.
- **Import.** The wizard is Firefox's: it reads other browsers' profiles on this computer and
  nothing leaves the machine. Vimma passes only the entry point to it.
- **Default browser.** Changes the user's own handler associations, only on `enter`, through
  Firefox's shell service and its policy check.
- **Network.** The setup sends requests only from the content blocker step (AMO, as today).
  The updates step changes whether Vimma asks `updates.vimma.dev` every 12 hours; "never
  check" stops it.
- **Keys for the layout guess.** The page keeps the `code` and `key` of at most 32 letters
  pressed on it, in its own memory, for the hint letters step (decision 10). They are never
  sent to the host, written, logged or kept after the page closes; only the index of the
  choice under the cursor reaches the host, on `enter`.
- **Private windows.** No setting step writes from a private window, and the layout guess and
  the chapter pref are not kept there.

## Tests

vitest, `packages/vimma-core/test/toml.test.ts` (`setTomlKeys`):

- `adds [theme] before [theme.colors] when only the sub-table exists`
- `adds [modal] before [modal.normal] when only the sub-table exists`

vitest, `packages/vimma-core/test/setup-steps.test.ts`:

- `every setting step's choices are a table, a key and a value the config schema accepts`
- `every kbd in a step's text is a page key or a placeholder's output`
- `a step's placeholders name only the actions it declares`
- `keys are filled from the keymap: a rebound key shows, an unbound one is left out`
- `keys with a mode suffix are left out of a placeholder`
- `an action with no key is named by its command`
- `the prefix step draws show_keybinds with each candidate prefix`
- `after a new prefix, the toolbar step shows the new prefix`
- `choosing the value in force plans no write`
- `skip and keep plan no write`
- `a value in force that is no choice adds keep, first and selected`
- `the hint step selects the layout that matches the pressed keys, QWERTY otherwise`
- `colours: the choice in force writes nothing, with and without an Omarchy theme`
- `colours: light without an Omarchy theme writes appearance only`
- `colours: light with an Omarchy theme writes source and appearance`
- `colours: a removed palette's name is vimma: no Keep, no name written`
- `colours: another name in force is kept, and a choice also writes name = "vimma"`
- `each setting step's shown line is the edit it plans`

vitest, `packages/vimma-core/test/setup.test.ts` (state machine):

- `enter on a setting step plans one write and opens the next step`
- `enter on an action step runs it and opens the next step`
- `s moves on and plans nothing`
- `h returns to the previous step with the value in force selected`
- `q and esc close from every step and stop screen`
- `esc in the search field leaves the field, a second esc leaves the page`
- `the last step of a chapter opens its stop screen`
- `the last stop screen closes on enter, q and esc`
- `a digit on the welcome screen opens that chapter`
- `with a config parse error, setting steps can only skip`

Mochitest, `tests/browser/browser_vimma_setup_v2.js` (with `vimma.feature.setupV2` on until the
last slice; a file apart from the summary flow's `browser_vimma_setup.js`, because both together
outgrow the harness's time limit for one file; the last slice drops the summary flow's tasks
from `browser_vimma_setup.js`, which keeps the page's offering, its config.toml file checks
through the search engine step and `agent_role_cannot_open_setup`):

- `welcome_says_q_leaves_and_finished_steps_are_saved`
- `enter_on_a_step_writes_its_key_and_applies_live`
- `a_step_shows_the_line_it_will_write`
- `leaving_mid_chapter_keeps_finished_steps`
- `closing_the_tab_keeps_finished_steps_and_writes_nothing_else`
- `enter_through_every_step_leaves_config_toml_unchanged` (with and without an Omarchy theme)
- `skip_writes_nothing`
- `back_overwrites_one_key`
- `an_edit_made_while_a_step_is_open_is_kept`
- `a_failed_write_keeps_the_file_and_the_step_open`
- `a_parse_error_writes_nothing_and_action_steps_still_work`
- `a_symlinked_config_toml_stays_a_link`
- `a_private_window_saves_nothing`
- `the_page_cannot_name_a_key_or_value`
- `an_engine_removed_before_enter_is_not_written`
- `content_blocker_installs_on_enter_with_the_permission_prompt`
- `address_bar_step_names_the_keys_in_force` (default keys, a rebound `focus_urlbar`, an unbound
  `alt+d`)
- `tab_line_step_writes_tabline_and_applies_live` (off, always and only with two or more tabs)
- `prefix_step_changes_later_steps_hints`
- `default_browser_step_calls_the_shell_service`
- `default_browser_step_says_when_vimma_already_is_the_default`
- `default_browser_step_says_why_it_cannot_make_vimma_the_default`
- `a_failed_make_default_keeps_the_step_open`
- `import_step_opens_the_wizard_over_the_setup_tab_and_moves_on_when_it_closes` (square
  corners and the theme's font in the wizard, and the focus back on the setup page)
- `import_step_names_sync_for_firefox`
- `updates_step_says_what_the_check_sends`
- `agents_step_selects_off_first_and_writes_enabled_on_enter`
- `agents_on_ends_mcp_off_as_mcp_on_does` (the file on and held off: off writes nothing; on
  writes nothing and ends the hold; held without the key: on writes it and ends the hold)
- `an_mcp_off_after_the_step_was_drawn_wins_over_its_enter`
- `an_mcp_off_the_page_hears_keeps_the_ticket_and_moves_the_cursor`
- `a_config_read_redraw_keeps_the_ticket`
- `a_workspace_gone_during_the_write_holds_agents_off`
- `a_redraw_during_the_load_after_a_refusal_keeps_the_cursor_on_off`
- `a_redraw_with_no_ticket_takes_none`
- `mcp_off_turns_agents_off_until_restart_when_the_file_enables_them`
- `mcp_off_survives_a_config_reload` (`[mcp] enabled = true` in the file, `:mcp off`, the file
  edited and read again: agents stay off until `:mcp on`)
- `finished_chapters_are_ticked_on_the_next_run`
- `route_add_waits_for_a_running_rewrite` (`browser_vimma_workspace_routes.js`)
- `agent_role_cannot_open_setup` (kept, in `browser_vimma_setup.js`)

Mochitest, `tests/browser/browser_vimma_setup_moving_in.js` (the host side of Moving in, with
the shell service replaced, so no test changes the machine's default browser, and only
Firefox's test migrator in the wizard):

- `default_browser_state_follows_the_shell_service`
- `set_default_browser_calls_the_shell_service`
- `set_default_browser_does_nothing_when_vimma_already_is`
- `set_default_browser_reports_a_failure`
- `set_default_browser_respects_the_policy`
- `set_default_browser_respects_the_locked_button_pref`
- `set_default_browser_does_nothing_under_flatpak`
- `import_wizard_opens_over_the_setup_tab_and_resolves_when_it_closes`
- `import_wizard_opens_only_over_the_setup_page`
- `import_wizard_respects_the_policy`
- `closing_the_setup_tab_resolves_the_wizard_and_a_new_one_opens`
- `a_wizard_that_cannot_open_is_unavailable`
- `full_control_send_keys_reach_the_setup_page`

e2e: the `setup-page` scenario gains screenshots of the welcome screen, one step, the address
bar step and a stop screen, with the Omarchy and light themes, checked by eye for the key hints,
the line the step writes and the footer before the baselines are accepted.

## Docs and changelog

- `docs/guide.md`, "First-run setup": rewritten for the chapters, saving on `enter`, `s`, `h`,
  `q`, **Keep**, and the chapter list; the `:mcp` table for `:mcp off` with the file set.
- `docs/security/`: F1 in `08-config-toml.md`, A1 in `05-add-ons.md`, and how MCP is turned on
  and off in `12-agents-mcp.md`.
- [first-run-setup](first-run-setup.md): a "Since changed" note on decision 2 and behaviours 5
  and 6, pointing here, in the slice that turns setup v2 on.
- Changelog (from the last slice's commit subject): "feat(setup): setup in optional chapters
  that save each step on enter".

## Delivery

Slices 1 to 5 and 8 merge when green and verified. Slices 6 and 7 stop at ready for the
maintainer, with notes in the pull request on how to try them (build, `vimma.feature.setupV2`,
keys, what to look for), because slice 6 turns agents on from a page, and slice 7 turns the new
setup on for every user.

1. **Core: one config writer and the step table** (#1292). The `setTomlKeys` sub-table case,
   `ConfigHost.setConfigKeys` on `rewriteConfig`, `writeEngine` and `addRoute` moved onto it,
   `setup-steps.mjs` with the key-hint fill and its tests, `vimma.feature.setupV2`. Not behind
   the pref: `:mcp off` as a flag in memory that no config reload clears (decision 16), with
   `docs/security/12-agents-mcp.md`, the guide's `:mcp` table and a review by a fresh session;
   that is the slice's only user-visible change.
2. **The chapter flow and the essentials** (#1293), behind the feature pref: welcome screen,
   step and stop screen layout, footer, `enter`/`s`/`h`/`q`/digits, **Keep**, saving per step,
   the parse-error, failed-write and private-window rules, the chapter pref, and chapter 1
   (content blocker, search engine, colours). `docs/security/08-config-toml.md` F1 and
   `05-add-ons.md` A1 with both paths; review by a fresh session.
3. **Moving in** (#1294): the default browser and bring-your-data steps, starting with a check
   that the wizard opens over the setup tab (decision 17).
4. **The window** (#1295): the address bar step with its key hints and window drawing.
5. **Your keys** (#1296): the prefix and hint letters (layout guess) steps.
6. **Privacy and agents** (#1297): the updates and agents steps,
   `docs/security/12-agents-mcp.md` for turning MCP on from the step; review by a fresh
   session; stops at ready.
7. **Turn it on** (#1298): remove `vimma.feature.setupV2` and the summary flow, A1's summary
   path, rewrite the guide section, e2e baselines, the "Since changed" note in
   first-run-setup, status `implemented`; it merges after slice 8, so that no release has
   the new setup without the tab line step (decision 15); stops at ready.
8. **The tab line step** (#1299): the tab line step of chapter 3, with its window drawing,
   behind the feature pref; it merges before slice 7 (decision 15).

## Open questions

None. Decisions 11 to 16 record the answers to the five questions asked on #1290: eleven steps
in five chapters, without Firefox's keys; the colours in the essentials; Moving in right after
them; the agents step with off preselected and `:mcp off` winning until restart; and the tab
line step shipping with setup v2.
