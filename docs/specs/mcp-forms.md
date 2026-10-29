# Spec: mcp-forms

Status: implemented · Area: `packages/vimma-core/src/` (`agent-act.mjs` and `agent-element.mjs` new, `agent.mjs`, `hints.mjs`,
`agent-prompt.mjs`, `control.mjs`); `src/browser/base/content/vimma/` (`ctl/agent-commands.mjs`,
`ctl/AgentAct.sys.mjs` new, `ctl/AgentShot.sys.mjs` new, `ctl/AgentConsole.sys.mjs` new, `ctl/AgentDrive.sys.mjs`,
`actors/VimmaActors.sys.mjs`, `actors/VimmaChild.sys.mjs`, `actors/agent-fields.mjs` new);
`tools/vimma-ctl` (`src/mcp.rs`, `tests/fixtures/mcp/tools-list.json`); `tests/contract/control/v2/`
· Upstream patches: none · ADR: [ADR-019](../adr/019-agents-over-mcp.md) (unchanged: it leaves
clicks, form filling and screenshots to a spec with its own threat review, which this is). No new
dependency.

Issue: [#231](https://github.com/vimma-browser/vimma/issues/231)

Builds on [mcp-drive](mcp-drive.md) (per-tab hint sessions, agent-tab confinement, the `in-use`
rule) and [vimma-mcp](vimma-mcp.md) (the agent workspace, protocol 2's `agent` role, the question
line, grants and limits). Decisions of those specs are written "mcp-drive D12" and "vimma-mcp 19";
this spec's own are "F1", "F2", and so on. Engine paths are relative to `engine/` (Firefox 158.0.1,
`config/milestone.txt`). Vimma paths are under `src/browser/base/content/vimma/` unless they start
with `packages/`, `tools/` or `tests/`; line numbers are at commit `5af9cf4b`.

## Summary

Five MCP tools let an agent act on a page of the agent workspace and see the result, without
leaving it. `vimma_elements` lists the page's buttons, fields and links with hint labels,
`vimma_activate` clicks one, and `vimma_fill` fills fields. `vimma_screenshot` returns an image of
an agent tab, and `vimma_console` returns its script errors and failed requests, read-only. No key
or mouse event from the operating system's input path is synthesised: a click is the DOM's
`click()`, a field is filled the way Firefox's form autofill fills it, and nothing grants the page
user activation. Password, payment and one-time-code fields are never filled, and a form
submission asks every time.

## Problem

After mcp-drive an agent can scroll, find text, follow links, go back and show the user a page.
It cannot finish most tasks that a page is for:

- **Search boxes and forms.** A site search, a filter, a sign-up form on the agent's own
  development server, a "load more" button: each needs a click or text in a field.
  `vimma_keys` refuses `i`, `gi` and every key that would type (mcp-drive D9), and its `f`
  follows links only, as loads of their href (mcp-drive D12).
- **Seeing what the user sees.** `vimma_read_page` returns text. A layout bug, an image, a chart
  or a button covered by a banner is invisible to it.
- **Knowing why a page fails.** An agent that builds a web app and tests it in Vimma cannot see a
  JavaScript exception or a request that came back 500. It guesses from the page text.

The only route to any of this today is full control (`:control on` and `vimma-ctl send-keys`),
which presses real keys wherever focus is, in every workspace (mcp-drive, "Problem").

## Behaviour

1. An agent calls `vimma_elements { tab: "7" }`. The question line asks
   `◇ claude-code wants vimma_elements: 2 "Sign up · Example" example.com/signup`. On `y` the
   agent gets the visible buttons, fields, links and other clickable elements of that tab, each
   with a hint label, its kind and its text, and each field's type, name and current value,
   marked as untrusted web content. The user's window keeps its workspace, tab, focus and mode.
2. `vimma_fill { tab: "7", fields: [{ label: "sd", value: "ada@example.com" }] }` asks
   `◇ claude-code wants vimma_fill: 2 "Sign up · Example"  sd Email = "ada@example.com"`. On `y`
   the field holds the value, the page receives `input` and `change` events, and the tab is
   neither selected nor focused.
3. A password field, a field that was ever a password field, a payment card field and a
   one-time-code field are listed with `"sensitive": true` and no value. Filling one is refused
   before anything is asked, with the tool error
   `field "sf" is a password field; Vimma never fills it: ask the user to type it`. A file field
   is refused the same way.
4. `vimma_activate { tab: "7", label: "sg" }` on a button `Add to list` asks
   `◇ claude-code wants vimma_activate: 2 "List · Example"  sg button "Add to list"`. On `y` the
   button is clicked. The result gives the tab's URL, title, whether a page loaded, and whether a
   dialog opened. (Since changed: when no page loaded, it also names what changed in place, here
   `the page's text changed`; F11.)
5. Activating a submit button, or a `vimma_fill` with `submit`, asks every time, also under a
   grant, with only `y` and `n`:
   `◇ claude-code wants to submit a form: 2 "Sign up · Example" → POST example.com/api/signup (3 fields)`.
   (Since changed: a checkpoint that lists the fields it sends; mcp-checkpoints Behaviour 4.)
6. A page whose script submits a form on its own after an agent's click does not submit it:
   Vimma cancels that submission, and the result says
   `the page tried to submit a form to example.com; Vimma stopped it`. A form the user submits
   themselves in an agent tab is not affected.
7. `vimma_screenshot { tab: "7" }` returns an image of that tab's viewport, taken in the
   background, under a header that says its content is untrusted. With `labels: true` the labels
   of the tab's last `vimma_elements` are drawn on it.
8. `vimma_console { tab: "7" }` returns the page's recent script errors and failed requests, with
   their source and status. Nothing runs in the page to get them.
9. Under a grant each call shows a notice, such as
   `claude-code filled 2 fields in "Sign up · Example" (grant, 12m left)`, and `:mcp log` lists
   every call (mcp-drive D14).
10. While the user is typing in the tab (mcp-drive D13), `vimma_activate` and `vimma_fill` are
    denied with `in-use`, and a call under way stops.

## Research

### Vimma at `5af9cf4b`

- **Agent hint sessions.** `AgentDrive` keeps one session of labels per connection and agent tab
  (`ctl/AgentDrive.sys.mjs:89-90`, `LinkSession` at `:49-51`), bound to the document and URL it was
  collected on and to a 120 s lifetime (`current`, `:238-243`; `AGENT_LINKS`,
  `packages/vimma-core/src/agent-keys.mjs:54-58`). The collection runs under the tab's own key, so
  the user's hint mode in the same window is left alone (`collectHints` with
  `agent`, `actors/VimmaActors.sys.mjs:258-262`). An agent's collection asks for links only
  (`linksOnly = agent || …`, `:266`), and the child does not keep its elements: only the user's
  collection is stored for a later activation (`#hints`, `actors/VimmaChild.sys.mjs:161`; the
  `texts` case skips it at `:611`).
- **Hint targets.** `actors/hint-collect.mjs` finds what a user could click in the viewport: links,
  buttons, non-hidden inputs, selects, text areas, `summary` and editable roots (`STRONG`,
  `:41-49`), elements with click handlers or ARIA widget roles (`DECLARED`, `:55-75`), and
  focusable elements, skipping what is hidden or covered. `kindOf` (`:116-124`) sorts them into
  `link`, `input` (text-like controls, `select`, `textarea`, editable roots) and `click`
  (`TEXTLESS` input types such as `checkbox`, `radio`, `file`, `submit`, `:100-110`).
- **The user's activation.** `VimmaChild#activateHint` (`actors/VimmaChild.sys.mjs:632-672`)
  focuses a text field, opens a select's picker, or else dispatches `mouseover`, `mousedown` and
  `mouseup` built with the page's own `MouseEvent` constructor, then calls `click()`.
