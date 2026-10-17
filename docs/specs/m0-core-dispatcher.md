# Spec: m0-core-dispatcher

Status: implemented · Milestone: M0 · Area: `packages/vimma-core`

## User story

As the vimma host, I hand every chrome-window `keydown` to `vimma-core` and get back exactly one
answer: run an action, wait for more keys, or let the key through. As a user, `prefix+?` lists
exactly the bindings the dispatcher uses.

## Scope

`packages/vimma-core/src/`:

| Module           | Exports                                                                         |
| ---------------- | ------------------------------------------------------------------------------- |
| `keys.mjs`       | `parseKey`, `formatKey`, `parseBinding`, `formatBinding`, `chordFromEvent`      |
| `actions.mjs`    | `ACTIONS` (closed set), `getAction`, `resolveActionName`                        |
| `defaults.mjs`   | `DEFAULT_CONFIG`, `formatDefaultsToml`                                          |
| `keymap.mjs`     | `compileKeymap` (defaults + user overrides → per-mode tries), `KeymapError`     |
| `dispatcher.mjs` | `createDispatcher` → `{ dispatch, flush, reset, pending, ambiguous }` (ADR-009) |
| `help.mjs`       | `bindingTable`, `filterBindings`, `renderHelpText`                              |
| `index.mjs`      | re-exports                                                                      |

`packages/vimma-core/defaults.toml` is generated (`npm run gen-docs`) and snapshot-tested.

## Key notation

- **Chord** = `{ key, ctrl, alt, shift, meta }`. Canonical text: modifiers in the order
  `ctrl+alt+shift+meta+`, then the key. Examples: `ctrl+b`, `shift+t`, `ctrl+alt+]`, `?`.
