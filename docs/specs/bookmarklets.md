# Spec: bookmarklets

Status: implemented · Area: `packages/vimma-core/src/ui/bookmarks.mjs`, `config/config.mjs`,
`config/defaults.mjs`, `control/control.mjs`, `agent/agent.mjs`, `agent/agent-results.mjs`,
`agent/agent-prompt.mjs`;
`src/browser/base/content/vimma/` (`host/bookmark-ops.mjs`, `host/bookmark-actions.mjs`,
`host/VimmaHost.sys.mjs`, `host/AgentGate.sys.mjs`, `host/window-state.mjs`,
`ui/bookmarks-panel.mjs`, `config/ConfigHost.sys.mjs`, `ctl/agent-commands.mjs`);
`tools/vimma-ctl/src/mcp/` · Upstream patches: none · ADR: none

Issue: [#1220](https://github.com/vimma-browser/vimma/issues/1220)

Builds on [bookmarks](bookmarks.md) (decision 6 refused every `javascript:` bookmark),
[vimma-mcp](vimma-mcp.md), [mcp-drive](mcp-drive.md) and [mcp-grants](mcp-grants.md). This
spec's decisions are written "B1", "B2", and so on. Engine references (`engine/…:line`) are
Firefox 160.0 as imported by `npm run import`.

## Summary

A bookmarklet is a bookmark whose URL is `javascript:` code: picked, it runs that code in the
page you are on. Vimma lists bookmarklets in the bookmarks panel but has refused to run them. A
new `config.toml` setting, `[bookmarks] bookmarklets`, lets the user run their own bookmarklets
from the panel (`"user"`), and also lets an agent ask to run one of them by name (`"agent"`). The
default, `"none"`, keeps today's refusal. Typed text, keyword bookmarks and pages can never run
one at any level.

## Problem

Bookmarklets are a common way to add small tools to a browser: a reading view, a page's word
count, a "send to" service. In Vimma, `Enter` on one in the bookmarks panel says
`javascript: bookmarks don't open from Vimma` and does nothing, so a user who relies on them has
to reach Firefox's own bookmarks menu or toolbar with the mouse. A user who drives the browser
through an agent cannot ask it to run one at all.

Running one is a real grant of power: the code acts with the page's full rights (it reads and
changes everything the page can, and sends requests as the page). It is safe only when the code
is the user's own, picked by the user, so this is opt-in.

## Behaviour

1. `[bookmarks] bookmarklets` in `config.toml` (schema 2) takes `"none"` (the default),
   `"user"` or `"agent"`. Any other value is a config error naming the allowed values.
2. With `"none"`, a bookmarklet in the bookmarks panel is listed and refuses with the notice
   `javascript: bookmarks don't open from Vimma (only http, https, file, about)`, as before.
3. With `"user"` or `"agent"`, `Enter` or `l` on a bookmarklet in the panel runs it in the
   current tab's page and closes the panel. `t`, `s` and `S` on a bookmarklet refuse with
   `a bookmarklet runs in this page: Enter runs it`.