- **The gate.** `AGENT_TOOLS` maps each asking command to its tool (`packages/vimma-core/src/agent.mjs:112-119`);
  `ALWAYS_ASK` lists tools that ask under any grant and never make one (`:125`, `vimma_show`).
  Rates per connection: `OPEN_RATE` 10 a minute (`:132`), `KEYS_RATE` 30 (`:138`), `SHOW_RATE` 6
  (`:144`). Page text is wrapped by `wrapUntrusted` (`:476`) and introduced by `untrustedHeader`
  (`:485`; `untrusted_header`, `tools/vimma-ctl/src/mcp.rs:1264`).
- **Using the tab.** `VimmaHost.inUse(browser)` (`host/VimmaHost.sys.mjs:1709-1724`) is true when
  the tab is shown in the focused window and is in insert, copy or hint mode, in a `/` search,
  has its find bar open, or a key sequence is pending.
- **Protocol 2.** `AGENT_COMMANDS` (`packages/vimma-core/src/control.mjs:34-44`) and `DENY_REASONS`
  (`:49-57`). `screenshot` is a reserved command of the `full` role (`RESERVED_COMMANDS`, `:26`),
  never built. A reply line is at most 1 MiB (`MAX_LINE`, `tools/vimma-ctl/src/protocol.rs:18`).
- **Agent pages.** Agent tabs open no pop-ups (`SANDBOXED_AUXILIARY_NAVIGATION`,
  `ctl/AgentPages.sys.mjs:34`), get no permission prompts and launch no external apps
  (vimma-mcp 30).

### Firefox (158.0.1): acting without synthesised input

- **Two ways to click.** `nsContentUtils::SynthesizeMouseEvent`
  (`dom/base/nsContentUtils.cpp:10397-10553`, behind `nsIDOMWindowUtils.sendMouseEvent`) builds a
  widget event and hands it to `PresShell::HandleEvent` or the widget, so it goes through
  `EventStateManager::PreHandleEvent` (`layout/base/PresShell.cpp:9329`) like a real mouse
  press. `HTMLElement.click()` (`nsGenericHTMLElement::Click`,
  `dom/html/nsGenericHTMLElement.cpp:2363-2420`) builds a positionless `click` with input source
  "unknown", marked trusted when the caller is system code (`:2406-2408`), and dispatches it
  directly with `EventDispatcher::Dispatch`, without the event state manager.
- **User activation.** Transient user activation is set by
  `EventStateManager::NotifyTargetUserActivation` (`dom/events/EventStateManager.cpp:1519-1592`),
  which returns early for an event that is not trusted or is a synthesized mouse event (`:1521-1528`),
  and is called only from `PreHandleEvent` (`:1253`, `:1306`, `:1382`). A `click()` call never
  reaches it, so it gives the document no transient activation. What needs that activation
  therefore fails after an agent's click: clipboard writes (`Clipboard::Write` through
  `nsContentUtils::IsCutCopyAllowed`, `dom/events/Clipboard.cpp:916-919`,
  `dom/base/nsContentUtils.cpp:8951-8959`), clipboard reads (`Clipboard.cpp:392`), `execCommand`
  paste (`dom/base/Document.cpp:5855-5862`), and credential and passkey requests
  (`dom/credentialmanagement/CredentialsContainer.cpp:45-54`).
- **"Handling user input" is different.** While a trusted `mousedown`, `mouseup` or `click`
  listener runs, `EventListenerManager` sets the "handling user input" state
  (`dom/events/EventListenerManager.cpp:1537-1543`; `UserActivation::IsUserInteractionEvent`,
  `dom/base/UserActivation.cpp:89-118`), which only counts a depth and a start time and sets no
  transient activation (`StartHandlingUserInput`, `:121-129`). `PaymentRequest.show()` checks only that state
  (`dom/payments/PaymentRequest.cpp:736`), but the Payment Request API is off
  (`dom.payments.request.enabled: false`, `modules/libpref/init/StaticPrefList.yaml:4183-4185`).
  Pop-ups that the state would allow are blocked in agent tabs by their sandbox flags.
- **Events the actor constructs are not trusted.** An event made with the page's constructor is
  trusted only when its global is a chrome document (`Event::Init`, `dom/events/Event.cpp:406-421`;
  `MouseEvent::Constructor`, `dom/events/MouseEvent.cpp:146-163`). The `mouseover`, `mousedown`
  and `mouseup` that `#activateHint` builds with the content window's `MouseEvent` are therefore
  `isTrusted: false`; only the `click()` is trusted.
- **Filling a field.** `HTMLInputElement.setUserInput(value)` is chrome-only
  (`dom/webidl/HTMLInputElement.webidl:231-236`). It sets the value as user input, dispatches
  `input`, and dispatches `change` at once when the field does not have focus
  (`dom/html/HTMLInputElement.cpp:2529-2569`). It also pushes the "handling user input" state
  (`:2531`). For a file input and a system caller it sets the file list from a path
  (`:2533-2546`). Firefox's form autofill fills text controls with `setUserInput`, and a
  `select` by setting `value` and dispatching `input` and `change`
  (`toolkit/components/formautofill/shared/FormAutofillHandler.sys.mjs:1115-1133`); the
  password manager uses `setUserInput` too
  (`toolkit/components/passwordmgr/LoginManagerChild.sys.mjs:2601`). A value set this way counts
  as an interactive change (`dom/html/TextControlState.cpp:2358-2359`).
- **Sensitive fields.** `hasBeenTypePassword` is true for an input that was ever
  `type=password`, so a "show password" toggle that switches it to `text` does not hide it
  (`dom/webidl/HTMLInputElement.webidl:187-188`); the password manager's own test is
  `hasBeenTypePassword` plus a type that can autocomplete
  (`toolkit/components/passwordmgr/LoginManager.shared.sys.mjs:153-175`).
  `getAutocompleteInfo()` gives the parsed `autocomplete` field name (`cc-number`,
  `current-password`, `one-time-code` …; `HTMLInputElement.webidl:204-207`,
  `HTMLSelectElement.webidl:83`, `HTMLTextAreaElement.webidl:101`). Without an `autocomplete`
  attribute, form autofill infers field names from labels, names and neighbours
  (`FormAutofillHeuristics.getFormInfo` and `inferFieldInfo`,
  `toolkit/components/formautofill/shared/FormAutofillHeuristics.sys.mjs:1158`, `:1378`;
  `FormAutofillUtils.isCreditCardField`, `FormAutofillUtils.sys.mjs:173-178`), over a form-like
  group from `toolkit/modules/FormLikeFactory.sys.mjs`.
