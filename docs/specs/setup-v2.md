# Spec: setup-v2

Status: draft · Area: core (`packages/vimma-core/src/system/setup.mjs`,
`packages/vimma-core/src/system/setup-steps.mjs` (new), `packages/vimma-core/src/config/toml.mjs`),
chrome (`src/browser/base/content/vimma/setup/` (`setup.html`, `setup.mjs`, `SetupHost.sys.mjs`),
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
   saves again, overwriting that one key.
7. `q` or `esc` on any step or stop screen (outside a text field) closes the page. Steps
   already saved stay saved; nothing is undone, and nothing for the open step is written.
   Closing the tab or the window does the same.
8. Choosing the value already in force **must** write nothing, so that `enter` through every
   step leaves `config.toml` unchanged.
9. Each step opens with the value in force selected: the value in `config.toml`, else the
   built-in default (or, for the colours and agents steps, the value `:theme` or `:mcp`
   remembered).
10. After the last step of each chapter, a stop screen lists what was saved in that chapter
    and names the next chapter. `enter` goes on; `q` or `esc` closes the page.
11. Every step and stop screen has a footer with the step's place in its chapter, the list of
    what this run saved so far, and the page keys: `j`/`k` choose, `enter` save and go on, `s`
    skip, `h` back, `q` leave.

### Writing `config.toml`

12. A setting step **must** show the exact line it will write (`[ui] toolbar = "hidden"`)
    before `enter`.
13. A `config.toml` that does not parse **must** never be written. The welcome screen names the
    file and line; setting steps show the same notice and only skip; action steps work.
14. A file changed by another program between the step opening and `enter` is not written; the
    step says so and offers to read the file again (`enter`).
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

The chapters and steps below are the first version (decision 11). `Saves` is the
`config.toml` line a setting step writes, or "action" for a step that does something and saves
nothing.

| Chapter               | Step            | Choices                                                                                               | Saves                                                                      |
| --------------------- | --------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1. Essentials         | Content blocker | uBlock Origin, AdGuard AdBlocker, Privacy Badger, an AMO search; none                                 | action: installs the marked add-ons, each with Firefox's permission prompt |
|                       | Search engine   | the installed engines                                                                                 | `[search] default`                                                         |
|                       | Colours         | the Omarchy theme (only where one is found), light, dark, follow the system                           | `[theme] source`, `[theme] appearance`                                     |
| 2. Moving in          | Default browser | make Vimma the default browser, or not now                                                            | action: the system's default browser                                       |
|                       | Bring your data | open the import wizard (Chrome, Chromium, Brave, Edge, Opera, Vivaldi); from Firefox, how to use Sync | action: Firefox's import wizard                                            |
| 3. The window         | Address bar     | shown, hidden                                                                                         | `[ui] toolbar`                                                             |
|                       | Tab line        | off, always, only with two or more tabs                                                               | `[ui] tabline` (decision 15)                                               |
| 4. Your keys          | Prefix key      | `ctrl+b`, `ctrl+a`, `ctrl+space`                                                                      | `[keys] prefix`                                                            |
|                       | Hint letters    | the home row of QWERTY (`asdfghjkl`), Colemak (`arstdhneio`), Dvorak (`aoeuidhtns`)                   | `[modal] hint_chars`                                                       |
|                       | Firefox's keys  | off where Vimma binds none (the default), or Firefox's own where Vimma binds none                     | `[firefox] disable`                                                        |
| 5. Privacy and agents | Updates         | tell me when a release is out, or never check                                                         | `[updates] check`                                                          |
|                       | Agents          | off, or on for local AI agents through `vimma-ctl mcp`                                                | `[mcp] enabled`                                                            |

19. **Content blocker.** As step 1 of first-run-setup (curated list, `/` searches AMO, `space`
    marks), except that `enter` installs the marked add-ons there and then, one after another,
    each through Firefox's permission prompt, and the step reports each result before moving
    on. `enter` with nothing marked moves on.
20. **Search engine.** As step 2 of first-run-setup; `enter` writes `[search] default`.
21. **Colours.** The page itself takes the colours as soon as the step saves. The Omarchy choice
    is listed only where an Omarchy theme is found.
22. **Default browser.** Shows whether Vimma is the default browser now. `enter` on "make
    Vimma the default" asks the system through the same path as Settings' Make Default; when
    Vimma already is the default, the step says so and `enter` moves on.
23. **Bring your data.** `enter` on "import" opens Firefox's import wizard over the window; the
    setup continues when the wizard closes. The step says that a Firefox profile is not in the
    wizard, and that Firefox data comes over with Firefox Sync (`:settings sync`).
24. **Address bar.** The step names every key bound to `focus_urlbar` and `toggle_toolbar`
    (`I`, `ctrl+l`, `alt+d` and `ctrl+b u` with the default keymap), so that the user knows how
    to reach the address bar once it is hidden.
25. **Prefix key.** The step names the keys the prefix starts (`ctrl+b ?` for the keys,
    `ctrl+b b` for the side panel) with each candidate prefix.
26. **Hint letters.** The layout the user types on is selected first (decision 9).
27. **Firefox's keys.** The step names the help overlay's key (`show_keybinds`) as the place to
    see every key.
28. **Updates.** Says what the check sends (the update channel and the platform) and that
    "never check" stops every request to `updates.vimma.dev`.
29. **Agents.** "Off" is selected first unless agents are on. The step says, in two lines, that
    agents reach only the agent workspace, and that sending a form, paying and showing a page
    always ask the user. `enter` on "on" is the user's consent, as answering `y` to `:mcp on`
    is.
30. Neither the control socket nor an MCP agent can open, read or drive the page (unchanged
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
- **Two copies of the config writer.** `SetupHost.writeEngine` writes through a temporary file
  and a rename, but it predates `ConfigHost`'s shared `rewriteConfig`
  (`config/ConfigHost.sys.mjs`, added with `:siteunbind --save` in #1269), which also follows a
  symlinked `config.toml` to its target, sets the temporary file's mode before any text goes in,
  compares the file's text as well as its time, and queues edits so two writes never race.
  `addAgentProvider` and `editSiteUnbind` use `rewriteConfig`; `writeEngine` does not.
- **`setTomlKeys`** (`packages/vimma-core/src/config/toml.mjs`) edits one key of a top-level
  table in place, keeping comments and order, and takes a string, boolean or number
  (`TomlEdit.value`). It has no array value, which `[firefox] disable = []` needs.
- **The keymap in force.** `ConfigHost.keymap` is the compiled keymap; its `keysFor(name)`
  (`packages/vimma-core/src/keys/keymap.mjs`) returns every key bound to an action as the user
  presses it, with the prefix and leader substituted (`ctrl+b u`), and the normal-mode `I` for
  `focus_urlbar`. The help overlay (`bindingTable` in `packages/vimma-core/src/ui/help.mjs`) and
  `docs/bindings.json` are built from the same call.
- **Keys and values in `defaults.toml`** (`packages/vimma-core/defaults.toml`):
  `[keys] prefix = "ctrl+b"`, `toggle_toolbar = ["prefix+u"]`,
  `focus_urlbar = ["ctrl+l", "alt+d"]` and `I` in `[modal.normal]`; `[modal] hint_chars =
"asdfghjkl"`; `[firefox] disable = "all"`; `[theme] source = "omarchy"` with `appearance` left
  out; `[ui] toolbar = "shown"`; `[updates] check = true`; `[mcp] enabled` left out.
- **File versus command.** `[theme] appearance` and `[mcp] enabled` set in the file win over
  `:theme` and `:mcp on|off`, which then change nothing and say so (`docs/guide.md`, "Colours
  and themes" and the `:mcp` table). `:mcp on` asks `y/N` before it turns agents on.
- **Default browser.** `ShellService.setDefaultBrowser` (`browser/components/shell/
ShellService.sys.mjs:482`) checks the `setDefaultBrowser` policy first. Vimma wraps it in
  `AppLauncher.wrapSetDefault` (`services/AppLauncher.sys.mjs`) so a packaged install sets its
  own desktop entry, and wraps `isDefaultBrowser` so Omarchy's link router counts (#855,
  `packages/vimma-core/src/system/default-browser.mjs`).
- **Import.** `cmd_file_importFromAnotherBrowser` calls `MigrationUtils.showMigrationWizard(window,
{ entrypoint: FILE_MENU })` (`browser/base/content/browser-sets.js:69-72`;
  `browser/components/migration/MigrationUtils.sys.mjs:615`). The wizard's Firefox entry looks
  for profiles in Vimma's own folder, not Firefox's, so a Firefox profile is not offered
  (`docs/guide.md`, "Moving over from Firefox or Chrome").
- **No keyboard-layout API.** Firefox 160 has no `navigator.keyboard` (no `getLayoutMap` in
  `dom/webidl/Navigator.webidl`). A `KeyboardEvent` carries both `code` (the physical key) and
  `key` (the character), so the page can tell the layout from the keys the user already pressed
  on it: `j` is on `KeyJ` on QWERTY, `KeyY` on Colemak and `KeyC` on Dvorak.
- **Private windows** do not save `:siteunbind` keys (spec
  [site-unbind-command](site-unbind-command.md), decision 12), because a private window leaves
  no trace on disk.
- **The tab line** (`[ui] tabline = "off" | "always" | "auto"`, default `"off"`) is a separate
  feature with its own spec; it is not on `main` yet.

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
3. **Skip writes nothing.** A skipped step leaves its key out of `config.toml`, so that a
   later change to Vimma's default still reaches the user. Rejected: writing the default on
   skip, because it pins today's default in the file.
4. **Only real changes are written.** A step compares the chosen value with the value in force
   (behaviour 9) and writes nothing when they are equal, so that a run of plain `enter` keeps
   the file as it was and every line in it was a choice.
5. **One config writer.** Setting steps call a new `ConfigHost.setConfigKeys(edits)`, which runs
   `setTomlKeys` inside `rewriteConfig`, so that the setup gets the symlink handling, the
   private temporary file, the changed-meanwhile check and the queue that
   `:siteunbind --save` has. `SetupHost.writeEngine` moves to it and its own writer is removed,
   because two copies of the same safety checks drift. The edited text is parsed with
   `parseConfig` before the rename and nothing is written when it reports an error, so a step
   can never leave a file that does not load. `setTomlKeys` gains an array-of-strings value
   (written with `tomlLiteral` per item), because `[firefox] disable = []` needs one.
6. **Values come from a fixed table.** Each setting step's choices are constants in
   `packages/vimma-core/src/system/setup-steps.mjs` (table, key and value per choice), except
   the search engine, which is one of the installed engines' names. The page sends the host a
   step id and a choice index, never a key or a value, so that the page cannot write an
   arbitrary key to `config.toml`.
7. **Steps are data.** `setup-steps.mjs` lists the chapters, their steps, each step's kind
   (`setting` or `action`), its choices, the actions its text may name, and its text with
   placeholders such as `{keys:focus_urlbar}`. The state machine in `setup.mjs` walks this
   table, so a later step is one table entry and its test, not new page code.
8. **Key hints come from the keymap in force.** A placeholder `{keys:<action>}` is filled from
   `ConfigHost.keymap.keysFor(<action>)` when the step is drawn, joined with commas; with no
   key the action's `:` command is shown instead. The step's text holds no key notation of its
   own. A vitest test fails when a step's text names a chord outside a placeholder, or a
   placeholder for an action the step does not declare; a mochitest rebinds and unbinds
   `focus_urlbar` and checks the address bar step. Reason: the keymap is the source the help
   overlay and `docs/bindings.json` already use, so the setup cannot disagree with them, and a
   step drawn after the prefix step reads the new prefix because the write reloads the keymap.
9. **The hint letters step guesses the layout from keys already pressed.** The page keeps the
   `code` and `key` of the letter keys pressed on it (`j` and `k` at least, by the time the
   step opens) and selects the layout they match, QWERTY when none matches. Reason: Firefox has
   no layout API (Research), and running a system tool (`hyprctl`, `setxkbmap`) for one
   preselection is not worth a process launch. The keys are kept in the page only and never
   written anywhere.
10. **Finished chapters are a pref, not a config key.** `vimma.setup.chapters` holds the ids
    of the chapters whose stop screen was reached, for the ticks on the welcome screen, because
    it is a record of the setup and not a setting of the browser. It is not written in a private
    window.
11. **The first version has twelve steps in five chapters.** Essentials (content blocker,
    search engine, colours), Moving in (default browser, bring your data), The window (address
    bar, tab line), Your keys (prefix, hint letters, Firefox's keys) and Privacy and agents
    (updates, agents), because these cover the settings a new user changes first and each maps
    to one existing key or one existing action. The later chapters (Workspaces: names, sites
    that open there, new tab in a split; Feel: scrolling, side panel numbers, split layout) and
    the other steps (search shortcuts, bookmarks toolbar, font, leader key, editing keys in
    text fields) fit the same table and slot in before Privacy and agents; chapter digits follow
    the list's order. Recommended, maintainer may revisit (Open questions, 1).
12. **The colours step is part of the essentials.** It is quick, and its effect is the most
    visible one in the setup. It writes `[theme] source = "omarchy"` for the Omarchy choice,
    and `source = "file"` with `appearance = "light" | "dark" | "system"` for the others, so
    the choice holds on a system where Omarchy is installed later. Recommended, maintainer may
    revisit (Open questions, 2).
13. **Moving in comes right after the essentials,** because the default browser and the
    imported bookmarks decide whether the user keeps using Vimma at all, and both are one-off
    actions a user is most likely to take on the first day. Recommended, maintainer may
    revisit (Open questions, 3).
14. **The agents step is in the first version,** with "off" selected first, because agents are
    one of Vimma's features and turning them on is otherwise a command the user must find
    (`:mcp on`); the step explains the agent workspace before the choice, as `:mcp on` asks
    before it acts. Recommended, maintainer may revisit (Open questions, 4).
15. **The tab line step lands after the tab line.** Setup v2 ships without it; the step is
    added when `[ui] tabline` is on `main`, and until then chapter 3 has the address bar step
    only, so that neither feature waits for the other. Recommended, maintainer may revisit
    (Open questions, 5).
16. **The agents and colours steps write the file, which then wins over the commands.**
    Because every setting step saves to `config.toml`, `[mcp] enabled` and `[theme] appearance`
    written there override `:mcp on|off` and `:theme` from then on (Research). The step says so
    in its line ("`:mcp off` then says to edit the file"). Rejected: setting the prefs the
    commands use, because the setup would then save some choices outside the file it shows.
17. **Action steps keep Firefox's own paths.** The content blocker installs through
    `installAddonFromAOM` as first-run-setup decision 3; the default browser step calls
    `ShellService.setDefaultBrowser`, which Vimma's wrapper already routes for packaged installs
    and which honours the enterprise policy; the import step calls
    `MigrationUtils.showMigrationWizard` with the `FILE_MENU` entry point, as the File menu
    does. Reason: each prompt, check and policy stays Firefox's and is tested there.
18. **A feature pref while it lands.** `vimma.feature.setupV2` (default `false`) switches the
    page from today's flow to the chapters while the slices land (`CONTRIBUTING.md`,
    "Unfinished features"), because the summary flow must keep working on `main` until the new
    one is complete. The last slice removes the pref and the old flow.

### Page layout

- **Welcome screen.** The logo as today, the heading "Set up Vimma", the promise of behaviour 2
  as the first paragraph, the chapter list (number, name, steps, a tick when finished), and
  the buttons `enter` **Set up** and `q` **Not now**.
- **A step.** Chapter and step ("Address bar · step 1 of 2"), one question, its choices as a
  list with the one in force marked, the line it will write ("Writes `[ui] toolbar =
"hidden"`"), and the footer of behaviour 11. A step that changes the window (address bar,
  tab line) shows a small drawing of the window with each choice.
- **A stop screen.** A heading ("The essentials are saved"), one line per saved step with its
  `config.toml` line, the next chapter's name and steps, and `enter` **Go on**, `q` **Done**.
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
  and never when the file does not parse, would not load with the edit, or changed meanwhile.
  The page can only name a step and a choice (decision 6); the search engine name is written
  as one escaped TOML string by `tomlLiteral`. `docs/security/08-config-toml.md` F1 becomes:
  Vimma changes an existing `config.toml` only from `:route add`, `:siteunbind --save`,
  `:sitebind --delete`, the built-in agent's setup and the setup page's setting steps, each
  through `rewriteConfig`.
- **Trusted input only.** The page acts only on trusted key and click events (unchanged), the
  control socket has no command for it, and the agent role's `open` refuses
  `about:vimma-setup`, so no agent can write `config.toml`, install an add-on, change the
  default browser or turn agents on through it.
- **Agents.** The agents step is the one step that widens what can reach the browser: `[mcp]
enabled = true` lets the control socket's agent role start. It is never preselected, the
  step explains the agent workspace and the prompts before the choice, and the write uses the
  same key the user could set by hand. Its pull request updates `docs/security/12-agents-mcp.md`
  (how MCP is turned on) and gets a review by a fresh session before merging.
- **Add-ons.** Installs keep first-run-setup's rules (AMO only, signed, Firefox's permission
  prompt, Vimma never answers it); only the moment changes, from the summary to the step's
  `enter`. `docs/security/05-add-ons.md` A1 is reworded to "after the content blocker step's
  `enter`".
- **Import.** The wizard is Firefox's: it reads other browsers' profiles on this computer and
  nothing leaves the machine. Vimma passes no source or data type to it.
- **Default browser.** Changes the user's own handler associations, only on `enter`, through
  Firefox's shell service and its policy check.
- **Network.** The setup sends requests only from the content blocker step (AMO, as today).
  The updates step changes whether Vimma asks `updates.vimma.dev` every 12 hours; "never
  check" stops it.
- **Private windows.** No setting step writes from a private window, and the layout guess and
  the chapter pref are not kept there.

## Tests

vitest, `packages/vimma-core/test/toml.test.ts` (`setTomlKeys`):

- `writes an array of strings, each escaped`
- `writes an empty array`

vitest, `packages/vimma-core/test/setup-steps.test.ts`:

- `every setting step's choices are a table, a key and a value the config schema accepts`
- `a step's text names no chord outside a {keys:} placeholder`
- `a step's placeholders name only the actions it declares`
- `keys are filled from the keymap: a rebound key shows, an unbound one is left out`
- `an action with no key is named by its command`
- `after a new prefix, the toolbar step shows the new prefix`
- `choosing the value in force plans no write`
- `skip plans no write`
- `the hint step selects the layout that matches the pressed keys, QWERTY otherwise`
- `the colours step writes source and appearance together`

vitest, `packages/vimma-core/test/setup.test.ts` (state machine):

- `enter on a setting step plans one write and opens the next step`
- `s moves on and plans nothing`
- `h returns to the previous step with the value in force selected`
- `q and esc close from every step and stop screen`
- `the last step of a chapter opens its stop screen`
- `a digit on the welcome screen opens that chapter`
- `with a config parse error, setting steps can only skip`

Mochitest, `tests/browser/browser_vimma_setup.js` (with `vimma.feature.setupV2` on until the
last slice):

- `welcome_says_q_leaves_and_finished_steps_are_saved`
- `enter_on_a_step_writes_its_key_and_applies_live`
- `leaving_mid_chapter_keeps_finished_steps`
- `closing_the_tab_keeps_finished_steps_and_writes_nothing_else`
- `enter_through_every_step_leaves_config_toml_unchanged`
- `skip_writes_nothing`
- `back_overwrites_one_key`
- `a_parse_error_writes_nothing_and_action_steps_still_work`
- `a_file_changed_meanwhile_is_not_written`
- `a_symlinked_config_toml_stays_a_link`
- `a_private_window_saves_nothing`
- `the_page_cannot_name_a_key_or_value`
- `content_blocker_installs_on_enter_with_the_permission_prompt`
- `address_bar_step_names_the_keys_in_force` (default keys, a rebound `focus_urlbar`, an unbound
  `alt+d`)
- `prefix_step_changes_later_steps_hints`
- `default_browser_step_calls_the_shell_service`
- `import_step_opens_the_migration_wizard`
- `agents_step_selects_off_first_and_writes_enabled_on_enter`
- `finished_chapters_are_ticked_on_the_next_run`
- `agent_role_cannot_open_setup` (kept)

e2e: the `setup-page` scenario gains screenshots of the welcome screen, one step, the address
bar step and a stop screen, with the Omarchy and light themes, checked by eye for the key hints,
the line the step writes and the footer before the baselines are accepted.

## Docs and changelog

- `docs/guide.md`, "First-run setup": rewritten for the chapters, saving on `enter`, `s`, `h`,
  `q`, and the chapter list.
- `docs/security/`: F1 in `08-config-toml.md`, A1 in `05-add-ons.md`, and how MCP is turned on
  in `12-agents-mcp.md`.
- [first-run-setup](first-run-setup.md): a "Since changed" note on decision 2 and behaviours 5
  and 6, pointing here, in the slice that turns setup v2 on.
- Changelog (from the last slice's commit subject): `feat(setup): setup in optional chapters
that save each step on enter`.

## Delivery

1. **Core: one config writer and the step table.** (#1292) `setTomlKeys` arrays,
   `ConfigHost.setConfigKeys` on `rewriteConfig`, `writeEngine` moved to it,
   `setup-steps.mjs` with the key-hint fill and its tests, `vimma.feature.setupV2`; no
   user-visible change.
2. **The chapter flow and the essentials** (#1293) behind the feature pref: welcome screen, step and
   stop screen layout, footer, `enter`/`s`/`h`/`q`/digits, saving per step, the parse-error,
   changed-meanwhile and private-window rules, the chapter pref, and chapter 1 (content blocker,
   search engine, colours). `docs/security/08-config-toml.md` F1 and `05-add-ons.md` A1; review
   by a fresh session.
3. **Moving in:** (#1294) the default browser and bring-your-data steps.
4. **The window:** (#1295) the address bar step with its key hints and window drawing.
5. **Your keys:** (#1296) the prefix, hint letters (layout guess) and Firefox's keys steps.
6. **Privacy and agents:** (#1297) the updates and agents steps; `docs/security/12-agents-mcp.md`;
   review by a fresh session.
7. **Turn it on:** (#1298) remove `vimma.feature.setupV2` and the summary flow, rewrite the guide
   section, e2e baselines, the "Since changed" note in first-run-setup, status `implemented`
   unless slice 8 is still open.
8. **The tab line step,** (#1299) once `[ui] tabline` is on `main` (decision 15).

## Open questions

The design above adopts the recommendation for each question; each may be revisited.

1. **Which steps are in the first version?** Options: the twelve steps of decision 11 (chapters
   Essentials, Moving in, The window, Your keys, Privacy and agents); all twenty-one steps in
   seven chapters; only the essentials. Trade-off: more steps cover more first-day settings but
   take longer to build and to sit through. Recommendation: the twelve, with Workspaces, Feel
   and the other steps after the alpha.
2. **Are the colours part of the essentials?** Options: yes, as the third essential; or in The
   window. Trade-off: the essentials stay at two steps without it, but the colours are the most
   visible choice and take one key. Recommendation: in the essentials.
3. **Where does Moving in go?** Options: right after the essentials; last. Trade-off: the
   default browser and the import matter most on the first day, but a user who only wants to
   try Vimma may not want them early. Recommendation: right after the essentials, since every
   chapter can be skipped from its stop screen.
4. **Is the agents step in setup before the alpha?** Options: in the first version, off
   preselected; left to the guide and `:mcp on`. Trade-off: the step makes a headline feature
   findable, at the cost of one more security-relevant step. Recommendation: include it, as
   drafted.
5. **Does setup v2 ship with the tab line, or first?** Options: wait for the tab line and ship
   both together; ship setup v2 first and add the tab line step when `[ui] tabline` lands.
   Trade-off: one release with both versus neither feature waiting. Recommendation: setup v2
   first, the tab line step as delivery slice 8.