4. A bookmarklet runs only on a web page (an `http`, `https` or `file` page); elsewhere (the
   start page, `about:` pages, Vimma's own pages) it refuses with
   `bookmarklets run only on web pages`.
5. With `"agent"`, an agent may call `vimma_bookmarklet { tab, name }`: Vimma finds the one
   bookmarklet whose title is `name` among the user's bookmarks, asks the user every time, and on
   `y` runs it in that agent tab. With `"none"` or `"user"` the call is refused before anything
   is asked.
6. At every level, `:open`, `:tabnew`, `p`, `P`, a keyword bookmarklet typed on the command line
   (`:open k x`), the control socket's `open`, `vimma_open`, a page's links and a `data:`
   bookmark never run script.

## Research

- **How Firefox runs a picked bookmarklet.** `PlacesUIUtils._openNodeIn`
  (`engine/browser/components/places/PlacesUIUtils.sys.mjs:915`) calls
  `openTrustedLinkIn(url, where, { allowPopups, allowInheritPrincipal })` with both true for a
  `javascript:` URL (`:959`). `openTrustedLinkIn` uses the system principal as the triggering
  principal; `openInCurrentTab` (`engine/browser/modules/URILoadingHelper.sys.mjs:257`) adds
  `LOAD_FLAGS_DISALLOW_INHERIT_PRINCIPAL` unless `allowInheritPrincipal` is set (`:267`), and
  that flag stops a `javascript:` URL from running at all.
- **Which principal the script gets.** `JSURLInputStream::EvaluateScript`
  (`engine/dom/jsurl/nsJSProtocolHandler.cpp:224`) evaluates the script in the target document's
  inner window (`:377`), so it runs with the page's own content principal, not the triggering
  one. It does not run if the inner window changed since the load started (`:298`), if the
  script principal does not subsume the page's (`:388`), or if the page's global has the system
  principal (`:396`). A system triggering principal skips the page's CSP (`:318` to `:334`):
  that is why bookmarklets work on pages with a strict CSP in Firefox.
- **Only bookmarks.** `PlacesUIUtils.checkURLSecurity` (`:659`) lets a `javascript:` or `data:`
  URL load only from a node that is a bookmark: Firefox draws the same line between a stored
  bookmark and other text.
- **Keywords.** `UrlbarUtils.getShortcutOrURIAndPostData` puts the typed words into a keyword
  bookmark's `%s`, so a keyword bookmarklet's script contains typed text; Vimma refuses its
  result (security.md U4).

## Design

1. **B1. One setting with three levels: `[bookmarks] bookmarklets = "none" | "user" | "agent"`.**
   The levels are ordered, and `"agent"` includes the user, because an agent acts for the user
   and a user who trusts an agent with their bookmarklets has already chosen to run them. One
   key with a string value matches `[bookmarks] root` and `[panel] numbers`, so the file stays
   one style, and a fourth level could be added without a second key. The key sits under
   `[bookmarks]` because it changes what a bookmark does. Rejected: two booleans
   (`user_bookmarklets`, `agent_bookmarklets`), because "agent but not user" would be a fourth
   state with no use; the issue's `user_only` and `both`, because `"user"` and `"agent"` name who
   may run them in the words the rest of the config uses for agents (`[agent]`, `[mcp]`).
2. **B2. The default is `"none"`.** Running a bookmarklet gives its code the page's full rights,
   so it must be a choice the user makes in their own file, and without the line Vimma behaves
   as it did before (bookmarks decision 6).
3. **B3. Only `config.toml` sets it.** The level lives in `host/bookmark-ops.mjs`, set by
   `VimmaHost.configure` from `ConfigHost`'s parsed file at startup and on each reload. There is
   no pref, no command-line command, no control-socket command and no agent tool that changes
   it, and nothing a page sends reaches it. A file with an error keeps the last good config
   (security.md F2), and a reload without the line returns to `"none"`.
4. **B4. A bookmarklet is a stored bookmark whose URL is `javascript:`.** Core
   `bookmarkKind(url)` classifies a stored URL as `"openable"` (bookmarks decision 6),
   `"bookmarklet"` or `"refused"`: the scheme is read after removing tabs and line breaks and
   leading spaces and control characters, as the URL parser does, so `" JavaScript:"` is a
   bookmarklet and `view-source:javascript:` is refused. The URL that runs is the stored one,
   unchanged: no `%s` is ever filled in, because a filled-in keyword would make typed text part
   of the script.
5. **B5. `data:` bookmarks stay refused at every level.** A `data:` URL is not a script run in
   the page you chose: it is a whole new document with an opaque origin, Firefox blocks it as a
   top-level navigation from web content because it is used to fake login pages, and no
   bookmarklet workflow needs it. Allowing it would add a phishing path for no use.
6. **B6. One decision table, in core.** `bookmarkletDecision({ url, setting, by, where })`
   returns `{ kind: "open" }`, `{ kind: "run" }` or `{ kind: "refuse", text }` for a stored
   bookmark's URL, the level, who asked (`"user"` or `"agent"`) and where it would open. The
   panel's `openEffect` and the agent command both go through it, so the rules cannot drift
   between the two paths.
7. **B7. The user runs a bookmarklet with `Enter` or `l`, in the current tab.** A bookmarklet
   acts on the page you are looking at, so `Enter` and `l` run it there and close the panel.
   `t`, `s` and `S` refuse, because in a new tab or pane the script would run on an empty page
   (Firefox opens `about:blank` and runs it there), which is never what the user meant.
8. **B8. Run as Firefox runs a picked bookmarklet.** `runBookmarklet(browser, url, { popups })`
   in `host/bookmark-ops.mjs` loads the URL in that tab's browser with the system principal as
   the triggering principal and without `LOAD_FLAGS_DISALLOW_INHERIT_PRINCIPAL`, the load
   `openTrustedLinkIn` makes for `PlacesUIUtils._openNodeIn`. The engine then evaluates the
   script with the page's own content principal and refuses a system-principal page (Research).
   The browser is loaded directly rather than through `openTrustedLinkIn` because that raises
   the window (`w.focus()`), which an agent's call must never do (mcp-drive D6). The user's run
   allows popups, as Firefox's does; an agent's does not, because a window an agent's script
   opens would be outside the agent workspace.
9. **B9. Only on a web page.** Before running, the tab's `contentPrincipal` must be a content
   principal with the `http`, `https` or `file` scheme. The engine already refuses a
   system-principal page; this check also refuses Vimma's start page, `about:` pages and
   `moz-extension:` pages, where a user's bookmarklet has nothing to do and
   an extension's rights must not be borrowed.
10. **B10. A reusable entry point for every user-chosen bookmark.**
    `openUserBookmark(ctx, guid, where)` in `host/bookmark-actions.mjs` reads the bookmark by
    its Places guid, decides with B6 as `"user"`, and opens or runs it. The panel calls it, and `:bookmark_open`
    ([#1219](https://github.com/vimma-browser/vimma/issues/1219)) is to call it with the guid of
    the bookmark the user picked: what the user types there chooses among stored bookmarks and
    never becomes the URL.
11. **B11. Private windows.** In a private window (and the private workspace) a user's
    bookmarklet runs as in a normal one, as Firefox's does: it is the user's own choice on the
    page they see, and the page is already private. Nothing about the run is stored. An agent
    never reaches a private window: agent tabs live only in the agent workspace's container in a
    normal window (security.md M2).
12. **B12. The agent names a bookmarklet; it never sends script.** With `"agent"`, the tool
    `vimma_bookmarklet { tab, name }` (control command `agent-bookmarklet`) takes an agent tab
    and a bookmark title. Vimma looks for bookmarks whose stored URL is a bookmarklet (B4) and
    whose title equals `name` exactly, anywhere in the user's bookmarks. Exactly one must
    match, because the question must name exactly one script; none and several fail with the
    same message (B16).
    one script. Vimma never lists bookmarklets to the agent: the user tells the agent which one
    to run, so the agent learns no bookmark it was not told about. A `javascript:` text from the
    agent, a page or a tool argument is never run: `name` is only compared with titles. A tab
    whose page fails B9 is refused before the question too. The server's instructions say, in
    one sentence, that the tool runs a bookmarklet the user named, only when allowed, and asks
    every time, so a model tells the user before it calls it.
13. **B13. Refused before asking below `"agent"`.** With `"none"` or `"user"`, the command fails
    with `failed` and a message naming the setting, before the tab is looked up or anything is
    asked, so a level that keeps agents out never puts a question in front of the user.
14. **B14. Asked every time, under any grant.** `vimma_bookmarklet` joins `ALWAYS_ASK`: a
    question with `y` and `n` only, never covered by a grant, and a yes never makes one. A
    bookmarklet's code acts with the page's full rights, so it steps around every check the
    other tools have: it can fill a password field (M27), send a form without the submission
    question (M28), and run code (M30). Only the user, at that moment and on that page, can say
    whether that is wanted, as for paying (M33) and showing a page (M19). The question names the
    agent, the bookmarklet's title and folder path, and the tab's site.
15. **B15. After the yes, the same tab, page and bookmark.** The tab and its URL must still be
    the ones asked about (M8), and the bookmark is read again by its guid: if its URL or title
    changed, nothing runs and the call is denied as `changed`. The level is decided again too,
    so a level lowered while the question waited refuses (B13). Then it runs with B8 (no popups)
    on a page that passes B9. These checks read the parent's view of the tab; the race that
    leaves is described under Security and privacy.
16. **B16. Rate and result.** At most 6 `vimma_bookmarklet` calls a minute per connection,
    counted before the bookmark is looked up, so an agent cannot probe titles quickly or flood
    the user with questions. Whether exactly one bookmarklet has a title still leaks, at that
    rate: the refusal before the question tells an agent that a title it guessed is not one
    bookmarklet's. It cannot tell none from several (one message for both, "no single
    bookmarklet has that title: check it is one you saved, and that no other bookmarklet shares
    it"), and it learns nothing of a bookmarklet's URL or folder. The result is
    `{ ran: true }`; the script's return value is not sent back, and the agent reads the page with `vimma_read_page` as after any other step.
    Every call is a `:mcp log` row (M23).
17. **B17. Typed and page text never run script.** The setting does not change `p`, `P`,
    `:open`, `:tabnew`, keyword bookmarklets (security.md U1, U4, U5), the socket's `open`,
    `vimma_open` (M6), a follow (M18) or a page's own links: their URL is text someone typed or a
    page sent, not a stored bookmark's URL.

## Security and privacy

- New surface: the user's own scripts can run in a page, and, with `"agent"`, an agent can ask
  to run one. Both are off by default (B2) and only `config.toml` turns them on (B3).
- The agent cannot supply script (B12), cannot run one without a yes each time (B14), and runs
  only in its own workspace's tabs (M2). A bookmarklet the user saved can still do anything the
  page can; that risk is the user's choice when they save it and set the level, and the question
  names it each time.
- Never the system principal: the engine evaluates the script in the page's global and refuses
  a system-principal page (Research); Vimma also refuses any page that is not http, https or
  file (B9).
- Remaining race, accepted as Firefox accepts it for a clicked bookmarklet: Vimma checks the
  tab's URL and principal in the parent (`currentURI`, `contentPrincipal`) right before it
  starts the load, but the document the script runs in, and the principal it inherits, are
  fixed only when the content process's docshell handles the load. During a same-site
  navigation in the same content process, the parent's view can lag the page for a moment, so a
  page that navigates itself just then can receive the script instead of the page asked about.
  The script still runs only in a web page's global with that page's principal, never with the
  system principal, and it is a bookmarklet the user saved and allowed. A content-side origin
  check through an actor was not added: it would narrow the window, not close it, since the
  page could still navigate between that check and the load.
- Rules: security.md U3 and U8, M63.

## Tests

- Vitest `packages/vimma-core/test/bookmarklets.test.ts`: `bookmarkKind` (case, spaces,
  controls, `view-source:`, `data:`); the decision table for every level, caller and place;
  `[bookmarks] bookmarklets` parsing (the default, each value, an error with the nearest name,
  a wrong type) and the `defaults.toml` line.
- Vitest `packages/vimma-core/test/bookmarks.test.ts` (unchanged): the default refusal.
- Mochitest `tests/browser/browser_vimma_bookmarklets.js`: `none` refuses from the panel; `user`
  runs from the panel with the page's principal (no chrome access) and closes it; `t` and `s`
  refuse; the start page refuses; `data:` refuses at every level; a keyword bookmarklet from
  `:open` refuses at every level; the agent is refused at `none` and `user` with no question;
  at `agent` it asks every time, also under a grant, and runs on `y`; `n` runs nothing; an
  unknown or duplicated title fails; a changed tab URL after the question runs nothing.
- Vitest `packages/vimma-core/test/bookmarklets-agent.test.ts`: the command's arguments and
  result, `ALWAYS_ASK`, the question line and its hint, the desktop notification, the rate, and
  the built-in agent's result text.
- Rust `tools/vimma-ctl`: the tool's arguments
  (`bad_bookmarklet_arguments_are_tool_errors_and_never_reach_vimma`),
  command (`the_bookmarklet_tool_sends_a_tab_and_a_title`) and result text
  (`a_bookmarklet_run_says_only_that_it_ran`); the tool list fixture.
- Contract fixtures `tests/contract/control/v2/{request,response}-agent-bookmarklet.{valid,invalid}.json`.

## Docs and changelog

- `docs/guide.md`: bookmarks, the new setting and what each level allows; the agent's tools.
- `docs/security/04-opening-urls-from-untrusted-text.md` U3, new U8;
  `docs/security/12-agents-mcp.md` new M63; the index's ranges.
- CHANGELOG (from the commit): `feat(bookmarks): run bookmarklets from the bookmarks panel, and
optionally from agents, with [bookmarks] bookmarklets`.

## Delivery

One pull request: the spec, core, the user path, the agent command and tool, docs.

## Open questions

None.
