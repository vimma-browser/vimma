## 12. Agents (MCP) (`host/AgentGate.sys.mjs`, `ctl/agent-commands.mjs`)

Lets local AI agents (Claude Code, Codex, opencode, Copilot) list, read, open and close tabs of
one workspace, **agent**, through the control socket's `agent` role. Spec:
[vimma-mcp](../specs/vimma-mcp.md), [ADR-019](../adr/019-agents-over-mcp.md).

Only the seven modules that call the gate today may import it (ADR-026, `RESTRICTED` in
`tools/layering/layers.ts`), so a new caller, such as the parent actor, is reviewed against this
section first. `npm run layering` checks exactly the following, and fails on anything outside it.
Where a rule could list forms to refuse, it lists instead the one form the tree uses; widening
such a list is a change to `tools/layering/` that needs a fresh security review. Each item has
its module there: load positions in `scan.ts` and `urls.ts`, the loader in `loader.ts`, the
gate's importers and file name in `restricted.ts` (from the strings `scan.ts` and `pages.ts`
collect), hand-ons in `hand-ons.ts`, pages in `pages.ts`, encoding in `encoding.ts`, packaging
and file types in `packaging.ts`, Firefox patches in `patches.ts` and vimma-core in
`vimma-core.ts`; `tree.ts` reads the tree and runs them all.

- **Load positions in the modules of `vimma/`** (`.mjs`, `.js`; `core/` aside, below): `import`
  and `export … from` declarations, `import()`, a direct `ChromeUtils.importESModule(…)` or
  `….defineESModuleGetters(…)` call, and the first argument of `new Worker`, `ChromeWorker` or
  `SharedWorker`, by name or as a member (`globalThis.ChromeWorker`). Each must be a fixed string (a worker's may be a name whose one declaration is
  a `const` with one) naming a `.mjs` or `.js` file, with no options argument or import
  attributes. Only a listed module may load the gate, by its exact `chrome://` URL or a plain
  relative path, and never in a worker. A URL's tabs, line breaks, ends, query, fragment, `.`
  and `..` segments, `%` escapes or case of scheme and host do not hide a load; a `resource://`
  path to the packaged files is refused, since it would load a second gate with its own grants.
  [`importsOf: a URL with a query, a fragment or an upper-case scheme is still an edge`](../../tools/layering/test/layering.test.ts),
  [`scanModule: what Firefox does to a URL, the check does too`](../../tools/layering/test/layering.test.ts),
  [`scanModule: a Vimma module named through a resource:// URL is refused`](../../tools/layering/test/layering.test.ts),
  [`scanModule: a listed importer may not load a second gate`](../../tools/layering/test/layering.test.ts),
  [`scanModule: no options argument on any Vimma module, and workers are load positions`](../../tools/layering/test/layering.test.ts),
  [`scanModule: the gate loads only as a module of the main loader`](../../tools/layering/test/layering.test.ts),
  [`scanModule: a worker reached as a member is a worker`](../../tools/layering/test/layering.test.ts),
  [`scanModule: only module files are loaded`](../../tools/layering/test/layering.test.ts),
  [`a new importer of the agent gate fails, in host/ or a higher folder alike`](../../tools/layering/test/layering.test.ts)
- **The loader itself:** `ChromeUtils` appears only as `ChromeUtils.<name>`, and either loader's
  name appears nowhere but in its direct call.
  [`scanModule: ChromeUtils is read only as ChromeUtils.<name>`](../../tools/layering/test/layering.test.ts),
  [`scanModule: the loader is read only where it is called directly`](../../tools/layering/test/layering.test.ts)
- **The gate's file name:** a module or page the list does not hold may not name it in a string,
  a template string or a regular expression literal (pages: anywhere in their text), matched on
  its letters and digits after escapes are decoded; a listed module names it only by its exact
  URL or a plain relative path.
  [`a module the list does not hold may not name the gate's file at all`](../../tools/layering/test/layering.test.ts),
  [`restrictedErrors: a listed module names the gate's file only by its exact URL`](../../tools/layering/test/layering.test.ts)
- **Hand-ons by a module that holds the gate** (by an `import`, `ChromeUtils.importESModule`,
  an awaited `import()` or a lazy getter object, and through aliases whose names resolve by
  scope): each use must call a member, read a getter, keep an alias or pass the lazy object to
  `ChromeUtils.defineESModuleGetters` or `defineLazyGetter`. An export, a return, an argument,
  an array, object or field holding it, the value of an assignment that goes on, a store on an
  object or on a name no scope declares, a method taken without a call (by a member read or by
  destructuring at any depth), a member replaced or deleted, one name given two holds, or a
  lazy object that is not one fresh `const` (`{}` or `Object.create(null)`) all fail.
  [`restrictedErrors: a listed importer may not hand the module on`](../../tools/layering/test/layering.test.ts),
  [`handOnsOf: the value of an assignment is the gate too`](../../tools/layering/test/layering.test.ts),
  [`handOnsOf: holders a name could hide`](../../tools/layering/test/layering.test.ts),
  [`handOnsOf: an assignment to a name no scope declares is a store on the global`](../../tools/layering/test/layering.test.ts),
  [`handOnsOf: nested and computed destructuring`](../../tools/layering/test/layering.test.ts),
  [`handOnsOf: a lazy getter object is a fresh local object, bound once`](../../tools/layering/test/layering.test.ts),
  [`handOnsOf: the lazy object goes to no other function`](../../tools/layering/test/layering.test.ts)
- **Pages** (`.html`): only the elements, URLs and policies the pages use today. A script is
  only `type="module"` with the `src` of a Vimma module, with no inline code; a link only one of
  today's stylesheets; a meta only `charset="utf-8"`, the colour scheme, or one of today's two
  Content-Security-Policy values; a page with a script or a stylesheet carries exactly one such
  policy, in its head and before the first of them, since a meta policy governs only what loads
  after it and Firefox applies one only in the head; an
  `<a href>` only an about: page or a fragment; no other element with a URL attribute, no `on…`
  attribute, `srcdoc` or `<base>`, and no named reference but the five. An attribute given twice
  in one tag is refused, since the parser keeps the first copy and the check would otherwise
  read another.
  [`htmlImports: only the elements, URLs and policies the pages use today`](../../tools/layering/test/layering.test.ts),
  [`htmlImports: a page is read whole, values across lines and references decoded`](../../tools/layering/test/layering.test.ts),
  [`htmlImports: attributes as the parser keeps them, and the policy first`](../../tools/layering/test/layering.test.ts),
  [`htmlImports: the policy sits in the head`](../../tools/layering/test/layering.test.ts)
- **Encoding:** every file the check reads (modules, pages, `jar.mn`, `vimma/moz.build`,
  vimma-core's sources, the Firefox patches) goes through one read that refuses a byte order
  mark, a NUL byte or bytes that are not UTF-8, so that a page the parser would decode as
  UTF-16 is not read as an empty UTF-8 one; such a file is reported by name and not parsed.
  [`encodingErrors: every file the check reads is UTF-8, as the check reads it`](../../tools/layering/test/layering.test.ts),
  [`treeErrors: a module that is not UTF-8 reports its encoding, not a parse error`](../../tools/layering/test/layering.test.ts)
- **Packaging and file types:** `jar.mn` has only comments (`#` and a space, or `#` alone), one `browser.jar:` header,
  entries that package a script, a page or any file of `vimma/` under its own path (no `.` or
  `..` segment), and `.svg` overrides; `vimma/moz.build` has only its two manifest lists of plain
  strings; every file under `vimma/` is of a known lower-case type, with `jar.mn` and
  `moz.build` only at its top.
  [`jarErrors: only the line forms jar.mn has today`](../../tools/layering/test/layering.test.ts),
  [`jarErrors: scripts and pages are packaged only under their own path`](../../tools/layering/test/layering.test.ts),
  [`jarErrors: manifest lines`](../../tools/layering/test/layering.test.ts),
  [`mozBuildErrors: vimma/moz.build has exactly today's shape`](../../tools/layering/test/layering.test.ts),
  [`fileTypeErrors: types are lower case, and build files only at the top`](../../tools/layering/test/layering.test.ts),
  [`treeErrors: file types, vimma/moz.build and vimma-core are read too`](../../tools/layering/test/layering.test.ts)
- **Firefox patches:** an added line fails when it names the gate's file (escapes and markup
  decoded), holds `content/browser/vimma` or a Vimma URL that names no file, passes an options
  argument next to a Vimma URL, or, in a build file (`moz.build`, `jar.mn`, a manifest), names
  `content/vimma` other than in the four lines `browser/base/moz.build` adds today, in that file.
  [`an added line of a Firefox patch that names a restricted module fails`](../../tools/layering/test/layering.test.ts),
  [`patchErrors: escapes and markup that hide the gate's file name`](../../tools/layering/test/layering.test.ts),
  [`patchErrors: build files and options`](../../tools/layering/test/layering.test.ts),
  [`patchErrors: today's build lines only in browser/base/moz.build`](../../tools/layering/test/layering.test.ts)
- **vimma-core** (`core/` is a copy of `packages/vimma-core/src`): eslint keeps it free of
  Firefox's URLs in `import` declarations and of Firefox's globals by name (ADR-005), and the
  layering check refuses `import()`, `globalThis`, `eval`, `Function` and the gate's file name.
  [`coreErrors: vimma-core reaches no loader the layering check cannot read`](../../tools/layering/test/layering.test.ts)

Not checked, and so left to the review of a change to a listed module or of a new patch
(ADR-026, "Limits of the check"): a function that calls the gate for someone else (an exported
wrapper, a callback or a listener handed out); what a call or a getter of the gate returns (the check
does not follow it; the gate's getters, `grants()` and listener events hand out only frozen
values, M62, so a holder can read them but change nothing of the gate's; a call's result, such
as `request()`'s outcome, is a new object the gate does not keep, and the cancel function
`onCancel` is given withdraws its question); code run
from a string (`eval`, `new Function`, or `Function` reached as `.constructor.constructor`);
reflection that does not name `ChromeUtils` or a worker constructor (a built name such as
`globalThis["Chrome" + "Worker"]`); theme files `jar.mn` packages from outside `vimma/` (its
`skin/classic/browser/vimma/` entries, such as an `.svg`, which can run script when opened as a
document); a URL assembled from finer pieces than one line or
one string shows; a patch to a Firefox build file whose hunk has no `+++` header naming it; and
anything that only a build or a browser run would show.

**Reach:** any local process that can read the token file, an agent's own shell included,
while MCP is on (`:mcp on`). Every check runs in the browser, never in the client: an agent with
a shell can run `vimma-ctl` itself, or speak the protocol directly.

[mcp-drive](../specs/mcp-drive.md) adds `vimma_keys` (Vimma's own page keys in an agent tab: M16, M17,
M20, M23), following its links by hint label (M18, M21), `vimma_show` (the agent workspace brought
to the front with one agent tab selected: M19, M20) and full control's wording while MCP is on
(M22), all in force. [mcp-forms](../specs/mcp-forms.md) adds `vimma_elements` (an agent tab's buttons,
fields and links listed with hint labels, sensitive values left out: M25, M31, M32),
`vimma_activate` (a click on one of them, with no user activation, a form submission asked without a
grant, and under one when it pays, sends text, personal details, a secret or a file, or Vimma cannot
tell what it sends: M25, M26, M28, M29, M32) and `vimma_fill` (fields set as form autofill sets
them, never a password, payment card, one-time-code or file field: M25, M27, M28, M32),
`vimma_screenshot` (an image of an agent tab's viewport, refused while a password or payment card
field on screen has a value: M25, M31, M32) and `vimma_console` (an agent tab's script errors,
console errors and warnings and failed requests, read without running page code: M25, M30, M31,
M32), in force. Since [#584](https://github.com/vimma-browser/vimma/issues/584), `vimma_open`,
`vimma_activate` and `vimma_fill` can return the page's element list in their result, made and
limited as a `vimma_elements` call (M31, M32), and a screenshot is smaller unless the agent asks for
it at full size (M31).

[mcp-grants](../specs/mcp-grants.md) makes a grant cover every agent tool of its connection: a grant
given in answer to any question, a read included, lets that agent open URLs, follow links, press
keys, click buttons that do not submit a form, fill fields, take screenshots and download (not
dangerous or unscanned files) without asking until it ends. An open can carry in its URL what the
agent read, so a grant is a grant to fetch any http or https address from the agent workspace. What
limits it: the agent workspace's container holds none of your other logins (vimma-mcp decision 7),
so what an agent can read is what the agent workspace holds; every call under a grant shows a notice
(an open names its host) and is a `:mcp log` row with its whole URL (M23); at most 10 opens a minute
(M3); `ctrl+b shift+a` ends every grant at once; and an agent with a shell can send what it read
over its own network without Vimma anyway. A step that may pay, a form submission that sends text,
personal details, a secret or a file ([mcp-consequence](../specs/mcp-consequence.md)), a show, a
dangerous or unscanned download and a page's own download still ask under any grant (M11, M13, M19,
M28, M33). [mcp-checkpoints](../specs/mcp-checkpoints.md) makes sending a form and paying checkpoints:
one `y` or `n` (and, on a form that is not a payment, sends no secret or file and whose fields Vimma
read in time and in full number, `a` for that button on that site until the grant ends) that shows
what the step sends or spends and leaves the grant as it was (M28, M33). The question's hint names
only the keys (`a until it quits`, or `10a 10 min`), so that the question fits one line; the guide's
key table says that `a` covers every tool, and the grant's notice, shown the moment it is made, says
so and names what still asks and the key that ends it.

