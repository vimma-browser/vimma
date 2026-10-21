# Default bindings

Generated from `packages/vimma-core/src/actions.mjs` and `defaults.mjs` by `npm run gen-docs`; do not edit.

Keys as you press them, with the default keys filled in (`prefix = ctrl+b`).
A `[mode]` after a key means it works only in that mode. In `config.toml` the same bindings
are written in notation: `ctrl+b b` is `prefix+b`; a leader binding you add, `<leader>n`,
shows as `space n` ([guide](guide.md#configtoml)).

## Help

| Action                            | Config name     | Bindings                 |
| --------------------------------- | --------------- | ------------------------ |
| Show all bindings (filter with /) | `show_keybinds` | `ctrl+b ?`               |
| Close the bindings overlay        | `help_close`    | `esc [help]`, `q [help]` |
| Filter the bindings overlay       | `help_filter`   | `/ [help]`               |

## Tabs

| Action                                 | Config name       | Bindings                                          |
| -------------------------------------- | ----------------- | ------------------------------------------------- |
| New tab                                | `new_tab`         | `ctrl+b c`, `ctrl+t`, `t`                         |
| Next tab (with a count: go to tab N)   | `next_tab`        | `ctrl+b n`, `ctrl+tab`, `ctrl+pagedown`, `gt`     |
| Previous tab                           | `previous_tab`    | `ctrl+b p`, `ctrl+shift+tab`, `ctrl+pageup`, `gT` |
| Jump to tab 1 in this workspace        | `select_tab_1`    | `ctrl+b 1`, `alt+1`                               |
| Jump to tab 2 in this workspace        | `select_tab_2`    | `ctrl+b 2`, `alt+2`                               |
| Jump to tab 3 in this workspace        | `select_tab_3`    | `ctrl+b 3`, `alt+3`                               |
| Jump to tab 4 in this workspace        | `select_tab_4`    | `ctrl+b 4`, `alt+4`                               |
| Jump to tab 5 in this workspace        | `select_tab_5`    | `ctrl+b 5`, `alt+5`                               |
| Jump to tab 6 in this workspace        | `select_tab_6`    | `ctrl+b 6`, `alt+6`                               |
| Jump to tab 7 in this workspace        | `select_tab_7`    | `ctrl+b 7`, `alt+7`                               |
| Jump to tab 8 in this workspace        | `select_tab_8`    | `ctrl+b 8`, `alt+8`                               |
| Jump to tab 9 in this workspace        | `select_tab_9`    | `ctrl+b 9`                                        |
| Rename tab                             | `rename_tab`      | `ctrl+b shift+t`                                  |
| Close tab                              | `close_tab`       | `ctrl+b shift+x`, `ctrl+f4`, `x`                  |
| Jump to the last tab in this workspace | `select_last_tab` | `alt+9`                                           |
| Move the tab left                      | `move_tab_left`   | `ctrl+shift+pageup`                               |
| Move the tab right                     | `move_tab_right`  | `ctrl+shift+pagedown`                             |
| Reopen the last closed tab             | `restore_tab`     | `ctrl+shift+t`                                    |

## Panes

| Action                                       | Config name              | Bindings                                                 |
| -------------------------------------------- | ------------------------ | -------------------------------------------------------- |
| Split right                                  | `split_vertical`         | `ctrl+b v`                                               |
| Split down                                   | `split_horizontal`       | `ctrl+b -`                                               |
| Focus pane to the left                       | `focus_pane_left`        | `ctrl+b h`, `ctrl+w h`                                   |
| Focus pane below                             | `focus_pane_down`        | `ctrl+b j`, `ctrl+w j`                                   |
| Focus pane above                             | `focus_pane_up`          | `ctrl+b k`, `ctrl+w k`                                   |
| Focus pane to the right                      | `focus_pane_right`       | `ctrl+b l`, `ctrl+w l`                                   |
| Swap with pane to the left                   | `swap_pane_left`         | `ctrl+b shift+h`, `ctrl+w H`                             |
| Swap with pane below                         | `swap_pane_down`         | `ctrl+b shift+j`, `ctrl+w J`                             |
| Swap with pane above                         | `swap_pane_up`           | `ctrl+b shift+k`, `ctrl+w K`                             |
| Swap with pane to the right                  | `swap_pane_right`        | `ctrl+b shift+l`, `ctrl+w L`                             |
| Zoom pane                                    | `zoom`                   | `ctrl+b z`, `ctrl+w o`                                   |
| Close pane; the last pane closes the tab     | `close_pane`             | `ctrl+b x`                                               |
| Resize mode                                  | `resize_mode`            | `ctrl+b r`                                               |
| Leave resize mode                            | `resize_exit`            | `esc [resize]`, `enter [resize]`, `q [resize]`           |
| Make pane narrower                           | `resize_narrower`        | `ctrl+w <`, `h [resize]`, `left [resize]`, `< [resize]`  |
| Make pane wider                              | `resize_wider`           | `ctrl+w >`, `l [resize]`, `right [resize]`, `> [resize]` |
| Make pane taller                             | `resize_taller`          | `ctrl+w +`, `j [resize]`, `down [resize]`, `+ [resize]`  |
| Make pane shorter                            | `resize_shorter`         | `ctrl+w -`, `k [resize]`, `up [resize]`, `- [resize]`    |
| New pane, along the longer side              | `new_pane`               | `ctrl+b enter`                                           |
| Next layout                                  | `next_layout`            | `ctrl+b space`                                           |
| Apply a layout preset by name (:layout name) | `select_layout`          | —                                                        |
| Layout: all side by side                     | `layout_even_horizontal` | —                                                        |
| Layout: all stacked                          | `layout_even_vertical`   | —                                                        |
| Layout: main pane left, rest stacked         | `layout_main_vertical`   | —                                                        |
| Layout: main pane on top, rest below         | `layout_main_horizontal` | —                                                        |
| Layout: a grid                               | `layout_tiled`           | —                                                        |
| Layout: a spiral (dwindle)                   | `layout_dwindle`         | —                                                        |

## Workspaces

| Action                                                            | Config name          | Bindings                                        |
| ----------------------------------------------------------------- | -------------------- | ----------------------------------------------- |
| Next workspace                                                    | `next_workspace`     | `ctrl+b )`, `]w`                                |
| Previous workspace                                                | `previous_workspace` | `ctrl+b (`, `[w`                                |
| Previous workspace you were in; again toggles back (Vim's ctrl+^) | `last_workspace`     | `ctrl+b ^`, `ctrl+b ctrl+6`, `ctrl+^`, `ctrl+6` |
| Switch to a workspace by name or number                           | `switch_workspace`   | —                                               |
| Workspace picker                                                  | `workspace_picker`   | `ctrl+b w`                                      |
| New workspace                                                     | `new_workspace`      | `ctrl+b shift+n`                                |
| Rename workspace                                                  | `rename_workspace`   | `ctrl+b shift+w`                                |
| Close workspace                                                   | `close_workspace`    | `ctrl+b shift+d`                                |
| Move the tab to another workspace (reopens it there)              | `move_to_workspace`  | —                                               |
| Routing rules: list them; :route add [workspace], :route move     | `route_rules`        | —                                               |
| Private workspace (a private window); again goes back             | `private_workspace`  | `ctrl+b shift+p`, `ctrl+shift+p`                |

## Navigation

| Action                                                | Config name        | Bindings                                          |
| ----------------------------------------------------- | ------------------ | ------------------------------------------------- |
| Tab search: every tab, every window, recently closed  | `goto_picker`      | `ctrl+b g`, `b`                                   |
| Open / close the side panel                           | `toggle_sidebar`   | `ctrl+b b`                                        |
| Show / hide the toolbar (URL bar and add-on buttons)  | `toggle_toolbar`   | `ctrl+b u`                                        |
| Show the toolbar                                      | `show_toolbar`     | —                                                 |
| Hide the toolbar (the address bar shows when focused) | `hide_toolbar`     | —                                                 |
| Scroll down                                           | `scroll_down`      | `j`, `ctrl+e`                                     |
| Scroll up                                             | `scroll_up`        | `k`, `ctrl+y`                                     |
| Scroll left                                           | `scroll_left`      | `h`                                               |
| Scroll right                                          | `scroll_right`     | `l`                                               |
| Scroll half a page down                               | `scroll_half_down` | `d`, `ctrl+d`                                     |
| Scroll half a page up                                 | `scroll_half_up`   | `u`, `ctrl+u`                                     |
| Scroll to top                                         | `scroll_top`       | `gg`                                              |
| Scroll to bottom                                      | `scroll_bottom`    | `G`                                               |
| Go back                                               | `history_back`     | `alt+left`, `H`, `ctrl+o`, `ctrl+[`               |
| Go forward                                            | `history_forward`  | `alt+right`, `L`, `ctrl+i`, `ctrl+]`              |
| Reload page                                           | `reload`           | `f5`, `ctrl+r`, `r`                               |
| Open a URL or search in this tab                      | `open_url`         | —                                                 |
| Go up a level in the URL path                         | `url_up`           | `gu`                                              |
| Go to the site's root                                 | `url_root`         | `gU`                                              |
| Focus the address bar, its text selected              | `focus_urlbar`     | `ctrl+l`, `alt+d`, `I`, `I [visual]`, `I [panel]` |

## Page

| Action                                             | Config name          | Bindings |
| -------------------------------------------------- | -------------------- | -------- |
| Copy the page's URL                                | `yank_url`           | `yy`     |
| Open the clipboard's URL or search in this tab     | `open_clipboard`     | `p`      |
| Open the clipboard's URL or search in a new tab    | `open_clipboard_tab` | `P`      |
| Focus the first text field (with a count: the Nth) | `focus_input`        | `gi`     |
| View the page's source in a new tab                | `view_source`        | `gf`     |

## Browser

| Action                                            | Config name                | Bindings                  |
| ------------------------------------------------- | -------------------------- | ------------------------- |
| New window                                        | `new_window`               | `ctrl+n`                  |
| Close the window                                  | `close_window`             | `ctrl+shift+w`            |
| Reopen the last closed window                     | `restore_window`           | `ctrl+shift+n`            |
| Quit (asks first)                                 | `quit`                     | `ctrl+q`                  |
| Check for a newer Vimma                           | `check_updates`            | —                         |
| Restart Vimma; an installed update applies        | `restart`                  | —                         |
| Reload, bypassing the cache                       | `reload_hard`              | `ctrl+f5`, `ctrl+shift+r` |
| Stop loading the page                             | `stop_loading`             | `esc`                     |
| Run a Firefox command or key by its id (:firefox) | `firefox_command`          | —                         |
| Go to the home page                               | `go_home`                  | `alt+home`                |
| Zoom the page in                                  | `page_zoom_in`             | `ctrl+plus`, `ctrl+=`     |
| Zoom the page out                                 | `page_zoom_out`            | `ctrl+minus`, `ctrl+_`    |
| Reset the page's zoom                             | `page_zoom_reset`          | `ctrl+0`                  |
| Full screen, or leave it                          | `toggle_fullscreen`        | `f11`                     |
| Save the page                                     | `save_page`                | `ctrl+s`                  |
| Print the page                                    | `print_page`               | `ctrl+p`                  |
| Downloads (the Library)                           | `downloads`                | `ctrl+shift+y`            |
| Add-ons manager (about:addons)                    | `addons_manager`           | `ctrl+shift+a`            |
| History (the Library)                             | `history_library`          | `ctrl+shift+h`            |
| Bookmarks (the Library)                           | `bookmarks_library`        | `ctrl+shift+o`            |
| Mute or unmute the tab                            | `mute_tab`                 | `ctrl+m`                  |
| Picture-in-Picture                                | `picture_in_picture`       | `ctrl+}`                  |
| Reader View                                       | `reader_view`              | `ctrl+alt+r`              |
| Take a screenshot                                 | `screenshot`               | `ctrl+shift+s`            |
| Clear recent history                              | `clear_history`            | `ctrl+shift+delete`       |
| Web search (the address bar's search)             | `web_search`               | `ctrl+j`                  |
| Process manager (about:processes)                 | `about_processes`          | `shift+esc`               |
| Bookmark all tabs                                 | `bookmark_all_tabs`        | `ctrl+shift+d`            |
| Show / hide the bookmarks toolbar                 | `toggle_bookmarks_toolbar` | `ctrl+shift+b`            |
| Firefox sidebar: AI chatbot                       | `ai_chatbot_sidebar`       | `ctrl+alt+x`              |
| Firefox sidebar: tabs from other devices          | `open_tabs_sidebar`        | `ctrl+alt+u`              |
| Show / hide Firefox's sidebar                     | `toggle_firefox_sidebar`   | `ctrl+alt+z`              |
| Switch a text field's direction                   | `switch_text_direction`    | `ctrl+shift+x`            |
| Caret browsing (asks first)                       | `caret_browsing`           | `f7`                      |

## Developer tools

| Action                           | Config name              | Bindings              |
| -------------------------------- | ------------------------ | --------------------- |
| Open / close the developer tools | `devtools`               | `ctrl+shift+i`, `f12` |
| Browser Toolbox                  | `browser_toolbox`        | `ctrl+alt+shift+i`    |
| Browser Console                  | `browser_console`        | `ctrl+shift+j`        |
| Responsive Design Mode           | `responsive_design`      | `ctrl+shift+m`        |
| Developer tools: Inspector       | `devtools_inspector`     | `ctrl+shift+c`        |
| Developer tools: Web Console     | `devtools_console`       | `ctrl+shift+k`        |
| Developer tools: Debugger        | `devtools_debugger`      | `ctrl+shift+z`        |
| Developer tools: Network         | `devtools_network`       | `ctrl+shift+e`        |
| Developer tools: Style Editor    | `devtools_style_editor`  | `shift+f7`            |
| Developer tools: Performance     | `devtools_performance`   | `shift+f5`            |
| Developer tools: Storage         | `devtools_storage`       | `shift+f9`            |
| Developer tools: Accessibility   | `devtools_accessibility` | `shift+f12`           |
| Developer tools: DOM             | `devtools_dom`           | —                     |

## Hints

| Action                 | Config name           | Bindings     |
| ---------------------- | --------------------- | ------------ |
| Follow link            | `follow_link`         | `f`          |
| Follow link in new tab | `follow_link_new_tab` | `F`          |
| Focus a text block     | `focus_element`       | —            |
| Leave hint mode        | `hint_cancel`         | `esc [hint]` |

## Find

| Action                                             | Config name     | Bindings                        |
| -------------------------------------------------- | --------------- | ------------------------------- |
| Search in page                                     | `find_forward`  | `ctrl+f`, `/`                   |
| Search backwards in page                           | `find_backward` | `?`                             |
| Next match                                         | `find_next`     | `ctrl+g`, `f3`, `n`             |
| Previous match                                     | `find_previous` | `ctrl+shift+g`, `shift+f3`, `N` |
| Live grep: search the text of the workspace's tabs | `live_grep`     | `ctrl+b f g`                    |
| Next result of the last live grep                  | `grep_next`     | `]q`                            |
| Previous result of the last live grep              | `grep_previous` | `[q`                            |
| Live grep again with the last query (:grep)        | `grep_resume`   | —                               |

## Modes

| Action                                 | Config name      | Bindings                       |
| -------------------------------------- | ---------------- | ------------------------------ |
| Back to normal mode                    | `normal_mode`    | `esc [insert]`, `esc [visual]` |
| Insert mode: focus the last-used input | `insert_mode`    | `i`                            |
| Copy mode (caret browsing + selection) | `copy_mode`      | `ctrl+b [`, `v`                |
| Command line                           | `command_line`   | `:`                            |
| Close the command line                 | `command_cancel` | `esc [command]`                |

## Copy mode

| Action                                      | Config name           | Bindings      |
| ------------------------------------------- | --------------------- | ------------- |
| Move caret left                             | `caret_left`          | `h [visual]`  |
| Move caret down                             | `caret_down`          | `j [visual]`  |
| Move caret up                               | `caret_up`            | `k [visual]`  |
| Move caret right                            | `caret_right`         | `l [visual]`  |
| Move caret a word forward                   | `caret_word_forward`  | `w [visual]`  |
| Move caret a word back                      | `caret_word_backward` | `b [visual]`  |
| Move caret to the start of the line         | `caret_line_start`    | `0 [visual]`  |
| Move caret to the end of the line           | `caret_line_end`      | `$ [visual]`  |
| Move caret to the top of the page           | `caret_top`           | `gg [visual]` |
| Move caret to the bottom of the page        | `caret_bottom`        | `G [visual]`  |
| Move caret to the end of the word           | `caret_word_end`      | `e [visual]`  |
| Move caret to the previous word's end       | `caret_prev_word_end` | `ge [visual]` |
| Move caret to the next WORD (by spaces)     | `caret_bigword_next`  | `W [visual]`  |
| Move caret to the WORD's start              | `caret_bigword_back`  | `B [visual]`  |
| Move caret to the end of the WORD           | `caret_bigword_end`   | `E [visual]`  |
| Move caret to the line's first non-blank    | `caret_first_char`    | `^ [visual]`  |
| Move caret to the paragraph's start         | `caret_para_back`     | `{ [visual]`  |
| Move caret to the paragraph's end           | `caret_para_next`     | `} [visual]`  |
| Find a character forward on the line        | `caret_find_forward`  | `f [visual]`  |
| Find a character backward on the line       | `caret_find_backward` | `F [visual]`  |
| Till a character forward on the line        | `caret_till_forward`  | `t [visual]`  |
| Till a character backward on the line       | `caret_till_backward` | `T [visual]`  |
| Repeat the last f, F, t or T                | `caret_find_repeat`   | `; [visual]`  |
| Repeat the last find, reversed              | `caret_find_reverse`  | `, [visual]`  |
| Start or drop a selection at the caret      | `toggle_selection`    | `v [visual]`  |
| Start or drop a line-wise selection         | `line_selection`      | `V [visual]`  |
| Swap the selection's ends                   | `swap_selection_ends` | `o [visual]`  |
| Select the word at the caret                | `select_inner_word`   | `iw [visual]` |
| Select the word at the caret and its spaces | `select_a_word`       | `aw [visual]` |
| Copy selection and leave copy mode          | `yank_selection`      | `y [visual]`  |
| Copy the selection's whole lines and leave  | `yank_lines`          | `Y [visual]`  |

## Side panel

| Action                                                                              | Config name       | Bindings        |
| ----------------------------------------------------------------------------------- | ----------------- | --------------- |
| Select row 1                                                                        | `panel_select_1`  | `1 [panel]`     |
| Select row 2                                                                        | `panel_select_2`  | `2 [panel]`     |
| Select row 3                                                                        | `panel_select_3`  | `3 [panel]`     |
| Select row 4                                                                        | `panel_select_4`  | `4 [panel]`     |
| Select row 5                                                                        | `panel_select_5`  | `5 [panel]`     |
| Select row 6                                                                        | `panel_select_6`  | `6 [panel]`     |
| Select row 7                                                                        | `panel_select_7`  | `7 [panel]`     |
| Select row 8                                                                        | `panel_select_8`  | `8 [panel]`     |
| Select row 9                                                                        | `panel_select_9`  | `9 [panel]`     |
| Next row                                                                            | `panel_down`      | `j [panel]`     |
| Previous row                                                                        | `panel_up`        | `k [panel]`     |
| Apply the marks (the marked tabs become the panes), then go to the selected row     | `panel_open`      | `enter [panel]` |
| End the range, clear or restore the marks, or close the side panel                  | `panel_close`     | `esc [panel]`   |
| Close the selected tab; the panel stays open                                        | `panel_close_tab` | `x [panel]`     |
| Mark or unmark the selected tab                                                     | `panel_mark`      | `space [panel]` |
| Start a range of rows to mark, or mark it                                           | `panel_visual`    | `V [panel]`     |
| Move the selected row's tab to a workspace (picker); in bookmarks, move to a folder | `panel_move_tab`  | `m [panel]`     |

## Bookmarks

| Action                                                 | Config name          | Bindings         |
| ------------------------------------------------------ | -------------------- | ---------------- |
| Open / close the bookmarks panel                       | `toggle_bookmarks`   | `ctrl+b shift+b` |
| Bookmark this page (folders/title files it in folders) | `add_bookmark`       | `ctrl+b a`       |
| Bookmarks: close the folder, or go to its parent       | `bookmarks_collapse` | `h [panel]`      |
| Bookmarks: open the folder or the bookmark             | `bookmarks_expand`   | `l [panel]`      |
| Bookmarks: open in a new background tab                | `bookmarks_open_tab` | `t [panel]`      |
| Bookmarks: open in a split right                       | `bookmarks_vsplit`   | `s [panel]`      |
| Bookmarks: open in a split below                       | `bookmarks_hsplit`   | `S [panel]`      |
| Bookmarks: add this page here (a/b/ makes folders)     | `bookmarks_add`      | `a [panel]`      |
| Bookmarks: add a folder here                           | `bookmarks_folder`   | `A [panel]`      |
| Bookmarks: rename                                      | `bookmarks_rename`   | `r [panel]`      |
| Bookmarks: move to a folder                            | `bookmarks_move`     | —                |
| Bookmarks: delete (asks y/N)                           | `bookmarks_delete`   | `d [panel]`      |
| Bookmarks: copy the URL                                | `bookmarks_yank`     | `y [panel]`      |
| Bookmarks: filter                                      | `bookmarks_filter`   | `/ [panel]`      |

## Config

| Action                                               | Config name        | Bindings |
| ---------------------------------------------------- | ------------------ | -------- |
| Reload config                                        | `reload_config`    | —        |
| Open config.toml in a tab                            | `edit_config`      | —        |
| Open the first-run setup (add-ons, search engine)    | `setup`            | —        |
| Built-in theme: dark, light or the system's (:theme) | `theme_appearance` | —        |

## Agents

| Action                                                 | Config name       | Bindings         |
| ------------------------------------------------------ | ----------------- | ---------------- |
| Agents (MCP): :mcp on, off or forget                   | `mcp_command`     | —                |
| Answer the waiting agent request (none: revoke grants) | `agent_prompt`    | `ctrl+b shift+a` |
| Full control for a while: :control on <minutes>, off   | `control_command` | —                |

## Add-ons

| Action                                                | Config name    | Bindings   |
| ----------------------------------------------------- | -------------- | ---------- |
| Add-on picker: popup, options, on/off, remove, update | `addon_picker` | `ctrl+b e` |
| Open an add-on's popup by name (:addon name)          | `addon_popup`  | —          |

## Firefox's shortcuts

Every key Firefox handles in a Linux browser window, and what it does in Vimma. Most are
Vimma bindings with Firefox's meaning (above, rebindable by name); **page first** means a
page that uses the key itself (`ctrl+s` in an editor) gets it first, as in Firefox. Keys
Vimma does not bind stay Firefox's, unless `[firefox] disable` in config.toml lists them
([guide](guide.md#firefoxs-own-shortcuts)); the field's and the platform's own keys are
unchanged.

| Key                   | Firefox                                     | In Vimma                                    |
| --------------------- | ------------------------------------------- | ------------------------------------------- |
| `ctrl+n`              | new window                                  | `new_window`                                |
| `ctrl+t`              | new tab                                     | `new_tab`                                   |
| `ctrl+l`              | focus the address bar                       | `focus_urlbar`, page first                  |
| `alt+d`               | focus the address bar                       | `focus_urlbar`, page first                  |
| `ctrl+k`              | web search                                  | Vimma's own key                             |
| `ctrl+j`              | web search                                  | `web_search`, page first                    |
| `ctrl+shift+y`        | Library: downloads                          | `downloads`, page first                     |
| `ctrl+shift+a`        | add-ons manager                             | `addons_manager`, page first                |
| `ctrl+o`              | open a file                                 | `history_back` (normal mode)                |
| `ctrl+s`              | save page                                   | `save_page`, page first                     |
| `ctrl+p`              | print                                       | `print_page`, page first                    |
| `ctrl+w`              | close tab                                   | Vimma's own key                             |
| `ctrl+shift+w`        | close window                                | `close_window`                              |
| `ctrl+m`              | mute the tab                                | `mute_tab`, page first                      |
| `ctrl+z`              | undo in a field                             | unchanged                                   |
| `ctrl+shift+z`        | redo in a field                             | unchanged                                   |
| `ctrl+x`              | cut                                         | unchanged                                   |
| `ctrl+c`              | copy                                        | unchanged                                   |
| `ctrl+v`              | paste                                       | unchanged                                   |
| `ctrl+a`              | select all                                  | unchanged                                   |
| `delete`              | delete in chrome fields                     | unchanged                                   |
| `backspace`           | nothing (browser.backspace_action = 2)      | unchanged                                   |
| `shift+backspace`     | nothing (browser.backspace_action = 2)      | unchanged                                   |
| `alt+left`            | back                                        | `history_back`, page first                  |
| `alt+right`           | forward                                     | `history_forward`, page first               |
| `ctrl+[`              | back                                        | `history_back` (normal mode), page first    |
| `ctrl+]`              | forward                                     | `history_forward` (normal mode), page first |
| `alt+home`            | home page                                   | `go_home`, page first                       |
| `f5`                  | reload                                      | `reload`, page first                        |
| `ctrl+shift+h`        | Library: history                            | `history_library`, page first               |
| `ctrl+f5`             | reload, bypassing the cache                 | `reload_hard`, page first                   |
| `f11`                 | full screen                                 | `toggle_fullscreen`, page first             |
| `f11`                 | leave full screen (in full screen)          | `toggle_fullscreen`                         |
| `ctrl+alt+r`          | Reader View                                 | `reader_view`, page first                   |
| `ctrl+}`              | Picture-in-Picture                          | `picture_in_picture`, page first            |
| `ctrl+}`              | Picture-in-Picture (where } is another key) | `picture_in_picture`, page first            |
| `ctrl+r`              | reload                                      | `reload`, page first                        |
| `ctrl+shift+r`        | reload, bypassing the cache                 | `reload_hard`, page first                   |
| `shift+esc`           | about:processes                             | `about_processes` (normal mode), page first |
| `ctrl+u`              | view source                                 | `scroll_half_up` (normal mode)              |
| `ctrl+i`              | Page Info                                   | `history_forward` (normal mode)             |
| `ctrl+f`              | find in page                                | `find_forward`, page first                  |
| `ctrl+g`              | next match                                  | `find_next`, page first                     |
| `ctrl+shift+g`        | previous match                              | `find_previous`, page first                 |
| `f3`                  | next match                                  | `find_next`, page first                     |
| `shift+f3`            | previous match                              | `find_previous`, page first                 |
| `ctrl+d`              | bookmark the page                           | `scroll_half_down` (normal mode)            |
| `ctrl+shift+d`        | bookmark all tabs                           | `bookmark_all_tabs`, page first             |
| `ctrl+shift+o`        | Library: bookmarks                          | `bookmarks_library`, page first             |
| `ctrl+b`              | bookmarks sidebar                           | Vimma's own key                             |
| `ctrl+shift+b`        | show or hide the bookmarks toolbar          | `toggle_bookmarks_toolbar`, page first      |
| `esc`                 | stop loading                                | `stop_loading` (normal mode), page first    |
| `ctrl+alt+x`          | AI chatbot sidebar                          | `ai_chatbot_sidebar`, page first            |
| `ctrl+alt+u`          | open-tabs sidebar                           | `open_tabs_sidebar`, page first             |
| `ctrl+alt+z`          | toggle the sidebar                          | `toggle_firefox_sidebar`, page first        |
| `ctrl+h`              | history sidebar                             | Vimma's own key                             |
| `ctrl+minus`          | zoom out                                    | `page_zoom_out`, page first                 |
| `ctrl+_`              | zoom out                                    | `page_zoom_out`, page first                 |
| `ctrl+plus`           | zoom in                                     | `page_zoom_in`, page first                  |
| `ctrl+=`              | zoom in                                     | `page_zoom_in`, page first                  |
| `ctrl+0`              | reset zoom                                  | `page_zoom_reset`, page first               |
| `ctrl+shift+tab`      | previous tab                                | `previous_tab`                              |
| `ctrl+shift+x`        | flip a field's text direction               | `switch_text_direction`, page first         |
| `ctrl+shift+p`        | new private window                          | `private_workspace`                         |
| `ctrl+shift+s`        | screenshot                                  | `screenshot`, page first                    |
| `ctrl+shift+delete`   | clear recent history                        | `clear_history`, page first                 |
| `ctrl+q`              | quit (asks first)                           | `quit`                                      |
| `ctrl+shift+t`        | reopen the closed tab                       | `restore_tab`, page first                   |
| `ctrl+shift+n`        | reopen the closed window                    | `restore_window`, page first                |
| `alt+1`               | tab 1                                       | `select_tab_1`, page first                  |
| `alt+2`               | tab 2                                       | `select_tab_2`, page first                  |
| `alt+3`               | tab 3                                       | `select_tab_3`, page first                  |
| `alt+4`               | tab 4                                       | `select_tab_4`, page first                  |
| `alt+5`               | tab 5                                       | `select_tab_5`, page first                  |
| `alt+6`               | tab 6                                       | `select_tab_6`, page first                  |
| `alt+7`               | tab 7                                       | `select_tab_7`, page first                  |
| `alt+8`               | tab 8                                       | `select_tab_8`, page first                  |
| `alt+9`               | last tab                                    | `select_last_tab`, page first               |
| `ctrl+alt+r`          | restart (developer builds)                  | unbound (only in some builds)               |
| `ctrl+#`              | WebRender capture                           | unbound (only in some builds)               |
| `ctrl+^`              | WebRender capture sequence                  | unbound (only in some builds)               |
| `ctrl+$`              | window recording (Nightly)                  | unbound (only in some builds)               |
| `ctrl+shift+i`        | toggle the toolbox                          | `devtools`, page first                      |
| `f12`                 | toggle the toolbox                          | `devtools`, page first                      |
| `ctrl+alt+shift+i`    | Browser Toolbox                             | `browser_toolbox`, page first               |
| `ctrl+shift+j`        | Browser Console                             | `browser_console`, page first               |
| `ctrl+shift+m`        | Responsive Design Mode                      | `responsive_design`, page first             |
| `ctrl+shift+c`        | Inspector                                   | `devtools_inspector`, page first            |
| `ctrl+shift+k`        | Web Console                                 | `devtools_console`, page first              |
| `ctrl+shift+z`        | Debugger (redo in a field)                  | `devtools_debugger`, page first             |
| `ctrl+shift+e`        | Network                                     | `devtools_network`, page first              |
| `shift+f7`            | Style Editor                                | `devtools_style_editor`, page first         |
| `shift+f5`            | Performance                                 | `devtools_performance`, page first          |
| `shift+f9`            | Storage                                     | `devtools_storage`, page first              |
| `ctrl+shift+w`        | DOM panel (close window wins)               | `devtools_dom`, page first                  |
| `shift+f12`           | Accessibility panel                         | `devtools_accessibility`, page first        |
| `ctrl+!`              | start or stop the profiler                  | unbound (only in some builds)               |
| `ctrl+@`              | capture a profile                           | unbound (only in some builds)               |
| `ctrl+alt+!`          | start or stop the profiler                  | unbound (only in some builds)               |
| `ctrl+alt+@`          | capture a profile                           | unbound (only in some builds)               |
| `ctrl+%`              | JavaScript tracer                           | unbound (only in some builds)               |
| `ctrl+tab`            | next tab (or the recent-tabs panel)         | `next_tab`                                  |
| `ctrl+pagedown`       | next tab                                    | `next_tab`                                  |
| `ctrl+pageup`         | previous tab                                | `previous_tab`                              |
| `ctrl+shift+pagedown` | move the tab right                          | `move_tab_right`                            |
| `ctrl+shift+pageup`   | move the tab left                           | `move_tab_left`                             |
| `ctrl+f4`             | close the tab                               | `close_tab`                                 |
| `f7`                  | caret browsing (asks first)                 | `caret_browsing`, page first                |
| `ctrl+f7`             | caret browsing (asks first)                 | unbound                                     |
| `alt+f7`              | caret browsing (asks first)                 | unbound                                     |
| `ctrl+alt+f7`         | caret browsing (asks first)                 | unbound                                     |
| `meta+f7`             | caret browsing (asks first)                 | unbound                                     |
| `ctrl+meta+f7`        | caret browsing (asks first)                 | unbound                                     |
| `alt+meta+f7`         | caret browsing (asks first)                 | unbound                                     |
| `ctrl+alt+meta+f7`    | caret browsing (asks first)                 | unbound                                     |
| `alt+f`               | open a menu                                 | unchanged                                   |
| `alt+e`               | open a menu                                 | unchanged                                   |
| `alt+v`               | open a menu                                 | unchanged                                   |
| `alt+s`               | open a menu                                 | unchanged                                   |
| `alt+b`               | open a menu                                 | unchanged                                   |
| `alt+t`               | open a menu                                 | unchanged                                   |
| `alt+h`               | open a menu                                 | unchanged                                   |
| `alt+p`               | open the Profiles menu                      | unchanged                                   |
| `'`                   | quick find, links only                      | unbound                                     |
| `/`                   | quick find                                  | `find_forward` (normal mode)                |
| `f10`                 | the menu bar                                | unchanged                                   |
| `shift+f10`           | the context menu                            | unchanged                                   |
| `f6`                  | focus: address bar and page                 | unchanged                                   |
| `shift+f6`            | focus: address bar and page                 | unchanged                                   |
| `tab`                 | move focus                                  | unchanged                                   |
| `shift+tab`           | move focus                                  | unchanged                                   |
| `alt+enter`           | address bar: open in a new tab              | unchanged                                   |
| `ctrl+enter`          | address bar: complete .com                  | unchanged                                   |
| `shift+enter`         | address bar: complete .net                  | unchanged                                   |
| `alt+up`              | address bar: search engines                 | unchanged                                   |
| `alt+down`            | address bar: search engines                 | unchanged                                   |
| `f4`                  | address bar: open the results               | unchanged                                   |
| `shift+delete`        | address bar: delete a suggestion            | unchanged                                   |
| `enter`               | find bar: next match                        | unchanged                                   |
| `ctrl+left`           | text editing and page scrolling             | unchanged                                   |
