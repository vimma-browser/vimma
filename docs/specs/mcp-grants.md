# Spec: mcp-grants

Status: implemented · Area: `packages/vimma-core/src/` (`agent.mjs`, `agent-prompt.mjs`);
`src/browser/base/content/vimma/` (`ctl/AgentGate.sys.mjs`, `host/agent-ui.mjs`); `tests/e2e`
· Upstream patches: none · ADR: [ADR-019](../adr/019-agents-over-mcp.md) (unchanged: the gate
stays in the browser, and this spec changes only what one answer allows). No new dependency.

Issue: [#507](https://github.com/vimma-browser/vimma/issues/507)

Builds on [vimma-mcp](vimma-mcp.md) (the agent workspace, the question line, grants and limits),
[mcp-drive](mcp-drive.md) and [mcp-forms](mcp-forms.md) (the tools a grant now covers together).
Decisions of those specs are written "vimma-mcp 21", "mcp-drive D4" and "mcp-forms F15"; this
spec's own are "G1", "G2", and so on. [mcp-checkpoints](mcp-checkpoints.md) adds the payment
checkpoint and a fuller form-submission question on top of this spec. Vimma paths are under
`src/browser/base/content/vimma/` unless they start with `packages/`, `tools/` or `tests/`; line
numbers are at commit `df1c20c7`.

## Summary

One answer covers one task. When the user answers an agent's question with a grant (`10a`: ten
minutes), that agent connection may use every agent tool without asking until the grant ends,
instead of only the tool it asked about. The steps that matter most still stop it under any
grant: sending a form, bringing the agent workspace to the front, and a download Vimma cannot
vouch for; [mcp-checkpoints](mcp-checkpoints.md) adds paying. The question says so in its hint,
and the user ends the grant with one key.

## Problem

A grant today is per connection and per tool (vimma-mcp 21). A real task uses several tools, so
the user answers one question per tool before the agent can work. In a test on a grocery shop
(`vimma-ctl mcp` with Claude Code, adding three items to a basket), the user was asked separately
for `vimma_open`, `vimma_elements`, `vimma_keys` and `vimma_activate` before a grant of each
existed. Each question named a tool, not the task, so the questions told the user nothing they
had not already decided when they started the task, and four of them in a row train the answer
`a` by reflex. That is the prompt fatigue vimma-mcp 18 guards against.

The per-tool split also does not track risk well. A `vimma_keys` grant follows links and loads
pages (mcp-drive D9); a `vimma_elements` grant reads field values (mcp-forms F7). The steps with
real consequences (a form sent to a server, a purchase, a file kept on disk, the user's view
changed) are already asked separately, whatever is granted.

## Behaviour

1. **One grant per connection.** `N a` (or a bare `a`) in answer to any grantable question
   allows that agent connection every agent tool for N minutes: `vimma_tabs`,
   `vimma_read_page`, `vimma_open`, `vimma_close_tab`, `vimma_keys`, `vimma_elements`,
   `vimma_activate`, `vimma_fill`, `vimma_screenshot`, `vimma_console` and the agent's own
   downloads (`vimma_download`). The connection's questions already waiting, other than those in
   item 3, run at once, each a `:mcp log` row of a call under a grant, and the grant's notice
   ends `· it also ran 2 waiting calls (:mcp log)`, since the user answered only the one on the
   line. They get no notice each, because notices replace each other and the grant's would be
   gone at once.
2. **Other connections still ask.** A grant belongs to one connection (one `vimma-ctl mcp`
   process, one agent session), as in vimma-mcp 21; another agent, or the same agent after a
   reconnect, asks again.
3. **What still asks under a grant.** With only `y` and `n`, and a yes never makes a grant:
   - a form submission (mcp-forms F15), with its destination;
   - `vimma_show` (mcp-drive D4), which switches the user's view;
   - a download of a dangerous type (`!` only) or one the virus scanner could not scan
     (vimma-mcp 31 d, security.md M13);
   - a download the agent's pages started without a call of the agent (vimma-mcp 31), asked as
     "a page in the agent workspace";
   - full control (vimma-mcp 29), which is not an agent tool;
   - paying, once [mcp-checkpoints](mcp-checkpoints.md) is built.