Under [agent-speed](../specs/agent-speed.md) S2, the agent instructions (vimma-ctl's `INSTRUCTIONS`,
which are also the built-in agent's system text) tell an agent to search a site by opening its
search results by URL with `elements: true` rather than by filling the search field and sending the
form, and to do so only for a search. Such a search is a load, not a form submission: it gives no
new reach, since any URL could already be opened under a grant, and it is under the same rules as
every other open (M6, the open rate of M3, the notice and the `:mcp log` row of M23). It skips only
the form question; the words of the search are what the agent puts in the URL, the same risk as any
open (mcp-grants, above). A form sent through the page, a search included, is still a form
submission under M28: asked without a grant, and under one when it is consequential (for a search:
its words typed into a text field rather than `type=search`) or sent by a fill (mcp-consequence K4).

Under [agent-speed](../specs/agent-speed.md) S6, the same instructions tell an agent that steps that
do not depend on each other's results go as several tool calls in one turn, and that each call is
still asked and limited as if it came alone. This changes no rule of the gate: the built-in
agent's loop runs a turn's calls one after another, each checked, rated and logged on its own, so
a checkpoint in the middle of a turn holds back every later call of it until the user answers;
an MCP client that sends a turn's calls at once has them queued, asked and rated one by one as
any other calls (M3's queue and rates).

[mcp-session-grants](../specs/mcp-session-grants.md) makes a bare `a` last the agent's whole
session by default (`[mcp] grant_minutes = 0`): the grant has no time limit and ends when the
agent's connection closes, on `ctrl+b shift+a`, `:mcp revoke` or `:mcp off`, or when Vimma quits.
A count before `a` (`10a`), or `grant_minutes` above 0, still gives a timed grant. One answer
therefore lets an agent act for as long as it runs, possibly hours, rather than ten minutes: the
notices, the status bar's `◇ agent granted`, `:mcp log`, the rate limits and the checkpoints are
what bound it, and the guide advises a grant only for a task you are watching. A `vimma-ctl mcp`
process sends a random 256-bit session id in its `agent-hello`; if its link drops, its grant
waits for a connection with the same id for two minutes and then ends (M5). The id is not a
credential beyond the token: it is sent only over the authenticated socket, and a process that
can read it out of `vimma-ctl`'s memory runs as the user and can read the token as well (§11).

- M1. Every agent command but `agent-hello`, `agent-ping` and `agent-cancel` **must** wait for
  your yes, or run under an unexpired grant of that connection, which covers every tool but those
  that always ask (M11, M13, M19, M28, M33); another connection's grant **never** covers it. A
  waiting call a grant releases **must** be logged as run under the grant, and the grant's
  notice **must** count it, since the user never saw it asked.
  [`test_one_grant_covers_every_tool_of_its_connection`](../../tests/browser/browser_vimma_mcp_agent.js),
  [`a grant covers every tool of its connection, not another connection's`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`a grant lets the connection's queued calls of every tool run, not an always-ask one`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`test_queued_calls_a_grant_releases_show_as_granted`](../../tests/browser/browser_vimma_mcp_agent.js),
  [`an_agents_question_reaches_the_user_and_the_answer_reaches_the_agent`](../../tests/browser/browser_vimma_security_invariants.js)
- M62. The agent gate **must** keep its own frozen copy of what a caller hands it (a
  connection's label, a request's `what`), taken when it is handed in, and hand out only frozen
  values: `connections`, `waiting`, `grants()`, `log` and every listener's event. So the question
  shows, the answer is checked against (a dangerous or unscanned file, a checkpoint's `a` and the
  button it allows) and `:mcp log` records what the request was when it asked, whatever its
  caller does to its object afterwards; a module that reads the gate can neither rename a
  connection nor change a waiting question, an event the next listener hears or a log row; and
  a reader's write never reaches the object the caller acts on. What the caller then does is
  still checked against the page when it runs (decision 19), not against the gate's copy. The
  copy is of JSON-like data: a `__proto__` key stays data, never the copy's prototype, a shared
  object is copied once, and a request nested deeper than 32 levels throws before it is queued
  or logged, so its caller fails closed. A value the copy made is passed through as it is when
  the gate copies again (an event around a question), and its levels are not counted again, so
  the depth limit bounds each copy, not a whole event: a request at the limit is asked,
  answered, run under a grant, logged and heard by every listener; an object anyone else froze
  is still copied. A label, an `announce`'s `what` and a notice are copied when they are handed
  in, so one that cannot be copied throws to its caller before the queue or a listener sees it
  (a label never takes a dropped session's grant). Telling the listeners never throws (a
  listener's throw is logged to the console), and a caller's `onCancel` that throws, on a
  request or a full-control question, withdraws its question, so a call is never logged as run
  behind a throw nor left waiting with its timer behind a rejected promise.
  [`test_question_and_log_show_what_was_asked`](../../tests/browser/browser_vimma_mcp_gate_copies.js),
  [`test_a_dangerous_download_stays_one_file_after_the_caller_changes_it`](../../tests/browser/browser_vimma_mcp_gate_copies.js),
  [`test_a_here_answer_allows_the_button_the_question_named`](../../tests/browser/browser_vimma_mcp_gate_copies.js),
  [`test_ran_events_and_grant_labels_are_the_gates_own`](../../tests/browser/browser_vimma_mcp_gate_copies.js),
  [`frozenCopy copies plain data deeply and freezes every level`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`frozenCopy reads a getter once, and drops functions and cycles`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`test_unscanned_and_pay_are_checked_as_asked`](../../tests/browser/browser_vimma_mcp_gate_copies.js),
  [`test_relabel_keeps_a_frozen_copy`](../../tests/browser/browser_vimma_mcp_gate_copies.js),
  [`test_a_request_too_deep_to_copy_is_never_queued`](../../tests/browser/browser_vimma_mcp_gate_copies.js),
  [`test_a_request_at_the_copy_limit_asks_and_is_heard`](../../tests/browser/browser_vimma_mcp_gate_copies.js),
  [`test_a_request_at_the_copy_limit_runs_under_a_grant`](../../tests/browser/browser_vimma_mcp_gate_copies.js),
  [`test_a_throwing_on_cancel_leaves_nothing_waiting`](../../tests/browser/browser_vimma_mcp_gate_copies.js),
  [`test_a_throwing_on_cancel_leaves_no_full_control_question`](../../tests/browser/browser_vimma_mcp_gate_copies.js),
  [`test_a_label_that_cannot_be_copied_takes_no_session_grant`](../../tests/browser/browser_vimma_mcp_gate_copies.js),
  [`frozenCopy passes its own copy through, so an event around a request at the limit copies`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`frozenCopy still copies an object someone else froze`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`frozenCopy keeps a __proto__ key as its own data, never as the copy's prototype`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`frozenCopy refuses data nested deeper than FROZEN_COPY_DEPTH, with a clear error`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`frozenCopy copies shared sub-objects in linear time, and a cycle still becomes null`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`:mcp log keeps its own row: the caller's object and a reader's row change nothing`](../../packages/vimma-core/test/agent-gate.test.mjs)
- M2. Agent commands **must** see only tabs of the agent workspace in its container, checked
  when each command runs; **never** another workspace's tab, a foreign or pinned tab, or a
  private window's.
  [`test_agent_sees_only_the_agent_workspace`](../../tests/browser/browser_vimma_mcp_agent.js),
  [`test_confinement_edges`](../../tests/browser/browser_vimma_mcp_agent.js)
- M3. No answer within `[mcp] ask_timeout`, a full queue (4 per connection, 16 in all), more
  than 4 requests of one connection waiting or running at once (grants included), more than 10
  opens of one connection in a minute (grants included) and a muted connection (three noes in a
  row, for 60 s; `x`, until it reconnects) **must** deny. A `vimma_open` is refused for the open
  rate before its question as well as after it, so an open over the rate is never asked (issue
  #693); opens asked at once for the last slot can still be refused after a yes, since only the
  count after the question takes the slot.
  [`test_denials_timeouts_queue_and_mute`](../../tests/browser/browser_vimma_mcp_agent.js),
  [`test_a_used_up_open_rate_refuses_before_asking`](../../tests/browser/browser_vimma_mcp_agent.js),
  [`two connections sending 5 each: 4 of each wait in order, the 5th of each is busy`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`three denials in a row mute a connection for 60 s, without asking`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`no sequence of events breaks the queue's limits or resolves a request twice`](../../packages/vimma-core/test/fuzz/agent.fuzz.test.mjs),
  [`test_grants_cannot_flood`](../../tests/browser/browser_vimma_mcp_agent.js),
  [`at most OPEN_RATE.max opens per connection in any OPEN_RATE.ms window`](../../packages/vimma-core/test/agent-gate.test.mjs)
- M4. The question **never** opens by itself while you type, are in a field, or have another
  prompt open, never takes focus, is armed only after `security.dialog_enable_delay` (1 s), a
  held key **never** counts, and no key but `y` or a count with `a` allows; any other key
  neither allows nor denies. It **must** arm again whenever its window is activated or
  deactivated, focused or blurred, hidden or shown, and when a key arrives before it is armed,
  so a window brought to the front (by the user, or by a process that can focus windows) never
  takes a key meant for another; a just-focused window counts as one being typed in. With a
  prompt, picker, panel or the command line open over it, in hint, copy or element mode (whose
  labels and yank type letters: `y` allows, and with the default `hint_chars` a label can start
  with `a`, which grants a whole task), and for
  the rest of a key sequence, the keys are theirs, and the question **never** opens by itself.
  Text an agent or a page chooses (the client name, which is the agent's own claim and proves
  nothing, and titles) is drawn as a bidi isolate (`<bdi>`), URLs as
  left-to-right isolates. A window not in front gets the urgency hint and a notification with no
  URL, no title and no buttons.
  [`test_the_line_opens_arms_and_ignores_stray_keys`](../../tests/browser/browser_vimma_mcp_prompt.js),
  [`test_focus_changes_and_early_keys_rearm_the_line`](../../tests/browser/browser_vimma_mcp_prompt_guards.js),
  [`test_other_ui_opened_over_the_line_gets_the_keys`](../../tests/browser/browser_vimma_mcp_prompt_guards.js),
  [`test_hint_and_copy_mode_keep_their_keys`](../../tests/browser/browser_vimma_mcp_prompt_guards.js),
  [`test_names_titles_and_urls_are_bidi_isolates`](../../tests/browser/browser_vimma_mcp_prompt_guards.js),
  [`test_typing_in_a_field_waits_for_ctrl_b_shift_a`](../../tests/browser/browser_vimma_mcp_prompt.js),
  [`test_a_window_not_in_front_gets_attention_and_a_notification`](../../tests/browser/browser_vimma_mcp_control.js),
  [`any other key neither allows nor denies`](../../packages/vimma-core/test/agent-prompt.test.mjs),
  [`a hostile title of 300 characters is literal text cut at 60 columns`](../../packages/vimma-core/test/agent-prompt.test.mjs)
- M5. Grants **must** be per connection, at most one each, held in memory only, and end on
  `:mcp revoke`, on `ctrl+b shift+a` with no question waiting (one key, no second question), when
  their connection closes and no reconnect of its session claims the grant within 2 minutes, on
  `:mcp off` and, for a timed grant (a count, capped at `[mcp] grant_max_minutes`, or
  `grant_minutes` above 0), at expiry. A grant of a connection that closed **must** be given back
  only to a connection whose `agent-hello` carries the same session id (32 to 128 lowercase hex
  characters), within 2 minutes of the close, once, and never while another open connection holds
  that id; **never** when the connection was muted (`x`); and never for a connection that said
  hello or closed after `:mcp off`, until MCP is on again. `:mcp revoke`, `ctrl+b shift+a` and
  `:mcp off` **must** end such a waiting grant too.
  [`a muted connection's grant is not kept for a reconnect`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`while MCP is off no session is taken or parked, until it is on again`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`keeps its grant within RECONNECT_MS`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`asks again after RECONNECT_MS`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`another session, or none, gets nothing, and the parked grant stays for its own`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`a second connection claiming a live session gets nothing`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`revoke ends a parked grant too`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`turning MCP off ends the parked grants and those of the open connections`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`agent-hello: a session id of 32 to 128 lowercase hex characters`](../../packages/vimma-core/test/control-v2.test.mjs),
  [`test_a_reconnect_of_the_same_session_keeps_its_grant`](../../tests/browser/browser_vimma_mcp_agent.js),
  [`grant_minutes 0: a bare a lasts the whole connection, a count is still minutes`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`grants end on revoke and on disconnect, and are listed shortest first`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`a connection holds at most one grant`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`the length: a count, or the default for a bare a, capped at grant_max_minutes`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`test_one_grant_covers_every_tool_of_its_connection`](../../tests/browser/browser_vimma_mcp_agent.js),
  [`test_a_count_and_a_grant_minutes_shown_in_the_status_bar`](../../tests/browser/browser_vimma_mcp_prompt.js),
  [`test_agent_role_has_its_own_switch`](../../tests/browser/browser_vimma_mcp_agent.js)
- M6. `agent-open` **must** load only http and https, in the agent container, never routed and
  never in the foreground: your window keeps its workspace, selected tab and focus. From an
  agent's request naming an agent tab until its reply, including while Vimma waits for your
  answer, that tab's content process runs at foreground priority (`nsIRemoteTab.priorityHint`).
  This schedules the whole process, which holds only tabs of the agent container, and neither
  shows nor renders anything.
  [`test_agent_open_is_background_and_checked`](../../tests/browser/browser_vimma_mcp_agent.js),
  [`test_a_command_runs_its_tab_at_foreground_priority`](../../tests/browser/browser_vimma_mcp_agent.js),
  [`agent-open: only http and https, at most 65536 characters, an optional tab`](../../packages/vimma-core/test/control-v2.test.mjs)
- M7. Page text and the page's selection **must** be capped (`[mcp] max_read_chars`, and the
  1 MiB line), well-formed Unicode, and returned inside the untrusted-content delimiters, which
  the page cannot close early, not even with a look-alike tag (other spacing or separators,
  full-width letters, attributes; matched after NFKC).
  [`test_agent_read_returns_marked_text_of_a_hidden_tab`](../../tests/browser/browser_vimma_mcp_agent.js),
  [`any page text comes out with exactly one opening and one closing delimiter`](../../packages/vimma-core/test/fuzz/agent.fuzz.test.mjs),
  [`test_the_selection_is_marked_and_fits_the_line`](../../tests/browser/browser_vimma_mcp_agent.js),
  [`test_replies_are_well_formed_unicode`](../../tests/browser/browser_vimma_mcp_agent.js)
- M8. A yes **must** stand only for the tab and URL asked about: if the tab left the agent
  workspace or navigated since, the request is denied (`changed`) and nothing is read, loaded
  or closed; a read checks again after collecting everything, just before it replies.
  [`test_the_yes_stands_for_what_was_asked`](../../tests/browser/browser_vimma_mcp_agent.js),
  [`test_the_read_checks_last`](../../tests/browser/browser_vimma_mcp_agent.js),
  [`test_confinement_edges`](../../tests/browser/browser_vimma_mcp_agent.js)
- M10. Pages in the agent container **must** get no permission prompt and no permission given
  elsewhere: site permissions are kept per container (`permissions.isolateBy.userContext`,
  [vimma-mcp](../specs/vimma-mcp.md) decision 30), every `nsIContentPermissionPrompt` request from
  the agent container is cancelled, and camera, microphone and screen are denied per agent tab (a
  browser-scoped DENY, set on each HTTP response and when each document's window global is
  created, so a page a service worker serves is covered). They **must** open no new window or
  tab (`SANDBOXED_AUXILIARY_NAVIGATION` on every agent tab, which is reloaded if it had loaded
  without it; a top-level document it loads over HTTP loses its `Cross-Origin-Opener-Policy`,
  which Firefox refuses in a sandboxed tab, since an agent tab has no opener and opens no window)
  and launch no other app through an external protocol (Firefox's chooser is wrapped for the
  agent container). Their downloads follow M11-M13. A tab of another workspace
  still asks, opens pop-ups and downloads as before.
  [`test_the_agent_container_asks_for_nothing`](../../tests/browser/browser_vimma_mcp_agent_pages.js),
  [`test_another_workspace_still_asks`](../../tests/browser/browser_vimma_mcp_agent_pages.js),
  [`test_agent_tabs_open_no_popups`](../../tests/browser/browser_vimma_mcp_agent_pages.js),
  [`test_site_permissions_are_per_workspace`](../../tests/browser/browser_vimma_mcp_agent_pages.js),
  [`test_a_page_from_a_service_worker_is_denied_too`](../../tests/browser/browser_vimma_mcp_agent_pages.js),
  [`test_a_sweep_reloads_agent_tabs_that_loaded_unsandboxed`](../../tests/browser/browser_vimma_mcp_agent_pages.js),
  [`test_agent_pages_launch_no_app`](../../tests/browser/browser_vimma_mcp_agent_pages.js),
  [`test_builtin_agent_opens_coop_pages`](../../tests/browser/browser_vimma_agent_coop.js),
  [`test_mcp_agent_opens_coop_pages`](../../tests/browser/browser_vimma_agent_coop.js)
- M11. A download from the agent workspace (by its container, its tab's container, or being written
  to the quarantine folder) **must** ask in the question line first (its name, size, type and host,
  **never** the URL). It is the `vimma_download` of an agent connection only when it is the very
  load that connection's `agent-open` started (its URL before redirects, within a minute, once, and
  never after the tab showed a page); anything else, a page's own download under a grant included,
  asks as "a page in the agent workspace" (no grant, `x` a plain no). Only `https:` is downloaded,
  nothing over `[mcp] download_max_mb` (refused when the size is known, stopped and deleted once it
  grows past it), and a refused download leaves no file. The user's own Save Page, Save Link As and
  Save Image As are the user's (an agent cannot press them) and ask nothing. Another workspace's
  downloads are untouched.
  [`test_the_question_then_yes_saves_to_the_quarantine_0600_unopened`](../../tests/browser/browser_vimma_mcp_downloads.js),
  [`test_no_saves_nothing`](../../tests/browser/browser_vimma_mcp_downloads.js),
  [`test_http_is_refused`](../../tests/browser/browser_vimma_mcp_downloads.js),
  [`test_the_size_cap`](../../tests/browser/browser_vimma_mcp_downloads.js),
  [`test_an_agents_download_is_its_and_a_grant_covers_it`](../../tests/browser/browser_vimma_mcp_downloads.js),
  [`test_a_grant_never_covers_the_pages_own_downloads`](../../tests/browser/browser_vimma_mcp_downloads.js),
  [`test_classified_by_tab_and_by_place_too`](../../tests/browser/browser_vimma_mcp_downloads.js),
  [`test_the_dialog_the_launch_path_a_frame_and_a_blob`](../../tests/browser/browser_vimma_mcp_downloads.js),
  [`test_the_users_save_page_in_an_agent_tab_is_the_users`](../../tests/browser/browser_vimma_mcp_downloads.js),
  [`test_another_workspace_downloads_as_before`](../../tests/browser/browser_vimma_mcp_downloads.js),
  [`name, size, type and extension, and the host in bold; no URL`](../../packages/vimma-core/test/agent-prompt.test.mjs)
- M12. An agent download **must** be written only to the quarantine folder (`[mcp] download_dir`,
  never home, `/`, the Downloads folder itself, a hidden folder of home, `/tmp`, `/var/tmp` or
  `/dev/shm`; made if missing and chmod 0700, which fails on a folder that is not the user's:
  then, or with any other problem, every agent download is refused with a notice, and the tab's
  bytes go to the profile's own refusal folder), as its `.part` and under its name
  (the agent tab's `downloadFolderOverride`, and Firefox's download dialog wrapped so it never
  offers "open with"), saved with mode 0600 (no exec bit), and **never** opened by Vimma, then or
  later from the downloads list.
  [`test_agent_tabs_may_download_again`](../../tests/browser/browser_vimma_mcp_downloads.js),
  [`test_the_question_then_yes_saves_to_the_quarantine_0600_unopened`](../../tests/browser/browser_vimma_mcp_downloads.js),
  [`download_dir is ~ or absolute, never home, / or the Downloads folder itself`](../../packages/vimma-core/test/config-v2.test.mjs),
  [`download_dir is never in a hidden folder of home or in /tmp, /var/tmp, /dev/shm`](../../packages/vimma-core/test/config-v2.test.mjs),
  [`test_a_folder_that_is_not_private_is_refused`](../../tests/browser/browser_vimma_mcp_downloads.js),
  [`[mcp] download_dir and download_max_mb are refused or a quarantine folder in bounds`](../../packages/vimma-core/test/fuzz/config.fuzz.test.mjs)
- M13. A dangerous file (an executable or library by name, type or first bytes; a script, a `#!`
  line, an installer or package; Firefox's executable list; an archive Vimma cannot list; a zip
  whose central directory names one of these, or holds an entry with an exec bit, a symbolic
  link or a path that leaves its folder) **must** be allowed only by `!` for that one file: no
  grant covers it and `y` does nothing. Found only in the finished `.part`, and of another kind
  than the one a `!` allowed, it asks again before the file gets its name, and a no deletes it.
  With the system's `clamscan` (C2) the `.part` is scanned before it gets its name
  (`--alert-encrypted=yes --alert-exceeds-max=yes`), and deleted when ClamAV flags it; when
  ClamAV fails, takes over five minutes, or could not look inside (encrypted, over its limits),
  keeping the file unscanned is asked (y/N, no grant), and a no deletes it. The notice says
  scanned, not fully scanned or not scanned. A clean scan by definitions older than
  `[mcp] clamav_max_age_days` (7 days by default), or with no date in `--version`, is **never**
  reported clean: keeping the file is asked the same way, and a yes says "scanned with outdated
  definitions". `clamdscan` is used only when it passes clamscan's checks, the system's
  clamd.conf passes them too and sets a local socket, no TCP socket and both alerts, and the
  socket is a socket (not a symlink) owned by root or `clamav`, on Linux and macOS alike (C2);
  on any failure the file is scanned by `clamscan`. Vimma has no download reputation service of its
  own: Firefox's Safe Browsing checks downloads only in a build with a Google key (P6), so in a
  keyless build these checks and ClamAV are all there is.
  [`test_a_dangerous_file_needs_bang_for_that_one_file`](../../tests/browser/browser_vimma_mcp_downloads.js),
  [`test_dangerous_content_asks_again_and_no_deletes_it`](../../tests/browser/browser_vimma_mcp_downloads.js),
  [`test_a_different_danger_in_the_bytes_asks_again`](../../tests/browser/browser_vimma_mcp_downloads.js),
  [`an entry with an exec bit is an executable, whatever its name`](../../packages/vimma-core/test/agent-downloads.test.mjs),
  [`a symbolic link is dangerous`](../../packages/vimma-core/test/agent-downloads.test.mjs),
  [`encrypted or over ClamAV's limits: not fully scanned, not infected`](../../packages/vimma-core/test/agent-downloads.test.mjs),
  [`the arguments: fixed, alerting on what it cannot open, the path after --`](../../packages/vimma-core/test/agent-downloads.test.mjs),
  [`test_clamav_clean_infected_error_and_missing`](../../tests/browser/browser_vimma_mcp_downloads.js),
  [`test_clamav_stale_definitions_and_clamd`](../../tests/browser/browser_vimma_mcp_downloads.js),
  [`stale past the set age, or with no date; never otherwise`](../../packages/vimma-core/test/agent-downloads.test.mjs),
  [`clamd.conf: a local socket, no TCP, alerting as clamscan is asked to`](../../packages/vimma-core/test/agent-downloads.test.mjs),
  [`the socket: a socket owned by root or clamav, never by the user or anyone else`](../../packages/vimma-core/test/agent-downloads.test.mjs),
  [`a grant does not run it, whatever was asked: it waits`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`! allows a dangerous one; y, a and counts do nothing there`](../../packages/vimma-core/test/agent-prompt.test.mjs),
  [`a dangerous name inside makes the zip dangerous, and says which`](../../packages/vimma-core/test/agent-downloads.test.mjs),
  [`any bytes: the zip lister and the magic check never throw, and stay inside the file`](../../packages/vimma-core/test/fuzz/agent-downloads.fuzz.test.mjs)
- M9. `vimma-ctl mcp`'s JSON-RPC parsing **never** panics, and its standard output carries
  **only** whole JSON-RPC messages, one per line (logs go to standard error); a line over 1 MiB
  is answered with an error and never kept.
  [`any_line_gets_one_message_or_none`](../../tools/vimma-ctl/tests/mcp_props.rs),
  [`any_outcome_is_one_tool_result`](../../tools/vimma-ctl/tests/mcp_props.rs),
  [`stdout_carries_only_json_rpc_messages`](../../tools/vimma-ctl/tests/mcp.rs),
  [`decoders_never_panic_and_accept_only_the_schema`](../../tools/vimma-ctl/tests/protocol_props.rs)
- M14. `agent-cancel` (MCP's `notifications/cancelled`) **must** withdraw only a question its own
  connection is still waiting on, and **never** asks or counts towards the connection's limit
  of 4 requests at once. [`test_agent_cancel_withdraws_one_waiting_question`](../../tests/browser/browser_vimma_mcp_agent.js),
  [`a_cancelled_call_withdraws_its_question_and_gets_no_response`](../../tools/vimma-ctl/tests/mcp.rs)
- M15. `vimma-ctl mcp` **must** connect only with the `agent` role, take the token only from the
  discovery file, and refuse a tool's bad arguments (a non-http(s) URL, a URL over 65,536
  characters, a tab that is not 1 to 20 digits, an unknown argument) before anything reaches
  Vimma. This is defence in depth: the browser checks all of it again (M2, M6, S7), since an
  agent with a shell can run its own client.
  [`a_read_reaches_vimma_as_the_agent_role`](../../tools/vimma-ctl/tests/mcp.rs),
  [`the_token_never_leaves_the_handshake`](../../tools/vimma-ctl/tests/mcp.rs),
  [`bad_arguments_never_reach_vimma`](../../tools/vimma-ctl/tests/mcp.rs),
  [`bad_arguments_are_tool_errors_and_never_reach_vimma`](../../tools/vimma-ctl/src/mcp/args.rs)
- M16. `agent-keys` **must** run only the whitelisted action ids of mcp-drive D9, parsed with a
  dispatcher of its own over Vimma's default keymap, never the user's; the whitelist is checked
  on the action ids the dispatcher returns. It **never** sends a key event to the page and
  **never** focuses a field: the prefix, `:`, tab, workspace, window, clipboard, insert, copy
  mode and agent actions (`mcp.answer` among them) are refused before anything is asked. A find
  does not run in a tab that has the user's focus, where the finder would focus a text field.
  Keys with control, bidirectional or invisible characters are refused, so the question shows
  what runs.
  [`each refused group is invalid-args naming the key (M16)`](../../packages/vimma-core/test/agent-keys.test.mjs),
  [`a user keymap that binds j to tab.close does not change the agent's j (D10)`](../../packages/vimma-core/test/agent-keys.test.mjs),
  [`any text parses to whitelisted actions within the limits, or is refused`](../../packages/vimma-core/test/fuzz/agent-keys.fuzz.test.mjs),
  [`agent_keys_never_reach_the_prefix_the_command_line_or_mcp_answer`](../../tests/browser/browser_vimma_security_invariants.js),
  [`test_keys_scroll_a_background_tab_without_touching_the_window`](../../tests/browser/browser_vimma_mcp_keys.js),
  [`test_a_find_never_focuses_a_field_of_the_tab_the_user_is_in`](../../tests/browser/browser_vimma_mcp_keys.js)
- M17. `agent-keys` **must** act only on an agent tab (M2), checked before the question, after
  the yes and before each step, in the background: it **never** selects, shows or focuses the
  tab, and **never** changes the window's workspace, mode, find bar or hint mode (finds use the
  tab's own finder, history moves stay in the tab's own session history). A tab the user is
  typing in, in copy or hint mode, a key sequence or its own find bar, is denied `in-use`; a call
  already running stops there.
  [`test_keys_scroll_a_background_tab_without_touching_the_window`](../../tests/browser/browser_vimma_mcp_keys.js),
  [`test_keys_find_uses_the_tabs_finder`](../../tests/browser/browser_vimma_mcp_keys.js),
  [`test_keys_back_and_forward_stay_in_the_tab`](../../tests/browser/browser_vimma_mcp_keys.js),
  [`test_keys_refuses_a_non_agent_tab`](../../tests/browser/browser_vimma_mcp_keys.js),
  [`test_keys_in_use_while_the_user_types_in_the_tab`](../../tests/browser/browser_vimma_mcp_keys.js),
  [`test_keys_stop_when_the_tab_leaves`](../../tests/browser/browser_vimma_mcp_keys.js),
  [`test_keys_stop_when_the_user_starts_using_the_tab`](../../tests/browser/browser_vimma_mcp_keys.js),
  [`test_agent_hints_leave_the_users_hint_mode_alone`](../../tests/browser/browser_vimma_mcp_follow.js)
- M18. A follow (`f<label>`, mcp-drive D12) **must** load only an http or https href the page
  could link to (`checkLoadURIWithPrincipal` with the page's own principal), from an http or
  https page, in the same tab, as a load with no referrer: no click, mousedown or other event
  fires on the link, so no click handler runs (a link to a fragment of the same page fires its
  `hashchange`, as any navigation there would). `f` lists nothing on a page that is not on the
  web (a file, about: or the start page in a tab moved into the agent workspace), whose
  principal may load anything. Its label **must** be from this connection's last `f` on that
  tab, of the top document still shown at the same URL and, for a link in a frame, of that
  frame's document still shown, no older than 120 s; otherwise the step is refused with `stale
labels: send f again`. The 120 s bound `f`'s own list because the child keeps none of its
  links, so nothing else ends a label of a link the page has since replaced; a `vimma_elements`
  list's labels are held by element instead (M25). The label names the href captured when `f` ran, so a frame that
  changed its URL without a new document cannot change where a follow goes. A follow to another site (another
  registrable domain, eTLD+1) **must** be asked as a `vimma_open` of its whole URL, unless the
  connection holds a grant, and a no stops the call (`stopped: "denied"`); it is
  not asked when the open rate has no slot left, and the question is withdrawn when the call's
  60 s run out. Labels
  are over Vimma's default hint characters, never the user's, and the agent's collection is
  keyed by its tab, so it never cancels the user's hint mode in the same window, nor theirs the
  agent's, nor does it take the user's targets from the page's child. Buttons, fields and
  elements clickable only through script are never listed.
  [`test_follow_loads_the_href_without_a_click`](../../tests/browser/browser_vimma_mcp_follow.js),
  [`test_follow_refuses_javascript_and_data_hrefs`](../../tests/browser/browser_vimma_mcp_follow.js),
  [`test_stale_labels_are_refused`](../../tests/browser/browser_vimma_mcp_follow.js),
  [`test_cross_site_follow_asks_as_vimma_open`](../../tests/browser/browser_vimma_mcp_follow.js),
  [`test_agent_hints_leave_the_users_hint_mode_alone`](../../tests/browser/browser_vimma_mcp_follow.js),
  [`test_links_only_on_web_pages`](../../tests/browser/browser_vimma_mcp_follow.js),
  [`f at the end lists the links; f<label> follows one`](../../packages/vimma-core/test/agent-keys.test.mjs),
  [`a collection for an agent carries each link's text, capped, and only links`](../../packages/vimma-core/test/hints.test.mjs)
- M19. `agent-show` (mcp-drive D2-D7) **must** always ask: no grant covers it, a
  grant given as its answer is refused and `x` is a plain no, so no grant of `vimma_show` ever
  exists (core's `ALWAYS_ASK`, whatever the caller passes). It **must** name only an agent tab
  (M2), checked before the question and again after the yes with the URL asked about, and switch
  only the normal window that holds that tab, only to the agent workspace, through the ordinary
  workspace switch, so `ctrl+^` returns to the workspace and split the user was in. It **never**
  changes a private window and **never** raises or activates a window (in the window that
  switches, the shown tab has the keyboard as after any tab switch): a tab in a window other than
  the one in front switches that window, a pane of an agent split included, and the notice says
  `shown in the other window`. A yes whose window cannot switch is a `failed` row in `:mcp log`.
  Its question opens by itself only while the user is not typing or in a field (vimma-mcp
  decision 14), so the switch never lands mid-typing. Showing a page changes what the user sees,
  so a grant would let an agent switch the view at any moment.
  [`test_show_switches_to_the_agent_tab_and_ctrl_caret_returns`](../../tests/browser/browser_vimma_mcp_show.js),
  [`test_show_always_asks_even_under_a_grant`](../../tests/browser/browser_vimma_mcp_show.js),
  [`test_show_waits_while_the_user_types`](../../tests/browser/browser_vimma_mcp_show.js),
  [`test_show_never_touches_a_private_window`](../../tests/browser/browser_vimma_mcp_show.js),
  [`test_show_never_focuses_a_window`](../../tests/browser/browser_vimma_mcp_show.js),
  [`test_show_a_pane_of_an_agent_split_in_a_window_behind`](../../tests/browser/browser_vimma_mcp_show.js),
  [`test_show_refuses_a_tab_changed_after_the_question`](../../tests/browser/browser_vimma_mcp_show.js),
  [`it waits even when asked without always, and a grant answer allows it once only`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`no grant: a, counts and x do not grant or mute`](../../packages/vimma-core/test/agent-prompt.test.mjs),
  [`agent-show: a tab and no other field`](../../packages/vimma-core/test/control-v2.test.mjs)
- M20. `agent-keys`' limits (mcp-drive D15) **must** deny: keys over 512 characters or with
  control characters, more than 32 actions, a count over 99 and a find query over 256 characters
  are `invalid-args` before anything is asked; more than 30 calls of one connection a minute,
  counted when asked and before anything else, are `busy`; a `gu`, `gU` or history step that
  loads a page, and each follow, takes a slot of the 10 opens a minute; a label longer than
  200 links need (3 characters) and a count before `f` are `invalid-args`; a call stops 60 s
  after the yes, and no query to the page holds it longer than 5 s. `vimma-ctl mcp` checks the
  size and characters, the find queries and the counts it can see first; the browser checks all
  of it again. More than 6 `agent-show` calls of one connection a minute (mcp-drive D7), counted
  when asked and before the question, are `busy`, so a refused show cannot be retried in a loop.
  A `busy` denial for a used-up rate (M20's keys and shows, M3's opens and M32's lists, clicks,
  fills, screenshots and console reads) names the limit and, to a vimma-ctl at least as new as
  Vimma or a built-in conversation, carries `retryAfter`, the milliseconds from 1 to 60000 until
  the next call is allowed, so an agent waits for the rate rather than for a question that is
  not there (issue #592); the validators take `retryAfter` on a `busy` denial only. It is learnt
  from the connection's own calls alone, and the refusal still comes before anything else is
  learnt. The built-in agent's runner waits out such a refusal once (at most 60 s, ended by
  stopping the task) and runs the call again, through every check and the rate again, so the
  rate paces the agent and bounds it as before (agent-speed S7, issue #601). `vimma-ctl mcp`
  keeps at most 4 requests of a connection unanswered at once, as many as Vimma takes in flight;
  the rest of its 16 wait in vimma-ctl, so a model's parallel calls are not refused as `busy`.
  It counts what Vimma counts: a call withdrawn or past its deadline stays counted until Vimma
  answers it, an `agent-ping` is counted until its answer and is not sent while 4 are
  unanswered (Vimma's idle limit does not close a connection with a request in flight), and
  `agent-cancel` is not counted (issue #693); a withdrawal that cannot be sent ends the connection, and every call waiting on it fails as on any dropped connection, so no call waits on an id a new connection numbers again. Its 16 is a bound on the calls the client waits
  for; a withdrawn call Vimma never answers holds its place in flight, and the held calls then
  end at their own deadlines.
  [`a_withdrawn_call_counts_in_flight_until_vimma_answers_it`](../../tools/vimma-ctl/tests/mcp.rs),
  [`an_expired_call_counts_in_flight_until_vimma_answers_it`](../../tools/vimma-ctl/tests/mcp.rs),
  [`an_unanswered_ping_counts_in_flight`](../../tools/vimma-ctl/tests/mcp.rs),
  [`a_cancelled_held_call_never_reaches_vimma`](../../tools/vimma-ctl/tests/mcp.rs),
  [`a_held_call_ends_at_its_deadline`](../../tools/vimma-ctl/tests/mcp.rs),
  [`sixteen_calls_wait_at_most_sent_and_held_together`](../../tools/vimma-ctl/tests/mcp.rs),
  [`a count of 100, 33 actions, 513 characters and a 257-character query are refused`](../../packages/vimma-core/test/agent-keys.test.mjs),
  [`agent-keys: a tab and 1 to 512 characters of keys, no control characters`](../../packages/vimma-core/test/control-v2.test.mjs),
  [`at most 30 agent-keys per connection a minute, in OpenRate's class`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`test_keys_under_a_grant_notice_and_rate`](../../tests/browser/browser_vimma_mcp_keys.js),
  [`the refusal names the calls, the limit and the wait`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`retryAfter: 1 to 60000 whole milliseconds, on a busy denial only`](../../packages/vimma-core/test/control-v2.test.mjs),
  [`a_rate_limit_names_the_limit_and_the_wait`](../../tools/vimma-ctl/src/mcp/render.rs),
  [`a_busy_denial_with_retry_after_is_a_rate_limit`](../../tools/vimma-ctl/src/mcp_serve.rs),
  [`a used-up rate`](../../packages/vimma-core/test/agent-results.test.mjs),
  [`test_a_used_up_rate_is_waited_out_not_reported_as_questions`](../../tests/browser/browser_vimma_agent_chat.js),
  [`calls_past_vimmas_four_in_flight_wait_here_and_all_run`](../../tools/vimma-ctl/tests/mcp.rs),
  [`test_loads_count_towards_the_open_rate`](../../tests/browser/browser_vimma_mcp_keys.js),
  [`test_follows_count_towards_the_open_rate`](../../tests/browser/browser_vimma_mcp_follow.js),
  [`a label is lowercase hint characters, at most the longest label of 200 links`](../../packages/vimma-core/test/agent-keys.test.mjs),
  [`bad_keys_are_tool_errors_and_never_reach_vimma`](../../tools/vimma-ctl/src/mcp/args.rs),
  [`at most 6 agent-show per connection a minute`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`test_show_refuses_other_tabs_and_six_a_minute_is_the_most`](../../tests/browser/browser_vimma_mcp_show.js)
- M21. `f`'s link list **must** be one string inside the untrusted-content delimiters, wrapped
  by the browser with look-alike delimiters broken (M7), and `vimma-ctl mcp` and the protocol
  validator **must** refuse a list that is not, or that holds a second delimiter, so the model
  never sees link texts or URLs outside them. At most 200 links, in reading order, and no more
  than fit 768 KiB of the reply line; each link's text and href are NFKC-normalised before they
  are quoted (a fullwidth quote cannot end the text's JSON string), with control,
  bidirectional and invisible characters (tag characters and variation selectors among them)
  dropped, the text one line cut at 80 characters, the href cut at 2,048; the rest are dropped
  and counted. No page text beyond link texts is returned.
  [`test_f_lists_links_with_labels_marked_untrusted`](../../tests/browser/browser_vimma_mcp_follow.js),
  [`at most 200 links; the rest are dropped and counted`](../../packages/vimma-core/test/agent-keys.test.mjs),
  [`one line per link: the label, the text as JSON cut at 80, the href cut at 2,048`](../../packages/vimma-core/test/agent-keys.test.mjs),
  [`text is one line: whitespace collapsed, bidi and control characters dropped`](../../packages/vimma-core/test/agent-keys.test.mjs),
  [`links past the byte budget are left out and counted`](../../packages/vimma-core/test/agent-keys.test.mjs),
  [`agent-keys: a link list inside the untrusted delimiters, and how many were dropped`](../../packages/vimma-core/test/control-v2.test.mjs),
  [`keys_list_links_as_untrusted_content`](../../tools/vimma-ctl/src/mcp/render.rs)
- M22. While MCP is on, `:control on`'s question **must** say that full control reaches every
  workspace and tab, not only the agent workspace, and that any local AI agent with a shell can
  use it, and a yes given after MCP went on or off **never** turns it on; each new full
  connection's question (S13) **must** say `wants full control (every workspace, not only
"agent")` in its text and accessible name, naming the agent workspace, and its desktop
  notification **must** say `(every workspace)`. `vimma-ctl mcp`'s instructions **must** tell the
  model never to ask for full control or `vimma-ctl send-keys`. An agent that wants keys in the
  user's window has to talk the user into full control, so the questions state what a yes gives
  away. [`test_control_on_says_it_reaches_beyond_agent_while_mcp_is_on`](../../tests/browser/browser_vimma_mcp_control.js),
  [`test_full_control_asks_only_while_mcp_is_on`](../../tests/browser/browser_vimma_mcp_control.js),
  [`while MCP is on, the question says full control reaches beyond the agent workspace`](../../packages/vimma-core/test/agent-prompt.test.mjs),
  [`full control names the agent workspace it reaches beyond`](../../packages/vimma-core/test/agent-prompt.test.mjs),
  [`the desktop notification names the client and the kind of request, never a URL`](../../packages/vimma-core/test/agent-prompt.test.mjs),
  [`the_instructions_advise_against_full_control`](../../tools/vimma-ctl/src/mcp/instructions.rs)
- M23. Every agent request that is answered, runs under a grant or is denied (by the gate, or
  after it: `in-use`, `changed`, the keys and show rates) **must** be in `:mcp log`, as must a `vimma_keys`
  call that stopped early (the last 100, in memory only, cleared by `:mcp off`). Each row's
  agent name, title and keys or URL is its own bidi run. Every call under a grant
  **must** show a notice; a `vimma_keys` notice names the keys and the tab, and a follow under a
  grant names the host it loaded. Every follow that loads, asked or under a grant, **must** be a
  row of its own naming the URL it loaded. Grants run calls
  unasked and notices last seconds, so the log is how the user checks afterwards.
  [`test_mcp_log_lists_asked_and_granted_calls`](../../tests/browser/browser_vimma_mcp_log.js),
  [`keeps the last 100, newest first`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`test_keys_under_a_grant_notice_and_rate`](../../tests/browser/browser_vimma_mcp_keys.js),
  [`test_cross_site_follow_asks_as_vimma_open`](../../tests/browser/browser_vimma_mcp_follow.js),
  [`a call under a grant shows what it did and the time left`](../../packages/vimma-core/test/agent-prompt.test.mjs)
- M24. A tab you did not open inside the agent workspace **never** takes its container: a link from
  another app (the remote command line, `vimma-open`, Firefox's container guess, a `[[routes]]`
  rule), the control socket's `open`, a tab sent from another device, a new window's first tab, the
  other URLs of its command line and the container cached for the next start. It opens in the last
  workspace used that is not the agent's (else the first one), and the window switches to it; "the
  current tab" on an agent tab becomes a new tab there. A login link clicked in a mail app is then
  never readable by an agent. What you open from inside the agent workspace (ctrl+t, `:open`, the
  URL bar) stays there.
  [`an_external_link_opens_in_the_last_normal_workspace_and_switches`](../../tests/browser/browser_vimma_agent_outside_opens.js),
  [`browser_dom_window_external_opens_skip_the_agent_container`](../../tests/browser/browser_vimma_agent_outside_opens.js),
  [`tabs_loaded_from_outside_skip_the_agent_container`](../../tests/browser/browser_vimma_agent_outside_opens.js),
  [`a_guess_for_another_workspace_still_counts`](../../tests/browser/browser_vimma_agent_outside_opens.js),
  [`a_route_rule_naming_the_agent_workspace_is_not_followed_from_outside`](../../tests/browser/browser_vimma_agent_outside_opens.js),
  [`a_tab_sent_from_another_device_skips_the_agent_container`](../../tests/browser/browser_vimma_agent_outside_opens.js),
  [`the_agent_workspace_is_known_before_config_toml_names_it`](../../tests/browser/browser_vimma_agent_outside_opens.js),
  [`config_toml_naming_the_agent_workspace_retires_the_recorded_one`](../../tests/browser/browser_vimma_agent_outside_opens.js),
  [`a_control_socket_open_skips_the_agent_container`](../../tests/browser/browser_vimma_agent_outside_opens.js),
  [`a_new_windows_first_tab_and_the_startup_cache_skip_the_agent`](../../tests/browser/browser_vimma_agent_outside_opens.js),
  [`with_no_normal_workspace_used_yet_the_first_one_is_taken`](../../tests/browser/browser_vimma_agent_outside_opens.js),
  [`never the agent workspace, even when it is all there is with a container`](../../packages/vimma-core/test/workspacedefs.test.mjs)
- M25. `agent-elements` (mcp-forms F2-F4) **must** act only on an agent tab (M2), checked before
  the question, after the yes and again once the list is made, with the URL asked about, and in
  the background: it **never** selects, shows or focuses the tab or an element in it, and changes
  nothing on the page (no click, no focus, no event). It lists nothing on a page that is not http
  or https. Each frame's child keeps the agent's elements apart from the user's hint targets, so
  a list never cancels the user's hint mode in the same window and never takes the user's targets
  from the page; its labels replace the connection's last `f` on that tab and are bound as M18's
  are, to this connection, that tab, the top document still shown at the same URL and, for an
  element in a frame, that frame's document still shown, but with no time limit: a label lasts
  until the page navigates, its document changes, a new list or `f` replaces it, or its element
  leaves the page, each of which refuses it (`stale labels` or `that element is gone`). An
  element counts as on the page only while it is connected and still belongs to the document
  it was listed in, so one the page adopts into another document (a frame of its own) is gone
  too. The child holds each listed element by reference, so a label can only ever name the
  element the agent was shown. A time limit added nothing to that, since a page can change an
  element's text within any lifetime, and it refused most clicks of a model that takes 90 s a
  step. What a click or a fill then does is asked and checked at that moment, from the element
  as it is then and never from the list (M26-M28, M33). `f<label>` follows only a link from the
  list, as a load of the href the list showed (M18), and only while the link is still in its
  document. `agent-activate`
  (F8-F11) is held the same way: it clicks only
  an element of the connection's current `vimma_elements` list, on an http or https page, with
  the tab never selected and the element never focused, and it is denied as `in-use` while you
  are using the tab, before the question and after the yes. `agent-fill` (F12) is held the same
  way, and also before each field: it sets only fields of that list, never focusing them, and
  stops when you start using the tab or the tab leaves the agent workspace. `agent-screenshot`
  (F18) is held the same way, checked before the question, after the yes and once the image is
  made: the tab's own top window global draws its viewport with `drawSnapshot`, frames of other
  sites included and **never** the browser's chrome, the status bar or another tab, and a tab in
  the background draws its current page, so the tab is never selected or shown. It captures
  only an http or https page, checked before and after the drawing, never a privileged about:
  page, the start page or a local file a tab moved into the agent workspace may show. It changes
  nothing on the page, so it runs while you use the tab. `agent-console` (F22) is held the same
  way, checked before the question, after the yes and once its lists are made, and like
  `agent-screenshot` reads only an http or https page and runs while you use the tab: it reads
  Firefox's caches and Vimma's request log and touches nothing in the tab.
  [`test_elements_lists_kinds_fields_and_forms`](../../tests/browser/browser_vimma_mcp_elements.js),
  [`test_elements_only_on_web_pages_and_agent_tabs`](../../tests/browser/browser_vimma_mcp_elements.js),
  [`test_agent_labels_leave_the_users_hint_mode_alone`](../../tests/browser/browser_vimma_mcp_elements.js),
  [`test_f_follows_only_links_from_an_elements_list`](../../tests/browser/browser_vimma_mcp_elements.js),
  [`test_labels_of_a_gone_element_are_refused`](../../tests/browser/browser_vimma_mcp_elements.js),
  [`test_element_labels_last_while_their_element_is_there`](../../tests/browser/browser_vimma_mcp_activate.js),
  [`test_screenshot_draws_labels`](../../tests/browser/browser_vimma_mcp_screenshot.js),
  [`an element list's labels last as long as their page, however slow the agent`](../../packages/vimma-core/test/agent-keys.test.mjs),
  [`agent-elements: a tab and no other field`](../../packages/vimma-core/test/control-v2.test.mjs),
  [`test_activate_clicks_a_button_in_a_background_tab`](../../tests/browser/browser_vimma_mcp_activate.js),
  [`test_activate_in_use_while_the_user_types`](../../tests/browser/browser_vimma_mcp_activate.js),
  [`test_activate_follows_a_same_site_link_as_an_open`](../../tests/browser/browser_vimma_mcp_activate.js),
  [`agent-activate: a tab and a label of hint characters, nothing else`](../../packages/vimma-core/test/control-v2.test.mjs),
  [`test_fill_never_focuses_the_field`](../../tests/browser/browser_vimma_mcp_fill.js),
  [`test_fill_in_use_while_the_user_types`](../../tests/browser/browser_vimma_mcp_fill.js),
  [`test_fills_take_labels_only_from_elements_and_share_the_click_rate`](../../tests/browser/browser_vimma_mcp_fill.js),
  [`agent-fill: a tab, fields by label and value, an optional submit`](../../packages/vimma-core/test/control-v2.test.mjs),
  [`test_screenshot_of_a_background_tab_shows_its_page`](../../tests/browser/browser_vimma_mcp_screenshot.js),
  [`test_screenshot_only_of_agent_tabs`](../../tests/browser/browser_vimma_mcp_screenshot.js),
  [`agent-screenshot: a tab and an optional labels flag, nothing else`](../../packages/vimma-core/test/control-v2.test.mjs),
  [`test_console_returns_uncaught_errors_and_console_errors`](../../tests/browser/browser_vimma_mcp_console.js),
  [`test_console_only_of_agent_tabs_and_web_pages`](../../tests/browser/browser_vimma_mcp_console.js)
- M26. An agent's click (`agent-activate`, mcp-forms F8) **must** be the frame's child calling
  the element's `click()` after the same untrusted `mouseover`, `mousedown` and `mouseup` your
  `f` hints send, with no event through `nsIDOMWindowUtils` or the widget, so the page gets no
  transient user activation: it cannot write or read the clipboard, use credentials or passkeys,
  or start anything else that needs a real gesture. Vimma **never** gives an agent tab's
  document user activation. A trusted `click()` still runs the page's click listeners in
  Firefox's older "handling user input" state, which some checks accept (audible autoplay,
  pointer lock, a pop-up); pop-ups are refused in agent tabs by their sandbox flags (M10).
  Before the click the child checks again that the element is still the one asked about (not a
  field, not disabled, a submit only if asked as one and to the same method and destination,
  the same link), and once more after the mouse events, which the page can handle; a changed
  element is not clicked and the call says so. It answers before it clicks, so a dialog the
  click opens never holds the call; a request that answers after the call stopped waiting
  clicks nothing. A click whose page is hidden between that answer and the click (a navigation in
  the page's process, or the back-forward cache) clicks nothing: the child skips it on the page's
  trusted `pagehide`, which the page cannot stop, and tells the parent then, naming the step by the
  parent's own number, ahead of the next document, so the call says nothing was clicked instead of
  reporting the new page as the click's. A navigation to another process is not covered: the old
  process can still run the click or skip it after the switch, its message can arrive late or not at
  all, and the call then reports the click as run. An element of a page its frame no longer shows is
  never pressed, by an agent or by your hints, and no step the child runs after its answer is left
  undecided when the page breaks it: it is skipped. A dialog's text reaches the agent only inside
  the untrusted-content delimiters, and no tool answers a page dialog. After a click that loaded no
  page, the result says which parts of the page changed in place (`changed`: the clicked element,
  the other listed elements, the frame's text outside scripts and styles, a visible dialog element),
  as fixed words from a list that both the browser and `vimma-ctl mcp` check; the comparison runs in
  the clicked element's frame's child, which keeps only a hash of the text, sends no page text and
  reads no sensitive field's value, as in `vimma_elements` (M31). That check runs once the clicked
  element's frame has settled (M28), after the submission allowance of M28 is closed, so it opens
  nothing; a submission the page tries during the call is still stopped and named.
  [`test_activate_gives_the_page_no_user_activation`](../../tests/browser/browser_vimma_mcp_activate.js),
  [`test_activate_says_what_changed_in_place`](../../tests/browser/browser_vimma_mcp_activate_changes.js),
  [`activate_says_what_changed_in_place`](../../tools/vimma-ctl/src/mcp/render.rs),
  [`agent-activate: what changed in place, from a fixed list`](../../packages/vimma-core/test/control-v2.test.mjs),
  [`agent_clicks_never_synthesise_input_or_user_activation`](../../tests/browser/browser_vimma_security_invariants.js),
  [`test_activate_reports_a_dialog`](../../tests/browser/browser_vimma_mcp_activate.js),
  [`test_a_click_a_navigation_overtakes_is_skipped_and_said`](../../tests/browser/browser_vimma_agent_click_race.js),
  [`test_a_click_on_a_page_going_into_the_bfcache_is_skipped`](../../tests/browser/browser_vimma_agent_click_race.js),
  [`test_a_hint_click_after_the_page_was_replaced_clicks_nothing`](../../tests/browser/browser_vimma_agent_click_race.js),
  [`test_a_page_that_stops_its_pagehide_still_has_the_click_skipped`](../../tests/browser/browser_vimma_agent_click_race.js),
  [`test_an_outcome_asked_as_the_page_goes_away_reads_the_skip`](../../tests/browser/browser_vimma_agent_click_race.js),
  [`test_a_late_skip_of_an_earlier_step_is_not_the_next_ones`](../../tests/browser/browser_vimma_agent_click_race.js),
  [`test_a_late_skip_after_the_current_ones_leaves_it_skipped`](../../tests/browser/browser_vimma_agent_click_race.js),
  [`agent-activate: the page after the click, a dialog, a stopped submission`](../../packages/vimma-core/test/control-v2.test.mjs),
  [`activate_says_what_the_click_did`](../../tools/vimma-ctl/src/mcp/render.rs)
- M27. `agent-fill` (mcp-forms F12, F13) **must never** set a sensitive field: one that is or
  ever was a password field, one the page draws as dots (`-webkit-text-security`), one whose
  autocomplete field name is `current-password`, `new-password`, `one-time-code` or any `cc-*`,
  or one form autofill's heuristics take for a payment card field (every field of its group when
  they fail). Nor a file field, a hidden, disabled or read-only field, an editable root, or a
  value a field does not take (a line break outside a text area, an option a select does not
  have or only in a disabled group, a date, number or range that does not parse or is out of
  bounds). These are refused before anything is asked, and the parent counts a password input
  and a sensitive autocomplete name whatever the child says. In the field's own
  frame the child checks again, when the yes comes and once more just before the set, that the
  field is still set the same way, of the same type and not sensitive; a field that changed
  stops the call, says how many fields were filled, and is not set. The one call of
  `setUserInput` (text fields and text areas) sits behind those checks, and no code the agent
  role reaches gives an input a file. A select is set to its option alone (a multiple select
  loses its other options) and ends the choice as its popup does (`userFinishedInteracting`); a checkbox or radio is clicked, with no user
  activation (M26). Nothing is focused and no key event is sent. At most 32 fields a call, each
  value at most 1,024 characters with no control character but a line break and no character
  that draws nothing (format, zero-width, bidirectional and tag characters, variation
  selectors, fillers), which could hide text from the question; checked in `vimma-ctl mcp` and
  again in the browser. The question shows each field's label, name and value, cut with `…` to
  fit and the fields it leaves out counted; a fill that submits is refused unless its question
  shows every name and value whole. `:mcp log` keeps the values of the calls asked or run in
  full, in memory; a call refused before its question is logged with its labels. A child
  request that runs after the parent stopped waiting sets nothing, nor does one whose page is
  hidden before it runs (a navigation in the page's process, or the back-forward cache). The
  call stops there and tells the agent that field "is gone: its page went away" when the
  navigation replaced the page, or "changed since the user was asked" when the page went into
  the back-forward cache.
  [`test_fill_refuses_password_card_otp_and_file_fields`](../../tests/browser/browser_vimma_mcp_fill.js),
  [`test_fill_stops_when_a_field_turns_sensitive`](../../tests/browser/browser_vimma_mcp_fill.js),
  [`test_a_fill_on_a_page_going_into_the_bfcache_sets_nothing`](../../tests/browser/browser_vimma_agent_click_race.js),
  [`test_a_fill_a_navigation_overtakes_is_said_gone`](../../tests/browser/browser_vimma_agent_click_race.js),
  [`test_fill_sets_values_and_fires_input_and_change`](../../tests/browser/browser_vimma_mcp_fill.js),
  [`agent_fills_never_set_a_file`](../../tests/browser/browser_vimma_security_invariants.js),
  [`password, payment card and one-time-code fields are never filled`](../../packages/vimma-core/test/agent-act.test.mjs),
  [`file fields, rich text editors, hidden, disabled and read-only fields are refused`](../../packages/vimma-core/test/agent-act.test.mjs),
  [`a value of the wrong kind, a line break in one line, a value that does not parse`](../../packages/vimma-core/test/agent-act.test.mjs),
  [`fill_limits_are_tool_errors`](../../tools/vimma-ctl/src/mcp/args.rs),
  [`fill_values_with_invisible_characters_are_tool_errors`](../../tools/vimma-ctl/src/mcp/args.rs),
  [`vimma_fill: each field and value in the question, how many in the notice`](../../packages/vimma-core/test/agent-prompt.test.mjs)
- M28. A click that submits a form (a submit button or a submit or image input in a form whose
  method is not `dialog`, the element itself, the button it is in or its label's control)
  **must** ask every time without a grant, and under a grant when it is consequential
  ([mcp-consequence](../specs/mcp-consequence.md) K2, K3): a payment step (M33); a form that sends
  a password, payment card, one-time-code or file field, an identity field (an autocomplete
  name of a person's name, contact, address, birth date, username or organisation, one form
  autofill's address heuristics infer, or `type=email` or `tel`; a failure of the heuristics
  marks every field), or free text (a textarea or a text-like input other than `type=search`
  whose value is not empty and not a quantity of at most three ASCII digits, read on the raw
  value so digits of other scripts or forms never pass); or a form whose fields the page did not say
  in time, that sends more than the 64 fields besides hidden ones the child reads, or one of whose
  values is longer than the child reads of it. It asks with only `y` and `n`, naming the form's
  method, destination and each field it sends by name and value (hidden fields counted, a file field
  by its name), **never** a password, payment card or one-time-code field's value, only its name and
  `•••`, or the number of fields when the page did not say in time; its yes **never** makes or ends
  a grant, and its `x` is a plain no. Under a grant, a submission that is none of the above runs
  unasked, with the grant's notice and a `:mcp log` row naming its method and destination (M23), and
  the guard below lets that one submission through as after a yes. Because another call (a fill) may
  change the form between that judgement and the click, the child judges the form again just before
  it presses the button, after the page's handlers of the pressing ran, and skips the click when it
  no longer passes (no longer harmless, or, under an allowance, sending a secret, a file or a value
  it cannot read whole). Under a grant, the question of a consequential submission that is not a
  payment step, sends no password, card, one-time-code or file field, and is known whole (its fields
  said in time, none past the 64 besides hidden ones the child reads, no value, the pressed button's
  and each chosen option's included, longer than the 1024 characters the child reads of it) also
  takes `a` (mcp-consequence K5), because an allowance must not rest on a form Vimma did not read
  whole: it allows that submission and every later click of the same connection whose tab's site
  (registrable domain), form method, destination (scheme, host, port and path) and pressed button's
  text are the same, checked again on each click against the payment, secret and known-whole
  rules, until the grant ends (its end, `ctrl+b shift+a`, `:mcp revoke`, a built-in conversation's
  stop, the connection's close; an allowance is held in memory and never kept for a reconnect); `a`
  on a payment's question, or without a grant, allows nothing beyond that step. An allowance covers
  later submissions whatever text or personal details they send, which no question shows. Not
  covered: a page's own script that copies typed text into hidden fields before a harmless-looking
  submission, as a page's own `fetch` is not (mcp-forms F17);
  a form that sends only the page's own values runs unasked under a grant whatever it does on
  the server (deleting, unsubscribing, confirming a step whose text an earlier step sent), and
  only the payment signals of M33 add a question there; a short number typed into a plain text
  field (a quantity, but also a three-digit code) is not free text. So **must** a fill that submits (`vimma_fill` with `submit`, through a submit button's
  label or the form's default submission), under a grant too, naming the same and
  the fields it fills, only through a submit button of the filled fields' own form or that
  form's default submission, and it is not sent when the page put back a value the question
  showed. A fill allows its submission only after its last field is set, so a form the page
  submits while it is being filled is cancelled like any other.
  Before every click and every fill the tab is marked in the parent, after the page's transient user
  activation is consumed in every frame, and from then on, while its top document is the same,
  the request of every navigating form submission in it (any frame, a submit button,
  `requestSubmit()` or a later `submit()`, whatever the page cached) **must** be cancelled
  before it is sent when it carries no transient user activation, unless it is the one
  submission the question allowed, during that call, with the method and destination (scheme,
  host, port and path) it named; a redirect of a submission let through follows on. The call's
  wait for a page counts from when the click or the submission ran in the page's process, not
  from the child's reply before it, so that the allowance is still open when a busy process runs
  the step late; it still ends with the call. A step that starts no load ends its call once the
  step's frame has settled, which its own process tells: no change to its document for 250 ms
  and no request the step opened still open, 1.3 s when the page has not changed at all, at
  most 2 s; a load the step started is waited for until the new page has had its
  `DOMContentLoaded` and 200 ms without a change. A submission the step itself makes starts its
  load in that process before the settle's answer, over the same IPC channel, so the call waits
  for that load with the allowance open. A step that has started no load a second after it ran
  has its allowance withdrawn then, while the wait goes on, so a page that keeps itself busy
  (changing its document, holding a request open) never keeps the allowance open longer than
  the second it had before; the parent bounds each of these answers itself, so a page that
  blocks its own process cannot hold the call either. A submission the page makes later, after
  the call, is outside the allowance and is cancelled while the mark stays, as any other, though
  the result can no longer name it. That wait is bounded: a child that does not answer
  whether the step ran is taken as having run after 1 s, one that keeps answering that it has not
  run yet after 5 s, and the whole wait ends after 20 s. When the child skips a step, because the
  page changed the element or the form as it was pressed, it tells the parent in the same task,
  before any page script runs again, and the parent withdraws the allowance on that message: the
  message and every load or request the page's process starts later go over the same IPC
  channel, in order, so a page that puts the form back and submits by itself, at once or after
  keeping its process busy, is cancelled. The call then refuses the click, and a fill says the
  form was not sent. A step whose page is hidden before it runs by a navigation in the page's
  process, or the back-forward cache (M26), is skipped the same way, its message sent as the page is
  hidden, while the frame can still send it; across a process switch it may not arrive, and the
  allowance then stays open until the call ends, still only for the method and destination the
  question named. A submission the page starts while the element is being pressed, before the
  child's check, cannot be told from the click's own: it is let through only to the asked method and
  destination, as the click's would be. A frame of another process in the tab is not ordered with
  that message, and until the call ends it too can send only the asked submission. So can a subframe
  that skips the step and is removed before its message is sent: the allowance stays open until the
  call ends, still only for the method and destination asked. The result and `:mcp log` name the
  host it was going to. Clicks and fills on one tab run one at a time, so no call takes another's
  allowance. Your activation after the step (a click or a key of yours in that page) and your `f`
  hints end the mark, so your own submissions in an agent tab go through, and so do those of a page
  no agent stepped in. Not covered: a page the agent's click loaded that submits a form by itself
  (the mark ends with the document it was set on), requests that are not http or https, and data a
  button's script sends with `fetch`, also from a cancelled submission's `submit` listener: such a
  button is an ordinary click (mcp-forms F17).
  [`test_submit_asks_under_a_grant`](../../tests/browser/browser_vimma_mcp_submit.js),
  [`test_a_skipped_submit_in_a_frame_withdraws_the_allowance`](../../tests/browser/browser_vimma_agent_click_race.js),
  [`test_basket_form_runs_under_a_grant`](../../tests/browser/browser_vimma_mcp_checkpoint.js),
  [`test_message_form_asks_under_a_grant`](../../tests/browser/browser_vimma_mcp_checkpoint.js),
  [`test_a_allows_that_button_on_that_site`](../../tests/browser/browser_vimma_mcp_checkpoint.js),
  [`test_a_is_not_offered_on_a_pay_step`](../../tests/browser/browser_vimma_mcp_checkpoint.js),
  [`free text, an identity field, a secret or a file makes it consequential`](../../packages/vimma-core/test/agent-checkpoint.test.mjs),
  [`a allows only a known form that pays nothing and sends no secret or file (K5)`](../../packages/vimma-core/test/agent-checkpoint.test.mjs),
  [`a is not offered for a form with a value cut to fit: it is not known whole (K5)`](../../packages/vimma-core/test/agent-checkpoint.test.mjs),
  [`test_a_long_button_value_or_chosen_option_asks`](../../tests/browser/browser_vimma_mcp_checkpoint.js),
  [`an allowance ends with the grant: its end, revoke, endGrant`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`test_a_message_cut_or_written_late_still_asks`](../../tests/browser/browser_vimma_mcp_checkpoint.js),
  [`a value cut to fit, digits in other scripts or forms, or a long number is free text`](../../packages/vimma-core/test/agent-checkpoint.test.mjs),
  [`test_page_script_submit_after_a_click_is_cancelled`](../../tests/browser/browser_vimma_mcp_submit.js),
  [`test_a_submission_the_page_makes_after_a_click_is_still_cancelled`](../../tests/browser/browser_vimma_mcp_waits.js),
  [`test_an_allowed_submission_the_page_holds_back_is_cancelled_later`](../../tests/browser/browser_vimma_mcp_waits.js),
  [`test_a_page_kept_busy_does_not_keep_the_allowance_open`](../../tests/browser/browser_vimma_mcp_waits.js),
  [`test_an_allowed_submission_to_a_slow_server_goes_through`](../../tests/browser/browser_vimma_mcp_waits.js),
  [`test_users_own_submit_in_an_agent_tab_goes_through`](../../tests/browser/browser_vimma_mcp_submit.js),
  [`test_a_submit_sent_elsewhere_than_asked_is_stopped`](../../tests/browser/browser_vimma_mcp_submit.js),
  [`test_a_submit_listener_moving_the_destination_is_stopped`](../../tests/browser/browser_vimma_mcp_submit.js),
  [`test_page_submits_after_a_cached_verdict_or_through_a_dialog_are_stopped`](../../tests/browser/browser_vimma_mcp_submit.js),
  [`test_an_allowed_submit_follows_its_redirect`](../../tests/browser/browser_vimma_mcp_submit.js),
  [`test_the_users_earlier_input_does_not_cover_an_agents_click`](../../tests/browser/browser_vimma_mcp_submit.js),
  [`test_a_page_submitting_with_no_agent_step_is_untouched`](../../tests/browser/browser_vimma_mcp_submit.js),
  [`vimma_activate can be granted; a submit asks under any grant and makes none`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`a submit: method and host in bold, the field count, y or n only`](../../packages/vimma-core/test/agent-prompt.test.mjs),
  [`a submit button, a submit or image input in a form is a submit`](../../packages/vimma-core/test/agent-act.test.mjs),
  [`test_fill_submit_asks_under_a_grant`](../../tests/browser/browser_vimma_mcp_fill.js),
  [`test_a_skipped_submit_lets_no_later_submission_through`](../../tests/browser/browser_vimma_mcp_submit.js),
  [`test_a_skipped_submit_is_not_sent_and_allows_nothing_after_it`](../../tests/browser/browser_vimma_mcp_fill.js),
  [`test_a_skipped_default_submit_is_not_sent_and_allows_nothing_after_it`](../../tests/browser/browser_vimma_mcp_fill.js),
  [`test_page_script_submit_after_a_fill_is_cancelled`](../../tests/browser/browser_vimma_mcp_fill.js),
  [`the_submit_check_test_hook_is_read_only_in_automation`](../../tests/browser/browser_vimma_security_invariants.js),
  [`test_a_page_submit_during_a_fill_is_not_the_asked_one`](../../tests/browser/browser_vimma_mcp_fill.js),
  [`test_selects_ranges_and_a_submit_button_of_another_form`](../../tests/browser/browser_vimma_mcp_fill.js),
  [`a fill that submits: the destination, then the fields, y or n only`](../../packages/vimma-core/test/agent-prompt.test.mjs),
  [`test_submit_question_lists_the_fields_it_sends`](../../tests/browser/browser_vimma_mcp_submit.js),
  [`a form checkpoint lists the fields it sends, sensitive ones as •••`](../../packages/vimma-core/test/agent-prompt.test.mjs),
  [`a form checkpoint cleans the page's names and values and cuts them to fit`](../../packages/vimma-core/test/agent-prompt.test.mjs),
  [`a malformed fields reply is refused, and a secret never carries a value`](../../packages/vimma-core/test/agent-checkpoint.test.mjs),
  [`a click grant covers fills; a fill that submits asks under it`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`a plain button, a reset, one outside a form or one closing a dialog is not`](../../packages/vimma-core/test/agent-act.test.mjs)
- M29. `agent-activate` **must** refuse, before anything is asked, a link to another site than
  the tab's (by registrable domain, mcp-drive D18; the agent follows it with `vimma_keys`, which
  asks as `vimma_open`), a link that is not http, https or `javascript:`, a text field, a select,
  an editable root, a file field (also through its `<label>`), a disabled control and a label
  of `f`'s link list. A click that loads a page takes a slot of the open rate (M3), and no click
  is made while that rate is used up.
  [`test_activate_refuses_fields_files_disabled_and_other_sites`](../../tests/browser/browser_vimma_mcp_activate.js),
  [`test_activate_never_follows_a_link_moved_elsewhere_or_an_svg_link`](../../tests/browser/browser_vimma_mcp_activate.js),
  [`a gone element, a field, a select, a file field, a disabled control are refused`](../../packages/vimma-core/test/agent-act.test.mjs),
  [`a link to another site is refused: vimma_keys follows it (M29)`](../../packages/vimma-core/test/agent-act.test.mjs),
  [`a link to something other than a web page is refused`](../../packages/vimma-core/test/agent-act.test.mjs),
  [`anything malformed or over its cap is refused`](../../packages/vimma-core/test/agent-act.test.mjs)
- M30. `agent-console` (mcp-forms F22, F23) **must not** evaluate code, call a page function,
  start the DevTools server, the Remote Agent or Marionette, or read a property of a page object.
  It reads only what Firefox keeps whether or not anyone asks: each frame's child reads its
  process's `nsIConsoleService` (script errors at error and warning level, by its document's
  inner window id, their text and position only, never their exception or stack) and
  `ConsoleAPIStorage` (the page's `console.error` and `console.warn` calls, whose arguments are
  copied only when they are strings, numbers, booleans, bigints, null or undefined, and are
  otherwise named by their `typeof` alone, so no getter, `toString` or proxy trap of the page
  runs); the parent adds what its own console service logged for those documents. A frame's
  answer is checked entry by entry (core's `parseConsoleEntry`) and cut, as any reply from a
  content process; at most 100 frames are asked, and each answers only its newest 100 entries
  after `since`, cut in the child and counted beyond, so a page that logs without end cannot
  make the parent copy and sort all of it. No user name or password of a script, file or
  request URL reaches the agent. Failed requests (HTTP status 400 and above, or a channel error other than a
  cancel, a redirect or a load turned download) **must** be logged only for channels whose top
  browsing context is a live tab of the agent workspace's container outside private windows,
  only while MCP is on, the last
  100 per tab in memory, with the URL's user name and password removed; a tab's log goes when it
  closes, and every log goes when MCP turns off.
  [`test_console_runs_no_page_code`](../../tests/browser/browser_vimma_mcp_console.js),
  [`test_console_returns_failed_requests_with_status`](../../tests/browser/browser_vimma_mcp_console.js),
  [`test_request_log_cleared_when_the_tab_closes_or_mcp_turns_off`](../../tests/browser/browser_vimma_mcp_console.js),
  [`a console call's arguments: primitives as text, anything else as its type`](../../packages/vimma-core/test/agent-act.test.mjs),
  [`a request failed at status 400 and above, or with a channel error but a cancel`](../../packages/vimma-core/test/agent-act.test.mjs),
  [`an entry from a content process is checked, and its strings cut`](../../packages/vimma-core/test/agent-act.test.mjs),
  [`agent-console: a tab and an optional since, nothing else`](../../packages/vimma-core/test/control-v2.test.mjs),
  [`console_calls_become_agent_commands`](../../tools/vimma-ctl/src/mcp/command.rs),
  [`test_a_noisy_page_sends_one_replys_worth`](../../tests/browser/browser_vimma_mcp_console.js),
  [`a console call's huge arguments are cut before they are joined`](../../packages/vimma-core/test/agent-act.test.mjs),
  [`a frame answers only its newest entries after since, at most a list's worth`](../../packages/vimma-core/test/agent-act.test.mjs),
  [`no user name or password of a script or request URL reaches the agent`](../../packages/vimma-core/test/agent-act.test.mjs)
- M31. `agent-elements`' list **must** be one string inside the untrusted-content delimiters,
  wrapped by the browser with look-alike delimiters broken (M7), and `vimma-ctl mcp` and the
  protocol validator **must** refuse a list that is not, or that holds a second delimiter. At
  most 200 elements, in reading order, and no more than fit 768 KiB of the reply line, as one
  JSON object a line with the forms they name first (at most 64); every page string is
  NFKC-normalised and stripped of bidirectional and invisible characters before it is quoted,
  and of control characters too except a value's tabs and line breaks, which JSON escapes; no
  page `<`, line separator or paragraph separator appears literally in the list (each is
  escaped as `\u003c`, `\u2028`, `\u2029`), so no page string can spell a delimiter; texts and
  captions are cut at 80 characters, values at 256, hrefs and form actions at 2,048, at most 50
  options a select; the rest are dropped and counted, and the reply's URL and title are capped. The child's description
  of each element is a fresh, checked copy (core's `parseAgentElement`). A sensitive field **must
  never** be listed with its value or its selected option: a field that is or was ever a
  password field, one the page draws as dots (`-webkit-text-security`), one whose autocomplete
  field name is `current-password`, `new-password`, `one-time-code` or any `cc-*` name (a
  password type and these names are counted in the parent too, whatever the child says), and
  one form autofill's heuristics infer as a payment card field, with, in a card form, any field
  they leave to their machine-learning model; if the heuristics fail, every field of that form
  counts. A one-time-code field without that autocomplete name or a mask is not recognised. No page text beyond the elements' own is returned, except a target's accessible label and, for a text that repeats in the list, the heading of its card (mcp-forms F5, issue #693), both as its `caption`, under the same checks and cuts. The label includes the text of the elements its `aria-labelledby` names, hidden ones too, as a screen reader reads them; it never reads script, style, noscript or template text or a field's or rich text editor's content, and reads at most 8 ids and 512 characters.
  The list `agent-open`, `agent-activate` and `agent-fill` return when asked with `elements`
  (issue #584) **must** be made by the same code as `agent-elements`' own, so every rule above
  holds for it, and the validator and `vimma-ctl mcp` check it the same way; it is made only
  after the step, of a page that is no longer loading, and only while the tab is still an agent
  tab with the URL it had when the list began (else the result says why, in fixed words, and
  holds no list; a page that is one of Firefox's error pages is named by its error code, which
  the validator and `vimma-ctl mcp` accept only from a fixed list, never as the page's text;
  `vimma_elements` on such a tab refuses with the same code, and the built-in agent's stop after
  three identical refusals counts both); the result's URL and title are read at the last such check, and a tab that
  left the agent workspace meanwhile fails the call, noted in `:mcp log`, with nothing of its
  page; its labels become the connection's current ones as a `vimma_elements` list's do. The
  step's question (a checkpoint's included), its `:mcp log` row and its notice under a grant say
  that the list is taken too.
  A compact list ([agent-speed](../specs/agent-speed.md) S3, S4) changes what a list holds, never
  how it is made or wrapped: every rule above holds for the lines it writes, which are the same
  lines a full list writes. How to read a list is said once, in the `vimma_elements` tool
  description; each result keeps its untrusted-content header (the page's URL and title) and its
  intro saying that the text is the page's. A list of a page whose origin the connection has
  listed before leaves out the element lines identical, label, form number and state included,
  to its last list of that origin, and the result names their labels in `repeated`: labels only
  (1 to 3 hint characters, each once), outside the delimiters, which the validator and
  `vimma-ctl mcp` refuse otherwise, so no page string reaches the agent by that route. The
  comparison runs in the parent on the lines made from the checked copies, so it adds no path
  the page controls; a page can only make a line identical to one it already showed, which says
  of its element what that line said. Form lines are always written, so the numbers mean this
  page's forms. A sensitive field's line has no value, so it stays identical whatever the page
  types into it, and no value is ever compared or returned. Labels are counted over the whole
  page, so leaving lines out changes no label; the elements a list gave, written or left out,
  are the ones the connection can click or fill, and a label the newest list did not give is
  refused. What is kept per connection is the last list's lines for at most 16 origins, dropped when the
  connection closes and when a built-in conversation's context is cleared, so a new conversation,
  or one whose model no longer has the earlier lists, gets every list in full. The lines are kept
  once the list is made, before the client has read the reply: a client that drops a reply (a
  cancelled call, a context its client compacted) can be handed labels of lines it never saw, and
  `full: true`, which the tool description names, lists every line again; a label still clicks
  only an element of the page now. `query` (at most 200 characters of one line, matched NFKC and
  case-folded against an element's label, text, caption and name as the list writes them, cut at
  80 characters, never its value) and `kinds` (kinds of the list's own) leave out the elements
  that do not match, and their labels with them; neither reaches the page.
  [`test_repeated_list_leaves_out_unchanged_lines`](../../tests/browser/browser_vimma_mcp_elements.js),
  [`test_compact_list_keeps_delimiters_and_sensitive_rules`](../../tests/browser/browser_vimma_mcp_elements.js),
  [`test_elements_query_and_kinds`](../../tests/browser/browser_vimma_mcp_elements.js),
  [`test_clear_forgets_the_last_element_lists`](../../tests/browser/browser_vimma_agent_conversations.js),
  [`query matches only what the list writes: text cut at 80 characters, as shown`](../../packages/vimma-core/test/agent-act.test.mjs),
  [`an element list leaves out lines given earlier for the same site and counts them`](../../packages/vimma-core/test/agent-act.test.mjs),
  [`a sensitive field is left out only when its line, without a value, is the same`](../../packages/vimma-core/test/agent-act.test.mjs),
  [`a sensitive field's value is never matched`](../../packages/vimma-core/test/agent-act.test.mjs),
  [`a list's repeated labels come with it, each a label, at most once`](../../packages/vimma-core/test/control-v2.test.mjs),
  [`a_compact_list_names_the_labels_it_left_out`](../../tools/vimma-ctl/src/mcp/render.rs),
  [`element_lists_take_query_kinds_and_full`](../../tools/vimma-ctl/src/mcp/args.rs),
  [`test_a_steps_list_says_nothing_of_a_tab_that_left`](../../tests/browser/browser_vimma_mcp_elements.js),
  [`test_steps_return_the_element_list_vimma_elements_would`](../../tests/browser/browser_vimma_mcp_elements.js),
  [`a step's list is inside the untrusted delimiters, with its dropped count`](../../packages/vimma-core/test/control-v2.test.mjs),
  [`why a step's list is missing: fixed words, never with a list`](../../packages/vimma-core/test/control-v2.test.mjs),
  [`a load error: one of Firefox's codes, only with unlisted error`](../../packages/vimma-core/test/control-v2.test.mjs),
  [`a code outside the fixed list is other, never the page's text`](../../packages/vimma-core/test/load-errors.test.mjs),
  [`a_load_that_ended_on_an_error_page_is_an_error_naming_it`](../../tools/vimma-ctl/src/mcp/render.rs),
  [`a load that ended on Firefox's error page is an error result naming the error`](../../packages/vimma-core/test/agent-results.test.mjs),
  [`an open that ends on Firefox's error page three times ends the task`](../../packages/vimma-core/test/agent-loop.test.mjs),
  [`test_builtin_open_names_the_error_page`](../../tests/browser/browser_vimma_agent_load_error.js),
  [`a_steps_element_list_is_untrusted_content_as_vimma_elements`](../../tools/vimma-ctl/src/mcp/render.rs),
  [`an_open_with_elements_lists_the_page_it_loaded`](../../tools/vimma-ctl/src/mcp/render.rs),
  [`a step that returns the element list says so in the question and the notice`](../../packages/vimma-core/test/agent-prompt.test.mjs),
  [`test_password_and_card_fields_are_sensitive_without_values`](../../tests/browser/browser_vimma_mcp_elements.js),
  [`test_elements_lists_kinds_fields_and_forms`](../../tests/browser/browser_vimma_mcp_elements.js),
  [`passwords, one-time codes and every cc-* name are sensitive; email is not`](../../packages/vimma-core/test/agent-act.test.mjs),
  [`a sensitive field carries no value and no selected option`](../../packages/vimma-core/test/agent-act.test.mjs),
  [`a password input is sensitive whatever the child says`](../../packages/vimma-core/test/agent-act.test.mjs),
  [`no page < appears literally, and values keep no raw line or paragraph separator`](../../packages/vimma-core/test/agent-act.test.mjs),
  [`an autocomplete name that is sensitive makes the field sensitive whatever the child says`](../../packages/vimma-core/test/agent-act.test.mjs),
  [`anything malformed, over its cap or naming a form not reported is refused`](../../packages/vimma-core/test/agent-act.test.mjs),
  [`a sensitive field says so and never carries a value`](../../packages/vimma-core/test/agent-act.test.mjs),
  [`texts and captions cut at 80, values at 256, hrefs at 2,048, at most 50 options`](../../packages/vimma-core/test/agent-act.test.mjs),
  [`page strings are NFKC, one line, without bidi, control or invisible characters`](../../packages/vimma-core/test/agent-act.test.mjs),
  [`elements past the byte budget are left out and counted; their forms too`](../../packages/vimma-core/test/agent-act.test.mjs),
  [`agent-elements: the page, its list inside the untrusted delimiters, how many dropped`](../../packages/vimma-core/test/control-v2.test.mjs),
  [`elements_list_as_untrusted_content`](../../tools/vimma-ctl/src/mcp/render.rs)

`agent-screenshot`'s image (F19) **must** be a PNG, or a JPEG when the PNG does not fit, whose
base64 is at most 700 KiB, at most 1,280 by 16,384 pixels; unless asked `full`, it is at most
1,024 pixels wide and the smaller of a PNG and a JPEG (issue #584); the protocol validator and
`vimma-ctl mcp` **must** refuse any other type, size or encoding, and `vimma-ctl mcp` **must**
pass it on as an MCP image item only after the untrusted header, which says that text in the
image is web content and not from you. Labels drawn on it (F20) come only from the
connection's current `vimma_elements` list of that page, and only while its top frame has
not scrolled since the list was made and for 120 s after it, because they are drawn at the
places the list recorded and a page that updates in place moves its elements without a
navigation; else none is drawn and the result says the list is stale. A screenshot **must** be refused (F21) while a sensitive field as above, with a value,
meets the viewport of any frame of the tab: each frame's child checks, just before and again
just after the drawing, every form control of its document and its open and closed shadow
trees, a number field showing text it cannot parse and an autofill preview counting as a
value, a select counting when its choice differs from the page's default; a field counts even
if the page covers or hides it otherwise, and a frame that fails counts as showing one. A
frame that has no Vimma actor (a data: or blob: document) or does not answer in 5 s refuses
the screenshot too, saying that Vimma could not check every frame. A scroll of the top frame
between the two checks discards the image. The agent's own steps on that tab and its
screenshot exclude each other: from the first check to the second, `agent-keys`,
`agent-activate` and `agent-fill` there are denied as `in-use` (a running `agent-keys` stops
before its next step), and a screenshot is refused while one of them runs, so the agent cannot
scroll or change the tab between its checks. A page that is not http or https is refused
before the question. A value the page copies out of such a field into
other text, or draws on a canvas, is not recognised, and a value that appears and goes again
within the moment of the drawing, between the two checks, is not seen by either.
[`test_screenshot_refused_while_a_sensitive_value_is_on_screen`](../../tests/browser/browser_vimma_mcp_screenshot.js),
[`test_screenshot_fits_the_reply_line`](../../tests/browser/browser_vimma_mcp_screenshot.js),
[`test_screenshot_is_smaller_unless_asked_full`](../../tests/browser/browser_vimma_mcp_screenshot.js),
[`test_screenshot_draws_labels`](../../tests/browser/browser_vimma_mcp_screenshot.js),
[`test_screenshot_and_the_agents_own_steps_exclude_each_other`](../../tests/browser/browser_vimma_mcp_screenshot.js),
[`the scale: at most 1,280 pixels wide, at most the device pixel ratio`](../../packages/vimma-core/test/agent-act.test.mjs),
[`labels at their element's corner, scaled; those off the image are left out`](../../packages/vimma-core/test/agent-act.test.mjs),
[`agent-screenshot: the image, its size, the page, and the labels drawn`](../../packages/vimma-core/test/control-v2.test.mjs),
[`a_screenshot_is_an_image_after_the_untrusted_header`](../../tools/vimma-ctl/src/mcp/render.rs),
[`screenshot_calls_become_agent_commands`](../../tools/vimma-ctl/src/mcp/command.rs)

`agent-console`'s errors and failed requests (F24) **must** each be one string inside the
untrusted-content delimiters, wrapped by the browser as above, and the protocol validator and
`vimma-ctl mcp` **must** refuse either list when it is not. At most 100 errors and 100 failed
requests, newest first, one JSON object a line, and no more than fit 512 KiB of the reply
line together, the oldest left out and counted; messages are cut at 1,000 characters and URLs
and files at 512, page strings are NFKC-normalised and stripped of invisible characters, and
no page `<`, line separator or paragraph separator appears literally. Messages and URLs are
the page's own and can carry tokens it put there; they come only from the agent's own tab.
[`the lists: newest first, only after since, at most 100 each, within the bytes`](../../packages/vimma-core/test/agent-act.test.mjs),
[`no page string can spell a delimiter or a line of its own`](../../packages/vimma-core/test/agent-act.test.mjs),
[`agent-console: the page, its errors and requests inside the delimiters, the time`](../../packages/vimma-core/test/control-v2.test.mjs),
[`console_lists_as_untrusted_content`](../../tools/vimma-ctl/src/mcp/render.rs)

- M32. More than 30 `agent-elements` calls, 30 `agent-activate` and `agent-fill` calls
  together, 12 `agent-screenshot` calls, or 30 `agent-console` calls, of one connection a minute (mcp-forms F21, F26), counted when asked and before the
  question, **must** be denied as `busy`, so a grant cannot flood a page and a refused call
  cannot loop; an `agent-open`, `agent-activate` or `agent-fill` asked with `elements` counts
  as an `agent-elements` call as well (issue #584), and with those used up it is denied as
  `busy` before anything of it runs; every call, asked, under a grant or denied, **must** be in `:mcp log` (M23), a
  click with its element, a fill with its fields and values (one refused before its question,
  with its labels), and a submission with its destination, and a call under a grant shows a notice naming the page (and for a click, the
  element; for a fill, how many fields).
  [`at most 30 agent-elements per connection a minute`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`test_elements_under_a_grant_notice_log_and_rate`](../../tests/browser/browser_vimma_mcp_elements.js),
  [`test_a_steps_list_counts_as_an_elements_call`](../../tests/browser/browser_vimma_mcp_elements.js),
  [`vimma_elements: the tab in the question, the page in the notice`](../../packages/vimma-core/test/agent-prompt.test.mjs),
  [`at most 30 agent-activate per connection a minute`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`test_activate_under_a_grant_notice_log_and_rate`](../../tests/browser/browser_vimma_mcp_activate.js),
  [`vimma_activate: the element in the question, what it clicked in the notice`](../../packages/vimma-core/test/agent-prompt.test.mjs),
  [`test_fill_submit_asks_under_a_grant`](../../tests/browser/browser_vimma_mcp_fill.js),
  [`test_fills_take_labels_only_from_elements_and_share_the_click_rate`](../../tests/browser/browser_vimma_mcp_fill.js),
  [`at most 12 agent-screenshot per connection a minute`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`vimma_screenshot can be granted, and its grant covers the other tools`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`test_screenshot_under_a_grant_notice_log_and_rate`](../../tests/browser/browser_vimma_mcp_screenshot.js),
  [`vimma_screenshot: the tab in the question, the page in the notice`](../../packages/vimma-core/test/agent-prompt.test.mjs),
  [`at most 30 agent-console per connection a minute`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`vimma_console can be granted, and its grant covers the other tools`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`test_console_under_a_grant_notice_log_and_rate`](../../tests/browser/browser_vimma_mcp_console.js),
  [`vimma_console: the tab in the question, the page in the notice`](../../packages/vimma-core/test/agent-prompt.test.mjs)
- M33. A payment step (mcp-checkpoints C6) **must** ask under any grant, with only `y` and `n`
  (`x` is a plain no; `a` is no answer there and an allowance of M28 **never** covers it), and
  its yes **never** makes, lengthens or ends a grant; its no denies that step only. The pay
  phrases only add questions (mcp-consequence K6). A payment step is a `vimma_activate` click, a `vimma_fill` that submits, or a
  `vimma_keys` follow, `gu`, `gU`, `H` or `L`, in an agent tab whose page shows a payment card
  field in any frame (a `cc-*` autocomplete name or form autofill's card heuristics; a frame
  whose check fails or that does not answer within 5 s counts as one, a frame that navigates
  away or whose process ends during the check does not), or whose pressed control has a phrase
  of the fixed list (`PAY_PHRASES`, six languages) as whole words in its text, accessible name,
  title or value; the accessible name includes the text its `aria-labelledby` names, which the
  element list shows the model as the control's `caption` (issue #693), so the check reads every
  name the model is shown. Its question **must** name the button (for a key step, its keys), the host of
  the frame of the control or link the step presses or follows, followed by the tab's host in
  parentheses when that frame is of another site (a payment provider's hosted frame; a key step
  that presses nothing, and a frame with no host of its own, such as about:srcdoc, data: or
  blob:, name the tab's host), and the total the page states, quoted after "the page says" and
  cut at 40 columns; a card field's value is **never** read, and the desktop notification names
  no site, amount or URL. Not covered: a load of another site is not stopped, so a hosted
  payment page reached through a button whose words are not on the list stops the agent only at that page's own card
  fields or pay button; a page that hides its checkout (no card field shown, a button worded
  otherwise) is not recognised; a frame Vimma's actor does not cover (a data: or blob: document)
  is not asked for card fields; and the total is the page's own claim, which the user's bank or
  card statement settles.
  [`test_pay_button_outside_a_form_asks_under_a_grant`](../../tests/browser/browser_vimma_mcp_checkpoint.js),
  [`test_card_fields_in_a_cross_site_frame_make_a_pay_step`](../../tests/browser/browser_vimma_mcp_checkpoint.js),
  [`test_a_pay_button_in_a_cross_site_frame_names_the_frames_site`](../../tests/browser/browser_vimma_mcp_checkpoint.js),
  [`test_a_followed_pay_link_in_a_cross_site_frame_names_the_frames_site`](../../tests/browser/browser_vimma_mcp_checkpoint.js),
  [`a pay button in a frame of another site names that site, then the tab's`](../../packages/vimma-core/test/agent-prompt.test.mjs),
  [`test_basket_button_does_not_ask`](../../tests/browser/browser_vimma_mcp_checkpoint.js),
  [`test_a_no_stops_the_step_and_keeps_the_grant`](../../tests/browser/browser_vimma_mcp_checkpoint.js),
  [`test_the_stated_total_is_quoted`](../../tests/browser/browser_vimma_mcp_checkpoint.js),
  [`test_a_key_that_acts_where_it_may_pay_asks`](../../tests/browser/browser_vimma_mcp_checkpoint.js),
  [`test_checkpoint_notice_log_row_and_notification`](../../tests/browser/browser_vimma_mcp_checkpoint.js),
  [`card fields alone, and a pay phrase alone, make a payment step; neither makes none`](../../packages/vimma-core/test/agent-checkpoint.test.mjs),
  [`a phrase inside another word is not one`](../../packages/vimma-core/test/agent-checkpoint.test.mjs),
  [`property: a phrase of the list, with any text around it apart by a space, matches`](../../packages/vimma-core/test/agent-checkpoint.test.mjs),
  [`a payment checkpoint names the button, site and stated amount`](../../packages/vimma-core/test/agent-prompt.test.mjs),
  [`a checkpoint offers y and n only, and x is a plain no`](../../packages/vimma-core/test/agent-prompt.test.mjs),
  [`a checkpoint asks under a grant, its yes leaves the grant as it was`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`property: no answer to a checkpoint makes, lengthens or ends a grant`](../../packages/vimma-core/test/agent-gate.test.mjs)
- M34. The `vimma-ctl` version an `agent-hello` names (`ctl`, spec
  [ship-vimma-ctl](../specs/ship-vimma-ctl.md)) is a label, as `client` and `via` are: it **must**
  change only whether Vimma shows the older-client notice, **never** what the connection may do,
  so an older or a lying client gets every check any other gets. A `ctl` that is not a Vimma
  version **must** be refused with the rest of the hello. The discovery file's `version` is
  Vimma's own version, which the `welcome` gives any client anyway.
  [`test_an_older_vimma_ctl_gets_a_notice_and_still_works`](../../tests/browser/browser_vimma_mcp_agent.js),
  [`says older for a client that names no version: it predates the check`](../../packages/vimma-core/test/ctl-version.test.mjs),
  [`is optional, and refused with the whole hello when it is not a version`](../../packages/vimma-core/test/ctl-version.test.mjs)
