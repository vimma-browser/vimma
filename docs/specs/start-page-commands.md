# Spec: start-page-commands

Status: implemented · Area: `src/browser/base/content/vimma/host/urlbar-commands.mjs`,
`host/VimmaHost.sys.mjs`, `ui/cmdline.mjs` · Upstream patches: none · ADR:
[ADR-026](../adr/026-module-layering.md) (layering)

Issue: [#1271](https://github.com/vimma-browser/vimma/issues/1271)

## Summary

On Vimma's start page, a line typed in the address bar that starts with `:` runs as a Vimma
command line when the user presses `Enter`, and is never sent to the search engine or to its
suggestion endpoint. Everywhere else the address bar behaves as in Firefox.

## Problem

A new tab opens on the start page ([start-page](start-page.md)) with the address bar empty and
focused, and the page's hint advertises `:` for commands. A keyboard user types `:source` or `:q`
there and presses `Enter`. Firefox searched the default engine for `:source`, so the command
went to a third party, and the engine's suggestion endpoint saw every prefix as it was typed.
The way that worked, `Esc` first and then `:`, is not discoverable from the page.

## Behaviour

While the selected tab shows the start page (`chrome://browser/content/vimma/start/start.html`)
and the address bar's text starts with `:` (after any spaces):

1. Plain `Enter` and `shift+Enter` run the text after the `:` exactly as if it had been typed on
   the command line opened with `:` on the page: it goes into the command line's history, an
   error shows on the open command line (which keeps the text to fix), and a command runs with
   focus on the page. The address bar is emptied.
2. `alt+Enter`, `ctrl+Enter`, `meta+Enter`, the go button, Paste & Go and text dropped on the
   address bar put the line on the command line without running it; `Enter` there runs it.
3. No request reaches the default engine's search or suggestion URLs, and the drop-down shows no
   rows for the line.
4. Words still search and an address still loads from the start page's address bar.
5. On any other page, a `:` line in the address bar is a search, as in Firefox.

## Research

Checked against Firefox 160.0.1 (`engine/browser/components/urlbar/`):

- Every way the address bar's text leads to a load goes through two methods of the field,
  called through `this`: `handleCommand(event)` for `Enter` (`UrlbarChildController.mjs:474`),
  the go button (`UrlbarInputBase.mjs:5358`, `:5372`) and Paste & Go (`:4574`, with no event);
  and `handleNavigation({ event, oneOffParams, triggeringPrincipal })`, which `handleCommand`
  calls (`:1339`) and a drop calls directly (`:6231`).
- `UrlbarEventBufferer` defers an `Enter` pressed while a query runs and replays the same event
  object later (`UrlbarEventBufferer.mjs`), so the event stays `isTrusted`.
- The providers manager queries only the active providers with the highest priority
  (`UrlbarProvidersManager.sys.mjs:779-790`); the highest built-in priority is
  `UrlbarProviderSearchTips`' 2. `isActive(context, controller)` gets the
  `UrlbarParentController`, whose `browserWindow` is the window of the field that queries.
- A query with no results closes the view unless the field is in search mode.

## Design

1. **Start page only.** The rule applies only while the selected tab shows the start page,
   because there the address bar has focus without the user choosing it, while the page
   advertises `:`. On another page the user moved to the address bar on purpose, and `:` on the
   page already opens the command line. Rejected: every tab, because it would change what
   Firefox users expect of the address bar for no gain.
2. **A leading `:` is the test.** No web address starts with `:`, so the rule takes nothing
   from searches or addresses. Leading spaces count as nothing, since Firefox trims them before
   searching.
3. **Run as the command line does.** The host focuses the page, then `CommandLine.enter(text)`
   puts the text on the command line and submits it, closing first a line left open with other
   text, so that history, errors, the refusal of `javascript:` URLs and every other rule are
   the command line's own. Rejected: parsing and running the line separately, because it would
   drift from the command line.
4. **Only a pressed Enter runs it.** Plain and `shift+Enter` run the line only for a trusted,
   non-composing `keydown` event (Gecko marks an event trusted when the user or chrome code made
   it; no page can reach the field's methods): the command line runs on `Enter` with no modifier but shift
   and ignores ctrl, alt and meta (`ui/cmdline.mjs`, `onKeyDown`), and Paste & Go, a drop and a
   click have no such event. A page can put text on the clipboard or start a drag, so those
   paths only fill the command line, and nothing a page controls runs without an `Enter` the
   user pressed.
5. **Wrap the field's methods, register a provider.** `host/urlbar-commands.mjs` sets
   `handleCommand` and `handleNavigation` as own properties of each window's field, and
   registers one result provider per process with priority 1000 for a `:` line on the start
   page, which adds no results, so that no other provider queries (no suggestion request, no
   "search for" row). Both are runtime hooks, so no upstream patch is needed, as with
   `search/UrlbarRows.sys.mjs`. The hand-off to the command line runs after the event, outside
   Firefox's handler.
6. **The start page's URL is a copy.** `host/` may not import `start/` (ADR-026), so the module
   keeps its own copy of `START_PAGE_URL`, and the browser test checks that the two are equal.

## Security and privacy

A `:` line on the start page no longer reaches the search engine or its suggestion endpoint.
What runs is what the command line would run after an `Enter`; commands that ask first still
ask. Only an `Enter` the user pressed runs a line: Paste & Go, a drop and a click only fill
the command line. Web pages and extensions cannot load the start page's chrome URL,
so the start-page check cannot be met by a page. The control socket's agent role never makes a
key event; its full role can already type `:`. Firefox's Smartbar and the separate search bar
are not wrapped: the first is off by default and the second is a deliberate search. A bookmark
keyword or engine alias that starts with `:` does not work from the start page.

## Tests

`tests/browser/browser_vimma_start_commands.js`:

- `a_colon_line_runs_as_a_command`: `:tabnew` and `Enter` in a new tab's address bar opens a tab,
  the start page stays, no request reaches the test engine's URLs, the drop-down has no rows, and
  `Up` on the command line recalls the line.
- `shift_enter_runs_the_line_too`.
- `an_unknown_command_shows_its_error`: `:tabnwe` opens the command line with its error.
- `other_enters_and_paste_and_go_only_fill_the_command_line`: `alt+Enter`, `ctrl+Enter`, the go
  button, Paste & Go and a drop fill the command line and run nothing.
- `a_line_left_open_is_replaced`: a line left open on the command line is not the one run.
- `searches_and_addresses_still_work_on_the_start_page`.
- `other_pages_keep_the_address_bar_as_it_was`: on another page a `:` line is a search.
- `the_start_page_url_is_the_same`: the copy in `urlbar-commands.mjs` equals `START_PAGE_URL`.

Red before the change: `Enter ran :tabnew: a new tab opened` timed out and the engine was asked
for suggestions (`?vimma1271=1&q=%3Atabnew`).

## Docs and changelog

`docs/guide.md`: "The start page" and "The command line". The changelog line comes from the
commit subject.

## Delivery

One pull request, closing #1271.

## Open questions

None.