4. **The question's hint names the scope.** Once armed, a grantable question shows
   `y once · 10a 10 min, all but forms · n deny · x mute` (10 being `[mcp] grant_minutes`). The hint of a question in item 3 is unchanged.
   (Since changed: the hint says `all but forms and paying`; [mcp-checkpoints](mcp-checkpoints.md)
   Behaviour 8. Since changed again: the hint is `y once · 10a 10 min · n deny · x mute`, and the
   grant's notice (item 5) alone says what still asks, so that a usual question fits one line;
   mcp-checkpoints Behaviour 8.)
5. **The grant's notice names the scope and the way out.**
   `claude-code may use the agent workspace for 10 min; sending a form still asks (ctrl+b shift+a ends it)`.
   (Since changed: the notice says `sending a form or paying still asks`; mcp-checkpoints
   Behaviour 8.)
   A count over `[mcp] grant_max_minutes` adds `, the most [mcp] grant_max_minutes allows`
   after the minutes, as today.
6. **Live while it runs.** Unchanged from vimma-mcp 23-24 and mcp-drive D14: the status bar
   shows `◇ agent 14m` (the time left on the grant that ends first) and `◇ agent ·` for 2 s after
   each call; each call under the grant shows a notice naming what it did and the minutes left
   (`claude-code clicked button "Add to basket" in "Milk · Shop" (grant, 9m left)`); and
   `:mcp log` keeps the last 100 calls with their outcome.
7. **One key ends it.** `ctrl+b shift+a` with no question waiting ends every grant at once and
   says `mcp: ended 1 agent grant`, without the `Revoke N agent grants? y/N` question it asks
   today. With nothing to end, it says `no agent requests waiting and no grants`, as today.
   `:mcp revoke`, `:mcp off`, the connection closing and expiry end grants as before
   (vimma-mcp 22).
8. **`:mcp` counts grants per connection.** `· 1 grant, it ends in 14m`, as today; a
   connection has at most one grant, so the count is the number of agents holding one.
9. **At most one grant per connection.** Under a grant no grantable question of that connection
   is asked, so a new grant is given only after the old one ended.

## Research

### Vimma at `df1c20c7`

- `packages/vimma-core/src/agent.mjs`: `AgentQueue` keeps `grants: Map<tool, until>` per
  connection (`:292`), `ask` runs a call when its own tool has an unexpired grant (`:333-341`),
  and `answer` grants the asked tool and releases the queued calls of that tool (`:368-383`).
  `ALWAYS_ASK` (`:130`) holds `vimma_show`; a request asked with `always` (a submission, a
  dangerous download) asks under any grant and a grant answer to it allows it once (`:364`).
- `ctl/AgentGate.sys.mjs`: refuses a grant answer for full control, `vimma_show` and a page's
  download (`:319-326`) and for a dangerous or unscanned download (`:330`); `announce`
  looks up the grant by connection and tool (`:377`).
- `ctl/agent-commands.mjs`: a submit is asked with `always` (`:925`, `:1103`), `vimma_show` too
  (`:649`).
- `host/agent-ui.mjs`: `ctrl+b shift+a` with nothing waiting asks `Revoke N agent grants? y/N`
  (`:343-351`).
- The limits that hold under any grant are per connection and do not depend on the tool: at
  most 4 requests waiting or running (vimma-mcp 17), 10 opens a minute (security.md M3), 30
  keys, 30 element lists, 30 clicks and fills, 12 screenshots and 30 console reads a minute
  (`agent.mjs:137-175`).

### Other browsers' agents

Checked on 2026-10-22 from vendor help pages and press coverage, not by running them, since
none of them runs on Linux with a local agent:

- **Firefox 158** ships no agent that acts on pages. Its Smart Window's model tools read open
  tabs, history and page text and manage tabs
  (`engine/browser/components/aiwindow/models/Tools.sys.mjs:142-152`), and run a web search
  (`run_search`, `search_the_web`, `:146-147`); closing or grouping tabs first asks the user to
  pick the tabs (`ui/components/ai-website-confirmation/`) and afterwards offers undo
  (`ui/components/ai-action-confirmation/`).