- **Form submission.** Every navigating form submission passes a chrome-only, cancelable
  `DOMFormBeforeSubmit` event: a submit button, an implicit submission and `requestSubmit()`
  through `MaybeSubmit` (`dom/html/HTMLFormElement.cpp:233-318`, the event at `:286`, before the
  page's `submit` event), and script's `form.submit()` through `SubmitSubmission` (`:797-845`,
  the event at `:840`). Cancelling it stops the navigation (`:844-846`) but not the page's own
  `submit` listeners, which `MaybeSubmit` still fires (`:309-318`). The event is dispatched only
  to chrome (`DispatchBeforeSubmitChromeOnlyEvent`, `:1049-1058`); Firefox's form history and
  form handler actors listen for it (`toolkit/modules/ActorManagerParent.sys.mjs:385-404`;
  `toolkit/components/satchel/FormHandlerChild.sys.mjs:54-55`). A submission that a page makes
  with `fetch` from its own `submit` or `click` listener never reaches this path.
- **The last real input.** `Document.lastUserGestureTimeStamp` and
  `hasValidTransientUserGestureActivation` are chrome-only (`dom/webidl/Document.webidl:591-596`),
  and since an agent's click and fill never set activation (above), they change only on the
  user's own input.
- **Page dialogs.** A tab-modal `alert`, `confirm` or `prompt` notifies `common-dialog-loaded`,
  which WebDriver BiDi's `PromptListener` observes
  (`remote/shared/listeners/PromptListener.sys.mjs:145`, `:267-271`).

### Firefox (158.0.1): screenshots

- **`drawSnapshot`.** `WindowGlobalParent.drawSnapshot(rect, scale, backgroundColor, options)`
  renders a frame into an `ImageBitmap` in the parent process, out-of-process frames included; a
  null `rect` renders the visible viewport (`dom/chrome-webidl/WindowGlobalActors.webidl:89-102`,
  `:213-230`). WebExtensions' `tabs.captureTab` takes any tab, not only the selected one
  (`browser/components/extensions/schemas/tabs.json:1219-1238`), through `drawSnapshot` and an
  `OffscreenCanvas` encoded with `convertToBlob` as PNG or JPEG
  (`toolkit/components/extensions/parent/ext-tabs-base.js:85-160`); it refuses a browser with no
  size ("Cannot capture invisible tab", `:112-117`). Firefox's background thumbnailer captures a
  browser whose docshell is inactive (`toolkit/components/thumbnails/BackgroundPageThumbs.sys.mjs:437`,
  `:668`; `PageThumbs.sys.mjs:374`). WebDriver BiDi's screenshots use the same call
  (`remote/shared/Capture.sys.mjs:183`).
- **Background tabs keep their size.** Tab panels that are not selected are hidden only visually
  (mcp-drive, Research, "Background tabs are laid out"), so an agent tab has the content area's
  viewport. Measured by sub-PR 4's first test: `drawSnapshot` of a hidden, inactive agent tab
  (its docshell inactive, its layers not rendered) draws the page as it is at the call,
  including a change the page made after its load
  (`test_screenshot_of_a_background_tab_shows_its_page`).

### Firefox (158.0.1): console and network, read-only

- **Script errors.** `nsIConsoleService` holds `nsIScriptError` messages (uncaught exceptions,
  CSP, mixed content, network security warnings) with an `innerWindowID`, and keeps the last 250
  per process (`xpcom/base/nsConsoleService.cpp:67`). WebDriver BiDi's `ConsoleListener` reads the
  cached ones with `getMessageArray()` and new ones with `registerListener`, filtered by inner
  window, and maps `flags` to `error`, `warn` and `info`
  (`remote/shared/listeners/ConsoleListener.sys.mjs:46-140`).
- **Console calls.** `ConsoleAPIStorage` keeps up to 1,000 `console.*` calls per inner window and
  drops them when that window is destroyed (`dom/console/ConsoleAPIStorage.sys.mjs:5`, `:83-87`,
  `:109`, `:177-191`); BiDi's `ConsoleAPIListener` reads them with `getEvents(innerWindowID)`
  (`remote/shared/listeners/ConsoleAPIListener.sys.mjs:97-120`). Both listeners run in the page's
  process as WebDriver BiDi's window-global log module (`remote/webdriver-bidi/modules/windowglobal/log.sys.mjs:10-13`).
  The arguments of a console call are the page's own values.
- **Failed requests.** `http-on-stop-request` is notified for every HTTP channel after its
  `OnStopRequest`, whether it succeeded, failed or was cancelled
  (`netwerk/protocol/http/nsIHttpProtocolHandler.idl:225-231`; parent side
  `nsHttpChannel.cpp:10750-10751`). A request blocked before it opens (CSP, CORS, mixed content)
  fires `http-on-failed-opening-request` in the child only (`:118-123`) and is reported to the
  console. Vimma already observes HTTP responses of agent tabs by `loadInfo.browsingContext.top`
  (`ctl/AgentPages.sys.mjs:135-152`).
- **None of this evaluates code.** The DevTools server, the Remote Agent (WebDriver BiDi, CDP) and
  Marionette can run script in a page; the services above only report.

### MCP

- **Image content** (`modelcontextprotocol.io/specification/2025-11-25/server/tools`, "Image
  Content", checked on 2026-10-21): a tool result item of `type` `"image"` with base64 `data` and a
  `mimeType` such as `image/png`, beside text items, with optional `annotations`. `vimma-ctl mcp`
  serves 2025-11-25 and 2025-06-18 clients (`tools/vimma-ctl/src/mcp.rs:22`) and the stateless
  revision (vimma-mcp, Research, "MCP").

## Design

### A. Where it is specified

1. **A spec of its own, on top of mcp-drive.** mcp-drive built the pieces this feature needs
   (agent-tab confinement, the per-tab hint session, `in-use`) and says that #231 builds on it
   rather than adding to vimma-mcp.md (mcp-drive, "Relation to #231"). vimma-mcp and mcp-drive
   keep their decisions; this spec adds tools and does not widen `vimma_keys`' whitelist, so that
   a `vimma_keys` grant never lets an agent click or type. Screenshots and console output are
   here too, because they are how an agent sees the effect of a click or a fill; each is its own
   tool and sub-PR.

### B. Labels: `vimma_elements`

2. **What it does.** `vimma_elements { tab }` (control command `agent-elements`) asks, and on a
   yes collects the visible hint targets of that agent tab and its frames, with all kinds, under
   the tab's own key (`collectHints(browser, "hint.follow", { agent: true })` extended to every
   kind), and returns them with labels: `{ url, title, elements, dropped }`. It is read-only:
   nothing on the page is touched, so it is asked and granted like `vimma_read_page`, under its
   own tool name. Like `f`, it lists nothing on a page that is not http or https (mcp-drive D12,
   "Web pages only"), because a file, about: page or the start page moved into the agent
   workspace is not the agent's to act on; the call fails with
   `elements are listed only on http and https pages`. (Since changed: every frame of an agent's
   collection, its frames of other sites included, has up to 4 s from the start to answer, where
   the user's hint mode gives a subframe 150 ms, because an agent tab is in the background, where
   a frame's process may be busy or newly started, and an agent cannot tell that a frame was left
   out; `AGENT_FRAMES_MS` in `actors/VimmaActors.sys.mjs`.) (Since changed: `vimma_open`,
   `vimma_activate` and `vimma_fill` take `elements: true` and then return the same list of the
   page after the step, in `elements` and `dropped`, because an agent called `vimma_elements`
   after nearly every step, and each extra call is a model round trip; issue
   [#584](https://github.com/vimma-browser/vimma/issues/584). The list comes from the same
   function as `agent-elements`' own (`pageElements` in `ctl/agent-commands.mjs`), so F5 to F7
   and security.md M31 hold for it unchanged, and its labels replace the connection's as a
   `vimma_elements` list's do. `vimma_open` then waits up to 20 s for the new page to be ready
   (F11's readiness; an open that only changes the fragment is ready in its own document). A
   page still loading, one whose URL changed while it was listed, or one that cannot be listed
   returns `unlisted` with `loading`, `changed` or `failed` instead, fixed words, so that a
   page's text never takes their place; the result's URL and title are those of the last check
   that the tab is still the agent's, and a tab that left the agent workspace meanwhile fails
   the call with nothing of its page (M8). The step's question, a checkpoint's (F15,
   mcp-checkpoints C1) included, ends with `, then vimma_elements`, its `:mcp log` row the same,
   and its notice under a grant with `and listed the buttons and fields after it` (F28), because
   the yes returns the list too.)
3. **One session per tab and connection.** The labels go into the same session store as
   `vimma_keys`' `f` (`ctl/AgentDrive.sys.mjs:89-90`), bound to the document and URL and valid
   for 120 s, so a label never names an element of another page. (Since changed: an element
   list's labels have no time limit; they last while their document, URL and element do,
   because a model taking 90 s a step lost most clicks to the 120 s, and the element reference
   already binds the label (#591; security.md M25). An element the page adopts into another
   document counts as gone. `f`'s link list keeps the 120 s.)
   `vimma_elements` and `f` each replace the session. `vimma_activate` and `vimma_fill` take labels only from a
   `vimma_elements` session, because only that list showed the agent each element's kind and
   field details; `vimma_keys`' `f<label>` keeps following only link targets, as loads
   (mcp-drive D12), from either list, so that a label of a button never becomes a load. A label
   from a `vimma_elements` list that names no link is refused with
   `label "sg" is a button, not a link: f follows links only`.
4. **The child keeps the agent's elements apart.** `VimmaChild` stores the agent's collection per
   frame under its own generation, beside and never in place of the user's `#hints`
   (`actors/VimmaChild.sys.mjs:161`), so an agent's `vimma_elements` never voids the user's hint
   mode and the user's `f` never voids the agent's labels. Elements are held as `WeakRef`s, as the
   user's are; a label whose element is gone or disconnected is refused with
   `that element is gone: call vimma_elements again`, before a follow from that list as before
   a click or a fill, because the page may have replaced the element since it was listed.
5. **What is listed.** Per target: `label`; `kind` (`link`, `button`, `field`, `checkbox`,
   `radio`, `select`, `click`); `text` (its rendered text, else `aria-label`, `title` or `alt`,
   cut at 80 characters); for links the `href`; and when it is in a frame of another site, that
   frame's host. Fields add `type`, `name`, the `autocomplete` field name, the text of their
   `<label>` elements or `placeholder` (cut at 80), `required`, `disabled`, `value` (F7) and
   `sensitive` (F6); checkboxes and radios add `checked`; selects add their options (at most 50,
   each `value` and text cut at 80) and the selected one. Each target in a `<form>` names it by
   index, and the result lists the forms with `method` and `action` URL. At most 200 targets, in
   `orderTargets`' reading order, labels from `DEFAULT_HINT_CHARS` (as mcp-drive D12); the rest
   are counted in `dropped`. Only the viewport is listed, as for the user's hints, so the labels
   match what a screenshot of the tab shows; the agent scrolls with `vimma_keys` for more.
   Disabled controls are listed with `disabled`, unlike the user's hints, so that the agent can
   tell a button it must wait for from one that is missing. The whole list is one string inside
   the untrusted-content delimiters, at most 768 KiB, one JSON object a line: the forms first
   (`{"form":1,"method":"post","action":"https://example.com/api/signup"}`, at most 64), then
   the targets (`{"label":"sd","kind":"field","text":"","type":"email","name":"email",
"caption":"Email address","value":"","form":1}`), so that every page string is a JSON string
   whose quotes the page cannot end, and a target cut by the size limit never names a form that
   is not in the list. Each string is NFKC-normalised and stripped of control, bidirectional and
   invisible characters first, as `f`'s link texts are (security.md M21).
6. **Sensitive fields.** A field is sensitive when any of these holds: it `hasBeenTypePassword`
   or is `type=password`; the page draws it as dots with `-webkit-text-security`, as PIN and
   card-code widgets do without `type=password`;
   its autocomplete field name is `current-password`, `new-password`, `one-time-code` or any
   `cc-*` name; or form autofill's heuristics infer a credit-card field name for it
   (`FormAutofillHandler.collectFormFieldDetails`, which runs `FormAutofillHeuristics.getFormInfo`
   over the field's form-like group from `AutofillFormFactory.createFromField`, and
   `FormAutofillUtils.isCreditCardField` on each field name; in a group with a card field, a
   field the synchronous heuristics leave unnamed for form autofill's machine-learning model
   counts too). The heuristics count because many
   shops omit `autocomplete` on card forms, and a refused field costs the user one typed value
   while a missed card field costs much more. If the heuristics throw, every field of that group
   counts as sensitive, so that a failure refuses rather than fills. Rejected: `autocomplete`
   alone, because it misses those shops; every field inside a frame of another site, because it
   would also refuse embedded sign-up and search widgets, and hosted payment frames usually set
   `autocomplete`, which the rule above catches. The check runs in the child, in the field's own
   frame, at listing and again at filling, because a page can change a field's type or
   attributes in between; the parent counts a field whose autocomplete name is sensitive as
   sensitive whatever the child says. A sensitive field is listed, with `"sensitive": true` and
   no value (a sensitive select lists its options but not which is selected), so that the agent
   can tell the user what to type and where.
7. **Values.** A field's current value is listed, cut at 256 characters, except for sensitive
   fields, because a screenshot of the same tab shows it anyway and an agent checking its own
   fill needs it. Rejected: hiding values the user typed, because a value set by `setUserInput`
   counts as interactive too (`TextControlState.cpp:2358-2359`), so Firefox cannot tell the
   user's typing from the agent's fill.

### C. Clicking: `vimma_activate`

8. **A click is `click()`, never a synthesised mouse event.** `vimma_activate { tab, label }`
   (control command `agent-activate`) asks, and on a yes runs the user's hint activation sequence
   on that element in its frame: `mouseover`, `mousedown` and `mouseup` with the page's
   constructor (untrusted, for pages that open menus on them), then `click()` called by the
   child, which the page sees as a trusted click (`nsGenericHTMLElement.cpp:2406-2408`). Nothing
   goes through `nsIDOMWindowUtils`, `sendMouseEvent` or the widget, so the page gets no transient
   user activation: it cannot write or read the clipboard, use passkeys or credentials, or start
   anything else that needs a real gesture (Research). The element is not focused and the tab is
   not selected, so the user's focus never moves. Vimma **must never** call
   `Document.notifyUserGestureActivation()` on an agent's behalf. Rejected: synthesised input
   through `sendMouseEvent`, because it is indistinguishable from the user's own press and would
   hand the page the user's activation; untrusted `click` events only, because most pages ignore
   them and links do not follow them.
9. **What it will not click.** Refused before anything is asked, naming the label and the
   reason: a text field, text area, select or editable root (`use vimma_fill`); a file field
   (it would open a file chooser for the user, and `setUserInput` from system code can set a
   file from a path, `HTMLInputElement.cpp:2533-2546`); a disabled control; a target in a page
   that is not http or https (mcp-drive D12, "Web pages only"). Each counts when the click would
   reach it through a `<label>` too, because a click on a label clicks or focuses its control. A
   checkbox or radio is clicked, which toggles it and fires its events as a user's click does.
10. **Links.** A link whose `href` is http or https on another site (registrable domain,
    mcp-drive D18) is refused with `that link goes to another site: follow it with vimma_keys`,
    because a cross-site follow is asked as a `vimma_open` there and a click must not be a way
    around that question. A same-site link, or one whose `href` is empty, `#…` or
    `javascript:`, is clicked, because single-page apps route such clicks in script and a load of
    the href would miss that. A link with any other scheme (`mailto:`, an app's) is refused,
    because it leaves the web pages of the agent workspace. A navigation the page's own script
    starts after a click is the
    page's, as a redirect is; the result names where the tab ended up.
11. **After the click.** Vimma waits up to 20 s for a load the click started (mcp-drive D13), then
    returns `{ url, title, loading, navigated, dialog?, blocked?, stopped? }`: `navigated` when
    the top-level document changed, `dialog` when a tab-modal `alert`, `confirm` or `prompt`
    opened in the tab (`common-dialog-loaded`), with its type and text (cut at 200, untrusted),
    `blocked` the host of a submission F16 stopped, and `stopped: "in-use"` when the user started
    using the tab during the wait. A click that has started no load within a second is taken to
    have none. (Since changed: that second counts from when the click ran in the page's process,
    not from the child's reply before it, because a busy process runs the click later; the same
    holds for a fill's submission; security.md M28.) (Since changed: a click that loaded no
    page also returns `changed`, the parts of the page that changed in place within a further
    second: `element`, `elements`, `text` and `dialog`, fixed words with no page text, because an
    agent told "the page did not change" after a basket updated in place clicked again; issue
    [#510](https://github.com/vimma-browser/vimma/issues/510), security.md M26.) (Since
    changed: the fixed second and the further second are gone, because an agent's task spent
    most of its time in them; issue [#579](https://github.com/vimma-browser/vimma/issues/579).
    Once the click has run, the clicked element's frame watches its own document in its own
    process (a `MutationObserver` from just before the click, and the requests of its load group
    that the click opened) and the call goes on as soon as the page has not changed for 250 ms
    and no such request is open. A page that has not changed at all is given 1.3 s, because a
    hidden tab's page timers fire at most once a second and an update from a timer must not read
    as "nothing changed"; a page that never stops changing ends the wait after 2 s, the old worst
    case. `changed` is then read once. A page a click loads counts as ready at its
    `DOMContentLoaded` and 200 ms without a change (at most 1 s), not at its load event, and the
    result says `loading: true` while its images and other subresources still load. The same
    readiness ends a `vimma_keys` step's wait for a load and the wait before `vimma_read_page`.
    The submission allowance of F16 still ends with the call, and a second after the click ran
    when the click has started no load, as before, so a page that keeps the wait going does
    not keep it open; a submission the page makes after the call is cancelled as the page's
    own; security.md M28.)
    Agents
    cannot answer dialogs: no tool does, because a `confirm` is often the page asking "are you
    sure", which is the user's to answer. The dialog waits in the tab until the user shows it.
    Every navigation an activation causes takes a slot of the open rate (`OPEN_RATE`), shared
    with `vimma_open` and follows, so that a granted click loop cannot load pages faster than
    opens can; while that rate is used up no click is made, because a click that loads cannot be
    told from one that does not until it has run.

### D. Filling: `vimma_fill`

12. **A fill is `setUserInput`, as form autofill fills.** `vimma_fill { tab, fields, submit? }`
    (control command `agent-fill`) asks, and on a yes sets each field in its frame, in order:
    text-like inputs and text areas with `setUserInput(value)`, which dispatches `input`, and for
    an input also `change`, without focusing the field (`HTMLInputElement.cpp:2529-2569`; a text
    area gets `input` only, as when form autofill fills it, `HTMLTextAreaElement.cpp:242-247`); a
    select by option value or exact option text (never a disabled option), then the select's own
    chrome-only `userFinishedInteracting(changed)`, which dispatches trusted `input` and `change`
    as its popup does (`HTMLSelectElement.cpp:1637-1660`), rather than the untrusted events
    `FormAutofillHandler.fillFieldValue` constructs (`FormAutofillHandler.sys.mjs:1115-1133`),
    which pages that check `isTrusted` ignore; a checkbox given `true` or `false`, and a radio
    given `true`, with `click()` when its state differs. A radio given `false` is refused,
    because a click never unchecks a radio: the agent fills another of its group. Unlike
    autofill, Vimma never focuses the field first, because focus would move the page's focus
    and run its focus handlers in a tab the user may be watching. No key event is sent, so pages
    that act only on `keydown` (some autocomplete widgets) do not see the fill; the result
    `{ url, title, filled, reset?, loading, navigated, dialog?, blocked?, stopped? }` names in
    `reset` the fields whose value did not stick (the page put it back), so the agent can tell,
    and otherwise reads as after a click (F11). Each field is set after the child's reply, as a
    click is, so a dialog the page opens in its `change` handler never holds the call: the
    fields after it are not filled and the result names the dialog. (Since changed: a fill
    without `submit` returns once its last field is set and waits for no page, unless a field's
    handler started a load, which it waits for as after a click so that a submission the page
    tried is named in `blocked`; a fill with `submit` waits as after a click (F11), because
    filling fields loads nothing and the fixed second was most of the call; issue
    [#579](https://github.com/vimma-browser/vimma/issues/579).)
13. **What it never fills.** Refused before anything is asked, naming the field: sensitive fields
    (F6), file fields, hidden and disabled fields, read-only fields, editable roots
    (`contenteditable`; rich editors keep their own model, and no Firefox API sets their text as
    user input without editor commands; a later spec may add them), and a field whose value does
    not parse for its type (a `date`, `number` or `color` input rejects it). The sensitivity
    check runs again in the child just before each set, and a field that has turned sensitive
    since the question stops the call, as the yes no longer stands for it (vimma-mcp 19); the
    error says how many fields were filled before it.
14. **Limits.** At most 32 fields per call, each value at most 1,024 characters with no control
    characters except a newline in a text area, and no character that draws nothing (format,
    zero-width, bidirectional and tag characters, variation selectors, fillers), because text in
    them would pass the question unseen; checked in `vimma-ctl mcp` and again in the browser (as
    mcp-drive D15). The question shows each field's label, its name or label text and
    its value in quotes, cut to fit the line with `…`; `:mcp log` keeps the values in full
    (in memory only, mcp-drive D14), because a value is what an exfiltrating fill would carry and
    the user has to be able to check it afterwards.

### E. Submitting a form

15. **A submit always asks.** Activating a submit control (a `button` whose type is `submit` in a
    form, `input type=submit` or `type=image`), and a `vimma_fill` with `submit` (a label of a
    submit control, or `true` for the form's default button through `requestSubmit`, when every
    filled field is in that one form and its default button is not disabled), are asked
    with `always` (`ALWAYS_ASK`, `agent.mjs:125`): under any grant, with only `y` and `n`, and a
    yes makes no grant. The question names the form's method and action host in bold and the
    number of fields it sends:
    `◇ claude-code wants to submit a form: 2 "Sign up · Example" → POST example.com/api/signup (3 fields)`.
    (Since changed: the question is a checkpoint, `▲ claude-code wants to send a form: …`, and
    lists each field it sends by name and value; [mcp-checkpoints](mcp-checkpoints.md)
    Behaviour 2, 4.)
    A submission sends data to a server and is where sign-ups, messages and purchases happen,
    so one question per submission is the price of keeping them in the hands of the person at
    the keyboard; the grant for `vimma_fill` or `vimma_activate` (F25) covers only what does not
    submit. A fill that submits shows its fields after the destination, and is not sent when the
    page put back a value the question showed, because the yes was for the values shown. For the
    same reason a fill that submits is refused when its question cannot show every name and
    value whole, its submit button must belong to the filled fields' form, and the submission
    is allowed only after the last field is set: a page that submits the form from a field's
    `change` handler while it is being filled sends nothing.
16. **Submissions the agent did not ask for are stopped.** Before each agent step the parent
    consumes the page's transient user activation in every frame and marks the tab; an
    `http-on-modify-request` observer then cancels, before it is sent, the request of a
    navigating form submission there (`loadInfo.isFormSubmission`) while the tab's top document
    is the one of the step, when it carries no transient user activation
    (`loadInfo.hasValidUserGestureActivation`, from the form's document or the target frame,
    `HTMLFormElement.cpp:884-887`, `nsDocShell.cpp:10036-10039`), unless it is the submission an
    F15 question just allowed: once, within that call, to the method and destination (scheme,
    host, port and path) the question named. A redirect of a submission let through follows on,
    because the server already has it and cancelling the redirect would only invite a second
    submission. Clicks on one tab run one at a time, so that one call never takes another's
    allowance. This catches a page whose script submits after an agent's click, by `submit()`
    or `requestSubmit()`, from any frame, whatever element was clicked, and a submission the
    page moved elsewhere in its `submit` listener. The result says
    `the page tried to submit a form to <host>; Vimma stopped it: activate its submit button`,
    so the agent can ask properly. A form the user submits themselves (with activation they gave
    after the step, or through their hints, which end the mark), or a page that submits with no
    agent step in it, is untouched, because the agent did not cause it. A page the agent's click
    loaded is a new document, unmarked: its own submissions are the page's, as its redirects
    are. Rejected: the chrome-only `DOMFormBeforeSubmit` in the child, because Firefox caches its
    verdict for the form (`mNotifiedObservers`, `HTMLFormElement.cpp:286-289`, `:837-838`), so a
    page that once prevented a submission could later `submit()` without it, and because it
    fires before the page's `submit` listener can change the destination; setting
    `SANDBOXED_FORMS` on agent tabs, because it would stop the user's own logins and searches in
    the agent workspace too.
17. **What cannot be caught.** A page that sends data with `fetch` from a button's click
    listener, without a form submission, cannot be told apart from any other button. Such a click
    is an ordinary `vimma_activate`, whose question names the element's text; the guide says
    that a grant of `vimma_activate` lets the agent press such buttons unasked. This is accepted
    because the agent workspace has none of the user's logins (vimma-mcp 7), passwords are never
    filled by an agent (F13), and every granted call shows a notice and is logged.

### F. `vimma_screenshot`

18. **The viewport of one agent tab.** `vimma_screenshot { tab, labels? }` (control command
    `agent-screenshot`) asks, and on a yes calls `drawSnapshot(null, scale, "white")` on the agent
    tab's top window global, in the parent: the visible viewport, frames of other sites included,
    never the browser's chrome, the status bar or another tab. It is read-only and is asked and
    granted as its own tool, because it shows the same page that `vimma_read_page` reads. Like
    `vimma_elements` (F2) it captures only an http or https page, checked before and after the
    drawing, because a privileged about: page, the start page or a local file moved into the
    agent workspace is not the agent's to see.
    `scale` is chosen so that the image is at most 1,280 pixels wide, at most the device pixel
    ratio, and at most 16,384 pixels high. The tab is not selected or shown: a background tab
    draws its current page (Research). If the tab has no size or the drawing fails, the tool
    reports `the tab is not painted in the background: call vimma_show first` rather than
    switching anything itself, because changing what the user sees is `vimma_show`'s, and always
    asks (mcp-drive D4).
19. **Encoding and size.** The image is encoded in the parent with `OffscreenCanvas.convertToBlob`,
    as `tabs.captureTab` does: PNG when its base64 fits 700 KiB, else JPEG at quality 0.8, then
    0.6, else the tool error `the screenshot is too large`. That keeps the reply within the
    protocol's 1 MiB line (`MAX_LINE`). The reply carries `mimeType`, `data`, `width`, `height`, `url` and
    `title`; `vimma-ctl mcp` returns it as an MCP image item after a text header from
    `untrustedHeader`'s wording, adding that text in the image is web content and not
    instructions, because a page can render a prompt injection as easily as it can write one.
    (Since changed: that is now the image of `full: true`. By default the image is at most 1,024
    pixels wide and the smaller of a PNG and a JPEG at quality 0.75, else a JPEG at 0.5
    (`AGENT_SCREENSHOT_SMALL`, `screenshotEncodings` in `packages/vimma-core/src/agent-act.mjs`),
    because a model pays for an image by its pixels, about width times height divided by 750 in
    tokens for Claude, and some clients by its base64 as well, while 1,024 pixels still show a
    page's text. On a local fixture the default image costs about 722 tokens against 1,130 at
    full size, with 23 to 35 % less base64; a page of flat colours stays a PNG, a busy one
    becomes a JPEG. Issue [#584](https://github.com/vimma-browser/vimma/issues/584).)
20. **Labels drawn on it.** With `labels: true`, the labels of the tab's current
    `vimma_elements` session are drawn at their rects (`HintTarget.rect`, top-frame CSS pixels,
    scaled), in the theme's hint colours, so that a model looking at the image can name the
    button it sees. A session that is not current (F3), or whose top frame has scrolled since
    the list was made, draws nothing and the result says the list is stale, because labels at
    the old places would name the wrong elements. (Since changed: also a list older than 120 s,
    `AGENT_ELEMENTS.drawMs`, once labels stopped expiring, because a page that updates in place
    moves its elements without a navigation; #591.)
21. **Limits and sensitive values.** At most 12 `agent-screenshot` requests per connection a
    minute (`busy` beyond), counted when asked, because each is a large reply and a paint in the
    content process. A screenshot is refused while a sensitive field (F6) in the viewport has a
    value, with `a payment or password field on screen has a value; Vimma does not capture it`,
    because a card number the user typed into an agent tab shows on screen in clear (only
    `type=password` is masked) and the list keeps such values from the agent too; the check runs
    in each frame's child just before and again just after the snapshot, over every form control
    of the document and its shadow trees whose box meets that frame's viewport, a number
    field's unparsed text and an autofill preview counting as values, a select counting when its
    choice differs from the page's default; a scroll of the top frame between the checks
    discards the image, and the agent's own `vimma_keys`, `vimma_activate` and `vimma_fill` on
    that tab are `in-use` from the first check to the second, while a screenshot is refused
    while one of them runs, because the agent could otherwise scroll a filled field into view
    and back between the checks. A frame that
    fails counts as showing such a value; one that has no Vimma actor (a data: or blob:
    document) or does not answer in 5 s refuses with
    `Vimma could not check every frame of this page for payment fields`, so that a doubt
    refuses and says why. It costs nothing on pages without such
    values, and the agent can scroll past the field or ask the user. Rejected: capturing what
    the tab shows, because it would break F6's promise for images; asking every screenshot with
    no grant, because questions asked that often stop being read.

### G. `vimma_console`

22. **What it returns.** `vimma_console { tab, since? }` (control command `agent-console`) asks,
    and on a yes returns the agent tab's current page's `errors` and the tab's `requests`, with
    `time`, Vimma's clock when it read them. Like `vimma_elements` (F2) it reads only an http or
    https page, refused before anything is asked, because a privileged about: page, the start
    page or a local file moved into the agent workspace is not the agent's to read:
    - `errors`: script errors from `nsIScriptError` (uncaught exceptions, CSP and mixed-content
      reports, network security warnings) at error and warning level, read in each frame's
      process and in the parent by the frame's inner window id, as BiDi's `ConsoleListener` does;
      and the page's own `console.error` and `console.warn` calls from `ConsoleAPIStorage`,
      because web apps report most of their own failures with `console.error`, which an agent
      testing one needs, while `log`, `info` and `debug` are mostly noise that fills the reply
      (every level is equally untrusted). Each entry has its level, source (`script`, `csp`, `network`,
      `console`, …), message (cut at 1,000), file, line and column, and time.
    - `requests`: failed requests of the tab, recorded by an `http-on-stop-request` observer in
      the parent for channels whose top browsing context is an agent tab: HTTP status 400 and
      above, or a failed channel status (by its error name, such as `NS_ERROR_UNKNOWN_HOST`).
      Each has its method, URL (cut at 512, without a user name or password), status or error,
      resource type and time. Requests cancelled by a navigation (`NS_BINDING_ABORTED`), the
      first leg of a redirect (`NS_BINDING_REDIRECTED`) and a load handed to a download
      (`NS_BINDING_RETARGETED`) are left out, because none of them failed. The log is the tab's,
      not only its current page's, because a top-level load that fails (an unknown host, a
      refused connection) leaves an error page whose document is newer than the failure the
      agent needs to see.
      `since` (ms since the epoch) returns only newer entries, so an agent can check what a click
      caused; the `time` of a result is the `since` of the next (an entry logged while a read
      was being made may come again in the next).
23. **Read-only by construction.** It runs no code in the page. It never starts the DevTools
    server, the Remote Agent or Marionette, never evaluates an expression and never calls a page
    function, because each of those could run script with the browser's privileges or the
    page's. A `console` call's arguments are copied only when they are strings, numbers,
    booleans or null; any other argument becomes its `typeof` (`[object]`, `[function]`), so a
    page's getter or `toString` never runs in Vimma's code.
24. **Kept small and per page.** Script errors come from the services' own caches (250 per
    process, 1,000 console calls per window), so nothing is collected while no agent asks. The
    request log holds the last 100 failed requests per agent tab, in memory, cleared when the tab
    closes, leaves the agent workspace or `:mcp off` runs. A reply holds at most 100 errors and
    100 requests, newest first, inside the untrusted-content delimiters, at most 512 KiB; the rest
    are counted in `dropped`. Each frame's child answers only its newest 100 entries after
    `since`, its strings already cut, and counts the rest, and at most 100 frames are asked,
    because a page that logs without end must not make the parent copy and sort all of it. URLs
    and messages are untrusted text and can carry tokens a page put there; they come only from
    the agent's own tab, and a URL's user name and password are removed.

### H. Gate, grants and audit

25. **Tools and grants.** `AGENT_TOOLS` gains `agent-elements: vimma_elements`,
    `agent-activate: vimma_activate`, `agent-fill: vimma_fill`,
    `agent-screenshot: vimma_screenshot` and `agent-console: vimma_console`. Each is granted per
    connection and tool (vimma-mcp 20-22), and no grant of one covers another, so that a
    screenshot grant never lets an agent click. Submissions ask under any grant (F15). All five
    are grantable for N minutes like the other tools, `vimma_activate` and `vimma_fill`
    included, because the riskiest steps ask or are refused without any grant (submissions F15,
    secrets F6 and F13, uploads F9, cross-site links F10), the agent workspace has none of the
    user's logins (vimma-mcp 7), and questions asked too often stop being read. Under a
    `vimma_activate` grant a script-only button that sends data runs unasked, with a notice and
    a log row (F17, F28). Rejected: `vimma_activate` asking every time, because a task with ten
    clicks would ask ten times and invite answering by reflex; neither tool grantable, for the
    same reason. (Since changed: one grant now covers every agent tool of its connection; [mcp-grants](mcp-grants.md) G1.)
26. **Rates.** `vimma_activate` and `vimma_fill` share one rate of 30 requests per connection a
    minute, `vimma_elements` and `vimma_console` 30 each, `vimma_screenshot` 12 (F21), all
    counted when asked, with `busy` beyond, as mcp-drive D15's rate is, so that a refused call
    cannot loop and a grant cannot flood a page; navigations count in the open rate (F11).
    (Since changed: a step asked with `elements` (F2) also takes a slot of `vimma_elements`'
    rate when asked, and is `busy` before anything of it runs when those are used up, so that
    returning the list with a step is no way past the rate; issue
    [#584](https://github.com/vimma-browser/vimma/issues/584).)
27. **The tab must be the agent's and not in use.** Before the question, after the yes and before
    each field or click, the tab must pass `isAgentTab` (vimma-mcp 19, mcp-drive D13), else the
    call stops with `changed`. A tab the user is using (`VimmaHost.inUse`) denies
    `vimma_activate` and `vimma_fill` with `in-use`, and a call already running stops there,
    because a click or a fill under the user's cursor would take their page out of their hands.
    The read-only tools run while the user uses the tab, since they change nothing.
28. **Questions, notices and log.** Each question shows the tab's title and URL and what the call
    does: the element's kind and text for an activation, each field and value for a fill (F14),
    the destination for a submit (F15). Under a grant each call shows a notice naming the tab and
    what was done, and `:mcp log` records every call, asked, granted or denied, with the fields
    and values of fills, the element of activations and the destination of submits
    (mcp-drive D14, M23), because grants run calls unasked and notices last seconds.

### I. MCP and protocol

29. **Protocol 2 additions.** `agent-elements`, `agent-activate`, `agent-fill`, `agent-screenshot`
    and `agent-console` join `AGENT_COMMANDS` with fixtures in `tests/contract/control/v2/` (one
    valid and one invalid request and response each). The `full` role's reserved `screenshot`
    stays reserved and unbuilt. A Vimma without the commands answers `unknown-command`, which
    `vimma-ctl mcp` words as "update Vimma" (vimma-mcp 39), so a new `vimma-ctl` works against an
    older Vimma.
30. **The tools.** Added to `tools/vimma-ctl/src/mcp.rs` and its fixture, with all four hints:

    | Tool               | Annotations                                            | Maps to            |
    | ------------------ | ------------------------------------------------------ | ------------------ |
    | `vimma_elements`   | read-only, idempotent, open-world                      | `agent-elements`   |
    | `vimma_activate`   | not read-only, destructive, not idempotent, open-world | `agent-activate`   |
    | `vimma_fill`       | not read-only, destructive, not idempotent, open-world | `agent-fill`       |
    | `vimma_screenshot` | read-only, idempotent, open-world                      | `agent-screenshot` |
    | `vimma_console`    | read-only, idempotent, open-world                      | `agent-console`    |

    `vimma_activate` and `vimma_fill` are marked destructive because a click or a submission can
    change data on a server, and MCP clients use the hint to decide what to confirm. Each
    description says which fields are never filled, that submits always ask, and that labels
    come from `vimma_elements`.

31. **The server's instructions** gain one sentence in the sub-PR that adds each tool: to act on a
    page, call `vimma_elements`, then `vimma_activate` or `vimma_fill`; ask the user to type
    passwords and payment details themselves; use `vimma_screenshot` and `vimma_console` to see
    the result, so that the model's route of least effort stays inside the agent workspace and
    never asks the user for full control.

## Security and privacy

### Threat model (additions to vimma-mcp's and mcp-drive's)

| Threat                                                                                             | What stops it                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A prompt-injected page makes the agent type a secret into it**, or into a field it then submits. | Password, one-time-code and card fields are never filled (F6, F13); every submission asks, with its destination (F15); every fill's values are shown in the question or logged under a grant (F14). The agent workspace has none of the user's logins or saved passwords (vimma-mcp 7). |
| **A page steals the user's activation** from an agent's click: clipboard, passkeys, permissions.   | A click is `click()`, never synthesised input, so the page gets no transient activation (F8). Permission prompts and pop-ups are already refused in agent tabs (vimma-mcp 30).                                                                                                          |
| **A click starts a purchase or sends a message.**                                                  | Form submissions ask every time and unasked ones are cancelled (F15, F16). A script-only button is an ordinary activation, shown in its question or notice and logged (F17); under a `vimma_activate` grant it runs unasked, with a notice and a log row (F25).                         |
| **A local file is uploaded.**                                                                      | File fields are never filled or clicked (F9, F13).                                                                                                                                                                                                                                      |
| **A click is a way around the cross-site question.**                                               | Links to another site are refused in `vimma_activate` and asked as `vimma_open` through `vimma_keys` (F10). Navigations a click causes count in the open rate (F11).                                                                                                                    |
| **A label names a different element than the agent saw.**                                          | Labels are bound to the document and their element must still be connected (F3, F4). (Since changed: the 120 s expiry was dropped for element lists, #591.)                                                                                                                             |
| **The agent acts under the user's cursor.**                                                        | `in-use` (F27). Nothing is focused or selected (F8, F12).                                                                                                                                                                                                                               |
| **A screenshot or console entry carries instructions**, or a token a page logged.                  | Both are labelled untrusted (F19, F24); they reach only the agent's own tab. Console reading runs no page code (F23).                                                                                                                                                                   |
| **A screenshot shows a card number the user typed** in an agent tab.                               | A screenshot is refused while a sensitive field on screen has a value (F21).                                                                                                                                                                                                            |
| **Flooding.**                                                                                      | Rates per tool (F21, F26) and the open rate for navigations (F11).                                                                                                                                                                                                                      |

### docs/security.md (§12, rules added by the sub-PR that builds each)

Each rule enters `docs/security.md` with links to its tests in the sub-PR that implements it,
because the page links every rule to a test that exists. Until then §12 names this spec as
planned.

- **M25.** `agent-elements`, `agent-activate`, `agent-fill`, `agent-screenshot` and
  `agent-console` **must** act only on an agent tab (M2), in the background: they **never**
  select, show or focus the tab or an element in it.
- **M26.** An agent's click **must** be `click()` from the child, with no event through
  `nsIDOMWindowUtils` or the widget, and Vimma **never** gives an agent tab's document user
  activation.
- **M27.** `agent-fill` **must never** set a sensitive field (F6), a file field or an editable
  root, and checks sensitivity again just before each set.
- **M28.** A form submission caused by an agent **must** ask every time with its method and
  destination, under any grant; a navigating submission in an agent tab that follows an agent's
  step, without the user's input since and without that question, **must** be cancelled.
- **M29.** `agent-activate` **must** refuse a link to another site (F10).
- **M30.** `agent-console` **must not** evaluate code, start the DevTools server, the Remote Agent
  or Marionette, or read a page object's properties.
- **M31.** Element lists, screenshots and console output **must** be labelled untrusted and capped
  (F5, F19, F24).
- **M32.** The rates of F21 and F26 **must** deny with `busy`; every call **must** be in
  `:mcp log`, a fill with its values.

## Tests

Written first and seen to fail, by layer. Each names the rule it holds.

### Vitest (`packages/vimma-core`)

- `agent-act.test.mjs`: fill arguments over the limits (33 fields, a 1,025-character value, a
  control character) are `invalid-args` (F14); the sensitive autocomplete names are sensitive
  (`current-password`, `new-password`, `one-time-code`, `cc-number`, `cc-csc`, `cc-exp`) and
  `email` is not (F6); a submit control is a submit (F15); the element list format and its caps
  (F5).
- `agent-gate.test.mjs`: a submit asks under a grant and makes none (M28); the new rates (M32).
- `agent-prompt.test.mjs`: the question lines of the five tools and of a submit, values cut with
  `…`, the submit question offering no grant.
- `control-v2.test.mjs` and fixtures: the five commands.

### Rust (`tools/vimma-ctl`, `cargo test`)

- `src/mcp.rs`: `tools/list` equals the fixture with the five tools and their hints; arguments
  over the limits are tool errors that never reach Vimma; a screenshot result is an image item
  after the untrusted header; the instructions name the tools.
- `tests/mcp_props.rs`: any arguments of the five tools become a checked command or a tool error.

### Mochitests (`tests/browser/`)

- `browser_vimma_mcp_elements.js`: `test_elements_lists_kinds_fields_and_forms`;
  `test_password_and_card_fields_are_sensitive_without_values` (including a field switched from
  `password` to `text`, and a card form without `autocomplete`; M31);
  `test_agent_labels_leave_the_users_hint_mode_alone` (F4);
  `test_f_follows_only_links_from_an_elements_list` (F3);
  `test_labels_of_a_gone_element_are_refused` (F4, through a follow from the list);
  `test_elements_only_on_web_pages_and_agent_tabs` (F2, M25);
  `test_elements_under_a_grant_notice_log_and_rate` (F26, F28; M32).
- `browser_vimma_mcp_activate.js`: `test_activate_clicks_a_button_in_a_background_tab` (the
  window's tab, focus and mode unchanged; M25);
  `test_activate_gives_the_page_no_user_activation` (a `navigator.clipboard.writeText` in the
  click handler rejects, `hasValidTransientUserGestureActivation` stays false; M26);
  `test_activate_refuses_a_cross_site_link` (M29); `test_activate_reports_a_dialog`;
  `test_activate_in_use_while_the_user_types`.
- `browser_vimma_mcp_fill.js`: `test_fill_sets_values_and_fires_input_and_change`;
  `test_fill_never_focuses_the_field`; `test_fill_refuses_password_card_otp_and_file_fields`
  (M27); `test_fill_stops_when_a_field_turns_sensitive`.
- `browser_vimma_mcp_submit.js`: `test_submit_asks_under_a_grant` (M28);
  `test_page_script_submit_after_a_click_is_cancelled` (M28);
  `test_users_own_submit_in_an_agent_tab_goes_through`.
- `browser_vimma_mcp_screenshot.js`: `test_screenshot_of_a_background_tab_shows_its_page` (the
  measurement of F18, written first); `test_screenshot_fits_the_reply_line`;
  `test_screenshot_draws_labels`.
- `browser_vimma_mcp_console.js`: `test_console_returns_uncaught_errors_and_console_errors`;
  `test_console_returns_failed_requests_with_status`;
  `test_console_runs_no_page_code` (an argument with a throwing getter and `toString` is copied
  as its type; M30).
- `browser_vimma_security_invariants.js`: the agent role never reaches `sendMouseEvent`, a file
  field or `notifyUserGestureActivation` (M26, M27).

### e2e (`tools/e2e`, under Xvfb)

- `m0-mcp-forms`: the real `vimma-ctl mcp` over stdio against a local fixture form:
  `vimma_elements`, `vimma_fill`, the submit question and its `y`, `vimma_console` after a
  failing request, and `vimma_screenshot` with labels. Screenshots `m0-mcp-forms-fill-question`
  and `m0-mcp-forms-submit-question`, baselines from CI's runner. They use the harness's
  built-in theme, as every e2e baseline does: the harness pins it so that a machine's Omarchy
  theme cannot change a baseline.

## Docs and changelog

- `docs/guide.md`, the agents section: the five tools, what is never filled and why, that submits
  always ask, what a grant of `vimma_activate` allows, that agents cannot answer dialogs, and that
  screenshots and console output are untrusted.
- `README.md` feature list: agents can click and fill forms in the agent workspace, never
  passwords or payment details.
- `docs/security.md` §12: M25-M32 as each sub-PR lands.
- `CHANGELOG.md`: one Added line per sub-PR; each new e2e baseline named in its line.

## Delivery

One sub-PR at a time, each with its own security review by a fresh agent, as mcp-drive's had.
Issue [#231](https://github.com/vimma-browser/vimma/issues/231) tracks them, and the status line
names the sub-PRs built.

| #   | PR                                                                          | Contents                                                                                                                                             |
| --- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `feat(mcp): vimma_elements lists a page's buttons and fields by hint label` | F2-F7: every kind in the agent collection, the child's agent store, sensitivity, the tool, protocol and fixture; M25, M31, the elements rate of M32. |
| 2   | `feat(mcp): vimma_activate clicks by hint label`                            | F8-F11, F15-F17 for clicks: the click, refusals, links, dialogs, the submit question and the `DOMFormBeforeSubmit` guard; M26, M28, M29.             |
| 3   | `feat(mcp): vimma_fill fills fields, never passwords or payment fields`     | F12-F14 and `submit`; M27.                                                                                                                           |
| 4   | `feat(mcp): vimma_screenshot shows an agent tab`                            | F18-F21, starting with the background-tab measurement; the MCP image item.                                                                           |
| 5   | `feat(mcp): vimma_console reads a page's errors and failed requests`        | F22-F24; M30.                                                                                                                                        |
| 6   | `docs(guide): act on pages in the agent workspace`                          | The guide's section, README line and the `m0-mcp-forms` e2e scenario with its baselines, if not already written by sub-PRs 1-5.                      |

Out of scope: typing key by key and pages' own keyboard shortcuts (keys never reach the page,
mcp-drive D8); rich-text editors (F13); answering page dialogs (F11); drag and drop; uploads;
full-page screenshots; reading network bodies or headers; several agent workspaces; macOS (the
question line follows the macOS spec).

## Open questions

None. Grants of `vimma_activate` and `vimma_fill` (F25), which fields count as payment fields
(F6), sensitive values in screenshots (F21) and the console levels returned (F22) are decided.