- Letters are stored lowercase; uppercase means shift (`T` ≡ `shift+t`). For other printable
  characters shift is part of the character and is dropped (`shift+?` ≡ `?`). (Since changed: a
  letter whose lower case is more than one character, `İ` (U+0130) whose lower case is `i̇`, is
  kept as typed and treated like other printable characters, because a stored key is one
  character; `normaliseKey` in `packages/vimma-core/src/keys.mjs`, #313.)
- Named keys: `esc`, `enter`, `tab`, `space`, `backspace`, `delete`, `up`, `down`, `left`,
  `right`, `home`, `end`, `pageup`, `pagedown`, `insert`, `f1`…`f12`; `minus` and `plus` are aliases
  for `-` and `+` (Herdr writes `prefix+minus`).
- **Binding** = sequence of chords. Accepted forms, which can be mixed:
  - Herdr: `prefix+c`, `prefix+shift+t`, `ctrl+i`, space-separated chords (`ctrl+w h`).
  - Vim: `gt`, `G`, `<leader>ff`, `<C-w>h`, `<Esc>`, `<S-Tab>`, `<Space>`.
  - `prefix` and `<leader>` are symbolic until compile time, so changing the prefix or leader
    rebinds everything that uses them.
- `formatBinding(parseBinding(s))` is canonical and `parseBinding(formatBinding(b))` round-trips
  (property test).

## Dispatcher contract

```js
dispatch(mode, chord) →
  | { kind: "action", action: { id, count?, arg? }, replay?: true }
  | { kind: "pending" }   // key consumed; more keys expected
  | { kind: "cancel" }    // key consumed; sequence aborted (unknown key after prefix, Esc in prefix)
  | { kind: "pass" }      // not ours; host lets the event continue
flush() → same union | null   // called by host after timeout_ms; resolves an ambiguous pending
ambiguous() → boolean         // true iff flush() would resolve to an action; only then does
                              // the host arm the timeout_ms timer (ADR-009)
```

`replay: true` means: run the action, then dispatch the same key again (see rule 5).

Change from plan §2: `cancel` and `replay` added. Without it, an unknown key after `ctrl+b` would either be
passed to the page (surprising) or would need a fake action.

Rules:

1. `[keys]` bindings whose first chord is `prefix` or carries ctrl/alt/meta are **global** (every
   mode). Other `[keys]` bindings (e.g. `<leader>n`) apply in `normal` mode only.
2. `[modal.<mode>]` bindings apply only in that mode and take precedence over globals there.
3. In `insert` mode only global bindings and `esc` (→ `mode.normal`) are consumed.
4. Counts: in `normal`/`visual`/`resize` (`resize` since [ADR-014](../adr/014-resize-mode.md)), digits `1-9` (then `0-9`) before a sequence become `count`,
   unless a binding in that mode starts with that digit. `3gt` → `{ id: "tab.next", count: 3 }`; the host gives a counted
   `tab.next` Vim semantics (go to tab 3).
   Modes: `normal`, `insert`, `visual`, `command`, `hint`, `help`, `panel` and, since ADR-014,
   `resize` (pane resize mode, `prefix+r`).
5. Ambiguity: if the buffer is a complete binding _and_ a prefix of a longer one, return
   `pending`; the next key decides, or `flush()` resolves to the shorter one. If the next key
   does not continue the sequence, the shorter binding's action is returned with `replay: true`.
   Defaults contain no ambiguous sequences (property test); only user config can introduce them.
6. A key that matches nothing in the middle of a sequence → `cancel` (after prefix) or `pass` for
   a modal sequence's first key. A dead modal sequence (`g` then `z`) → `cancel`.
7. `esc` while a sequence is pending → `cancel`.
8. `dispatch` is O(sequence length); no allocation-heavy work per key (bench target < 50 µs).

## Config input (pre-TOML)

`compileKeymap(userConfig)` takes the object a TOML parser would produce (`{ keys, modal, unbind }`)
and merges it over `DEFAULT_CONFIG`. Setting an action in `[keys]` **replaces** its default chord
list, as in Herdr. Errors (`KeymapError` with `path` and `suggestion`):

- unknown action name → suggestion from closest `ACTIONS` name (edit distance);
- unparsable key notation;
- the same sequence bound to two different actions in one mode.

File and line numbers are added by the TOML layer in M5; this spec carries the config path
(`keys.new_tab[1]`).

## Help table

`bindingTable(keymap)` → rows `{ id, name, group, description, bindings: string[], overridden }`
in `ACTIONS` order; `filterBindings(rows, query)` does case-insensitive substring match over name,
description and bindings; `renderHelpText(rows)` produces the plain-text table (snapshot-tested)
that the overlay and `docs/bindings.md` reuse.

## Acceptance criteria

- Given defaults, when `ctrl+b` then `?` in `normal`, then `help.show` is returned after `pending`.
- Given defaults, when `ctrl+b` then `?` in `insert`, then `help.show` (prefix layer is global).
- Given defaults, when `j` in `insert`, then `pass`.
- Given defaults, when `ctrl+b` then `3`, then `{ id: "tab.goto", arg: 3 }`.
- Given defaults, when `3`, `g`, `t` in normal, then `{ id: "tab.next", count: 3 }`; `g`, `t` →
  `{ id: "tab.next" }`.
- Given defaults, when `ctrl+b` then `y` (unbound), then `cancel`.
- Given defaults, when `ctrl+b` then `esc`, then `cancel`.
- Given prefix `ctrl+a`, when `ctrl+b` then `c`, then `pass`; `ctrl+a`, `c` → `tab.new`.
- Given `g` → X and `gg` → Y, when `g` then `flush()`, then X.
- Given `toggle_sidebar = ["prefix+b", "<leader>n"]`, when `space` `n` in normal, then
  `sidebar.toggle` (the defaults have no leader binding, so there `space` passes).
- Given `[keys] new_tab = ["ctrl+alt+c"]`, then `prefix+c` no longer opens a tab.
- Given `[keys] new_tabb`, then `KeymapError` suggesting `new_tab`.
- Given defaults, then no sequence is bound twice in a mode (property).
- `formatKey(parseKey(x))` round-trips for generated chords (property).
- Coverage ≥ 90 % lines/branches on `packages/vimma-core`.

## Out of scope

TOML parsing (M5), the host listener (`m0-key-capture`), the overlay UI (`m0-help-overlay`),
action implementations.

## Open notes

- Herdr names verified from https://herdr.dev/docs/keyboard/: `new_tab`, `split_vertical`,
  `split_horizontal`, `focus_pane_{left,down,up,right}`, `zoom`, `resize_mode`, `copy_mode`,
  `next_tab`, `previous_tab`, `rename_tab`, `close_tab`, `new_workspace`, `rename_workspace`,
  `close_workspace`, `goto_picker`, `toggle_sidebar`. The docs only show these with wildcards, so the
  following names are our guess: `select_tab_1..9`, `swap_pane_*`, `close_pane`,
  `workspace_picker`, `show_keybinds`, `next_workspace`, `previous_workspace` (alias
  `prev_workspace`, as written in plan §2).