- **Chrome's auto browse** (Gemini in Chrome, January 2026) asks for confirmation before a
  purchase or a social media post, and the user can take over the task
  ([The Register, 2026-01-29](https://www.theregister.com/2026/01/29/chrome_gemini_pane/)). It
  acts in the user's own profile, with the user's logins.
- **ChatGPT Atlas's agent mode** pauses on sensitive sites such as financial institutions so the
  user watches, and has a logged-out mode that uses no existing cookies (OpenAI's help center,
  "ChatGPT Atlas agent mode", via press coverage; the help page itself could not be fetched for checking).
- **Perplexity Comet** pauses before sensitive steps such as logging in or completing a purchase,
  and the user can stop it at any time (Perplexity's announcement, via press coverage).

All of these confirm by clicking in a panel next to the page and decide what is sensitive with
the vendor's model. None of them is driven by an agent of the user's choice over MCP, and none
publishes a list of what still asks.

## Design

1. **A grant is per connection, for every grantable tool** (G1, behaviour 1-2), because the user
   judges a task, not a tool: once they let an agent work for ten minutes, a question per tool
   asks them to repeat that judgement four times, and repeated questions are answered by reflex
   (vimma-mcp 18). The steps with consequences beyond the agent workspace stay asked one by one
   (G2), so the grant covers only what happens inside it. Rejected: per tool (vimma-mcp 21 as
   built), because of the friction above and because the tool split does not follow risk
   (Problem); a read grant and an act grant, because tasks need both, so it would still ask twice
   per task, and because `vimma_keys` and `vimma_elements` sit on both sides of that line;
   per site, because a task crosses sites (a search, a shop, its payment provider) and a
   site-bound grant would ask at every one of them.
2. **What stays asked, and why** (G2, behaviour 3). Each of these has a reason that a grant does
   not change:
   - _A form submission_ sends data to a server, where sign-ups, messages and purchases happen,
     and cannot be taken back (mcp-forms F15).
   - _`vimma_show`_ changes what the user sees and switches their workspace. A grant runs while
     the user is doing something else, so a show at an arbitrary moment would take their view
     away mid-task and could put a page in front of them that looks like their own navigation
     (mcp-drive D4). Its question is also rare (an agent shows a page when it needs the user), so
     asking costs little.
   - _A dangerous download_ can run code on the user's machine when opened, and _an unscanned
     one_ is a file the virus scanner could not vouch for (vimma-mcp 31 d, security.md M13).
   - _A page's own download_ was started by the web, not by the agent the user granted, so no
     grant of an agent can cover it (vimma-mcp 31).
   - _Full control_ reaches every workspace, past the agent workspace a grant is about
     (vimma-mcp 29).
   - _Paying_ spends the user's money; how Vimma recognises it is
     [mcp-checkpoints](mcp-checkpoints.md)'s, because it needs signals beyond the form rule
     (a basket button that submits nothing and a checkout button can look the same).
3. **The answer's scope is in the hint, not a second question** (G3, behaviour 4-5), because a
   question per answer is what this spec removes; the hint is read at the moment of answering,
   and the notice repeats the scope in full and names the key that ends it. The hint names only
   the steps the user will meet in a task (sending a form, and paying once built); `vimma_show`
   and downloads ask with their own wording when they come. The hint says it in three words
   (`all but forms`) because a longer one (`all tools for 10 min (sending a form still asks)`)
   wrapped a usual question, such as a `vimma_keys` one with its URL, onto a second line in a
   1,280-pixel-wide window, and a question that fits one line is read at a glance. (Since
   changed: with paying added, even the short scope wrapped such a question, so the hint names
   no scope and the notice, shown the moment `a` is pressed, says what still asks;
   [mcp-checkpoints](mcp-checkpoints.md) Behaviour 8.) Rejected: a separate "grant all" key
   beside a per-tool `a`, because two grant keys make the user choose a scope under time
   pressure, and the per-tool scope is the one this spec drops.
4. **One key ends every grant** (G4, behaviour 7), because ending is the safe direction: an agent
   that loses its grant asks again, so a mistaken press costs one question, while a
   confirmation delays the one action that must be quickest when something looks wrong. The
   notice names how many grants ended. `:mcp revoke` stays for the command line.
5. **A connection holds at most one grant** (G5, behaviour 9), because two grants of one
   connection would both cover every tool, so only the one that ends last would mean anything,
   and the status bar and `:mcp` would count grants that change nothing.
6. **Notices, status and log are unchanged** (G6, behaviour 6), because they already show every
   call under a grant: the status bar's countdown, a notice per call naming the page and what was
   done, and `:mcp log` for afterwards (mcp-drive D14). A wider grant makes them more important,
   not different. Rejected: one combined notice per minute, because a notice that lags its call
   cannot be checked against the page the user sees.
7. **The rates and confinement do not change** (G7), because they are per connection already
   (Research), so a grant over every tool cannot do more of any one thing than a grant of that
   tool could.
8. **The agent workspace is for everyday tasks done on the user's behalf, so one grant per task
   with hard checkpoints is the core of the feature** (G8). Vimma's agents shop, fill in forms,
   book and look things up for the user, in the user's own daily browser: in a workspace of its
   own container, with only the logins the user puts there; in a real, visible browser the user
   can watch and interrupt with one key; with checkpoints before sending a form (and paying,
   mcp-checkpoints); with every call in `:mcp log`; and with compact lists of labelled elements
   instead of page source, so the agent needs few calls. A task like that runs for minutes and
   uses every tool, so it needs one answer that covers it and stops only where a step cannot be
   taken back. Vimma is deliberately not a test-automation or scraping tool, because those need
   headless, parallel and scripted control that a confined, watched workspace cannot give.
   Rejected as the way to give agents a browser: driving a browser profile through Playwright or
   the Chrome DevTools MCP server, because that gives the agent full control of the profile,
   every login and cookie in it included, with no checkpoint before it sends or pays, no
   confinement to part of the profile and no log the user reads. Playwright drives Firefox
   through its own patched build (its Juggler protocol); support for stock Firefox through
   WebDriver BiDi was experimental when checked, tracked by Mozilla's WebDriver BiDi milestones
   (wiki.mozilla.org, "WebDriver/RemoteProtocol/WebDriver BiDi", milestone 19; read on
   2026-10-22, not tried), so it cannot drive the Vimma the user browses with. The guide's
   "When to use Playwright instead" points users with those needs to it, on a throwaway
   profile.

## Security and privacy

What changes: a grant given in answer to any question, even one for the tab list, now lets the
agent load any http or https URL, follow links to any site, click buttons that do not submit a
form, fill fields and take screenshots without asking, until the grant ends. What it cannot do
unasked: submit a form, pay (once mcp-checkpoints is built, and only as far as its signals
recognise a payment), show a page, keep a dangerous or unscanned file, or reach outside the
agent workspace.

- **Exfiltration through `vimma_open`.** Any grant now lets the agent load any http or https
  URL in the agent workspace, and a URL can carry what the agent read. Before, the guide told
  users to grant reads and answer opens one at a time; that advice no longer exists in the
  product. What the agent can read is what the agent workspace holds: none of the user's logins
  in other workspaces (vimma-mcp 7), but every login the user made in the agent workspace
  itself, such as a shop account with its address and order history. What limits it: each open
  and each follow shows a notice naming its host and a `:mcp log` row with the whole URL; at
  most 10 loads a minute; and grants are for minutes, ended with one key. Agent hosts usually
  ask before their own shell or network use, so under a Vimma grant Vimma may be the agent's
  only unprompted way to send data out. The guide says so where it describes grants, and
  advises a grant only for a task the user is watching.
- **Prompt injection.** A page read under a grant can tell the agent to act on other pages, and
  under the grant those acts run unasked. They stay inside the agent workspace and its
  container, and each is a notice and a log row. They cannot submit a form, but a button whose
  script sends data without a form (a `fetch` from its click listener, mcp-forms F17) can be
  pressed unasked, after fields were filled unasked: posting a message is such a step. Before,
  that needed a `vimma_activate` grant; now any grant allows it. mcp-checkpoints covers the
  payments among these steps, and only those its signals recognise.
- **Answering by reflex** is less likely, because a task now asks once instead of once per tool.

`docs/security.md` changes in the implementing PR:

- M1: every agent command waits for a yes or runs under an unexpired grant **of its
  connection**; the grant covers every grantable tool.
- M5: grants are per connection (at most one each), capped, in memory
  only, and end on revoke (`ctrl+b shift+a` with nothing waiting, `:mcp revoke`), disconnect,
  `:mcp off` and expiry.
- M19, M28 and the download rules (M11, M13) keep their wording ("under any grant"); their tests
  gain the case of a grant given for another tool.
- M18: a follow to another site is asked as a `vimma_open` unless the connection holds a grant
  (any grant, where it was a `vimma_open` grant); `test_cross_site_follow_asks_as_vimma_open`
  checks both.
- M21 and M31 lose "so a `vimma_keys` (`vimma_elements`) grant is never a read grant", which no
  longer holds.
- §12's reach paragraph says what a grant allows and what still asks.

## Tests

### Vitest (`packages/vimma-core`)

- `agent-gate.test.mjs`: `a grant covers every tool of its connection, not another
connection's`; `a grant lets the connection's queued calls of every tool run, not an always-ask
one`; `a connection holds at most one grant`; `a reconnect asks again`; `grants end on revoke and
on disconnect, and are listed shortest first`; `a grant does not run it, whatever was asked: it
waits` (a dangerous download); the vimma_show tests; the per-tool tests become `… and its grant
covers the other tools`.
- `agent-prompt.test.mjs`: the hint in the question tests; `a grant names its scope, its
length, the cap, and the key that ends it`; `a grant names the waiting calls it let run, which
the user did not see asked`.
- `fuzz/agent.fuzz.test.mjs`: the old properties (no limit broken, no request resolved twice)
  hold with one grant per connection, and `no sequence of events runs an always-ask request
under a grant or makes a grant from one`.

### Mochitests (`tests/browser/`)

- `browser_vimma_mcp_agent.js`: `test_one_grant_covers_every_tool_of_its_connection` (replaces
  `test_grants_per_connection_and_tool`): a read granted for 15 minutes lets the tab list and
  an open of that connection run with log rows, while a second connection asks;
  `test_queued_calls_a_grant_releases_show_as_granted`: a waiting open released by a grant given
  to a read is a `:mcp log` row run under the grant, and the grant's notice counts it.
- `browser_vimma_mcp_prompt.js`: the hint's wording; in
  `test_a_count_and_a_grant_minutes_shown_in_the_status_bar`, the grant's notice and
  `ctrl+b shift+a` ending the grant at once.
- `browser_vimma_mcp_follow.js`: `test_cross_site_follow_asks_as_vimma_open`: under a grant a
  follow to another site runs unasked; without one it asks as `vimma_open`.
- `browser_vimma_mcp_submit.js`, `browser_vimma_mcp_fill.js`: a submission asks under a grant.
- `browser_vimma_mcp_show.js`: a show asks under a grant and leaves it unchanged.
- `browser_vimma_mcp_downloads.js`: under a grant the agent's opens and downloads run unasked; a
  dangerous download still asks.
- The keys, elements, screenshot and console tests: their grant now covers the other tools.

### e2e (`tools/e2e`, under Xvfb)

- `m0-mcp-stdio`: the question line's new hint (baseline `m0-mcp-stdio-question`), and
  `ctrl+b shift+a` ending the grant so that the next call asks again; the baseline changes, with
  a changelog line. The question, the grant's notice, calls under the grant, a submission under
  it and the ended grant are also screenshotted with the Omarchy theme in a throwaway run before
  merging.

## Docs and changelog

- `docs/guide.md` "Agents (MCP)": the keys table (`a` allows every tool), "Grants are wide"
  rewritten for the single grant (what it allows, what still asks, the exfiltration note),
  "Grants show" and the revoke lines (one key), and each tool's "A grant covers …" line.
- README: the agents feature line says one grant covers a task, with forms always asked.
- `CHANGELOG.md`: added by the maintainer at merge, apart from the baseline line.
- Notes in implemented specs (docs/specs/README.md, "Implemented specs are frozen"): vimma-mcp
  21 and its threat rows on `vimma_open`, mcp-forms F25, and mcp-drive D17 and D18 get
  `(Since changed: …; mcp-grants.md.)`.

## Delivery

One PR, `feat(mcp): one grant covers every agent tool of its connection`: core, gate, prompt
wording, `ctrl+b shift+a`, tests, security.md, guide and README, and the e2e baselines.

## Open questions

None: the scope of a grant, what stays asked and the wording are decided above. How Vimma
recognises paying is [mcp-checkpoints](mcp-checkpoints.md)'s open question.
