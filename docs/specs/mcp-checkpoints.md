# Spec: mcp-checkpoints

Status: accepted · Area: `packages/vimma-core/src/` (`agent-prompt.mjs`, `agent-act.mjs`, new
`agent-checkpoint.mjs`); `src/browser/base/content/vimma/` (`ctl/agent-commands.mjs`,
`ctl/AgentAct.sys.mjs`, `actors/VimmaActors.sys.mjs`, `actors/VimmaChild.sys.mjs`,
`actors/agent-fields.mjs`, `ui/agent-prompt.mjs`, `host/agent-ui.mjs`); `tools/vimma-ctl`
(`src/mcp.rs`) · Upstream patches: none · ADR: [ADR-019](../adr/019-agents-over-mcp.md)
(unchanged). No new dependency.

Issue: [#508](https://github.com/vimma-browser/vimma/issues/508)

Builds on [mcp-grants](mcp-grants.md) (one grant covers every agent tool of a connection) and
[mcp-forms](mcp-forms.md) (clicks, fills, the form-submission question F15 and the submission
guard F16). Decisions of those specs are written "mcp-grants G2" and "mcp-forms F15"; this
spec's own are "C1", "C2", and so on. Engine paths are relative to `engine/` (Firefox 158.0.1,
`config/milestone.txt`). Vimma paths are under `src/browser/base/content/vimma/` unless they
start with `packages/`, `tools/` or `tests/`; line numbers are at commit `df1c20c7`.

## Summary

Under a grant, an agent works without questions, except at two checkpoints: before it sends a
form and before it pays. A checkpoint is one question that shows what will happen (where a form
goes and what it sends; what is bought, on which site, and the total if the page states one),
answered with `y` or `n`, after which the agent goes on under the same grant. Paying is
recognised from what the page holds (payment card fields) and what the button says, so that a
button that does not submit a form cannot pay unasked when either signal is there.

## Problem

- **Paying is not recognised.** Today a purchase asks only when it is a form submission
  (mcp-forms F15). On a grocery shop (Research), the "add to basket" buttons were `type=submit`
  buttons outside any `<form>`, so they were ordinary clicks and ran under a grant, which is
  right for a basket. A checkout's "confirm order" button built the same way, or one that calls
  `fetch` from a click listener (mcp-forms F17), would also run unasked. With one grant covering
  every tool (mcp-grants G1), any grant the user gives would let that click through.
- **The form question shows too little.** A submission's question names the method, the
  destination's host and the number of fields (`→ POST example.com/api/signup (3 fields)`), not
  the values that go. The user is asked to judge a submission without seeing what it sends,
  unless the agent filled the fields in the same call (mcp-forms F14).

## Behaviour

1. **Checkpoints ask under any grant.** A payment step (item 3) and a form submission ask with
   `y` and `n` only, also under a grant, and a yes never makes a grant and never ends one: the
   agent goes on under the grant it had. Asked without a grant, they ask the same way.
2. **They stand out.** A checkpoint's line starts with `▲` instead of `◇` and uses the theme's
   warning colour (`--vimma-text-yellow`) for its glyph and verb, so that among the rare
   questions of a granted task it is not mistaken for a routine one. The hint is
   `y send it · n stop` for a form and `y pay · n stop` for a payment; `Esc`, `Enter`, `n` and `x`
   stop. The arming delay (1 s) and every guard of the question line apply (vimma-mcp 13-14).
3. **A payment step** is a click (`vimma_activate`), a fill that submits, or a key that acts
   (a follow, `gu`, `gU`, `H` or `L`; `vimma_keys` sends no key events, mcp-drive D8-D9) in an agent tab, when a signal of C6 says it may pay. Its question names the agent, the
   button's text, the site, and the amount the page states (C7):
   `▲ claude-code wants to pay: "Confirm order" on shop.example · the page says "Total 42,90 €"`.
4. **A form submission's question shows what is sent:** the destination, then each field that
   goes, by name and value, as a fill's question shows them (mcp-forms F14): values cut at 40
   columns, the list cut where the line ends with `… (N more)`; a sensitive field (password,
   card, one-time code: mcp-forms F6) as its name and `•••`, never its value:
   `▲ claude-code wants to send a form: 2 "Sign up · Example" → POST example.com/api/signup  email "a@example.com", name "Ada", password •••`.
   Hidden fields (`type=hidden`, such as anti-forgery tokens) are not listed but counted
   (`+ 2 hidden`), because their values mean nothing to the user and would crowd out the ones
   that do. Every name and value is cleaned as a fill's question cleans them (NFKC, control,
   bidirectional and invisible characters dropped, each a bidi isolate), since they are the
   page's text. When the submission is also a payment step, the payment wording wins and the
   fields follow.
5. **A stop is final for that step.** `n` refuses the call with `denied`; under a grant the
   agent may go on with other steps, and three noes in a row mute it as any denials do
   (vimma-mcp 18).
6. **Notices and log.** A yes shows `sent the form to example.com` or `paid on shop.example`, and
   `:mcp log` records the step with outcome `allowed (checkpoint)` or `denied (checkpoint)`.
7. **The desktop notification** (vimma-mcp 15) says `claude-code asks to pay` or
   `claude-code asks to send a form`, with no site, amount or URL, since notifications show on
   lock screens and in screen shares.
8. **The guide and the grant's wording say it.** Once this is built, the question's hint
   (mcp-grants G3) becomes
   `y once · 10a 10 min, all but forms and paying · n deny · x mute`,
   and the grant's notice ends `…; sending a form or paying still asks (ctrl+b shift+a ends it)`.

## Research

### Firefox (158.0.1)

- **Payment card fields.** Form autofill recognises card fields by their `autocomplete` names
  (`cc-number`, `cc-exp`, `cc-csc` and the rest) and by its heuristics:
  `FormAutofillHeuristics.getFormInfo(formLike, false)`
  (`toolkit/components/formautofill/shared/FormAutofillHeuristics.sys.mjs:1158`) gives each
  field's inferred name, and `FormAutofillUtils.isCreditCardField(name)`
  (`toolkit/components/formautofill/shared/FormAutofillUtils.sys.mjs:173`) says whether it is a
  card field. Vimma already uses both to mark card fields sensitive
  (`actors/agent-fields.mjs:148-154`, mcp-forms F6).
- **Card fields in other sites' frames.** Payment providers often draw the card fields in a
  frame of their own site inside the shop's page. Vimma's child actor runs in every frame
  (`actors/VimmaActors.sys.mjs:229-232`, `allFrames: true`, on http, https and a few local pages), so each frame's
  child can report its own card fields to the parent.
- **The Payment Request API is off.** `dom.payments.request.enabled` defaults to `false`
  (`modules/libpref/init/StaticPrefList.yaml:4183`), so `PaymentRequest` does not exist in
  Firefox pages and is no signal.
- **Cross-site navigations.** The parent already watches every request of an agent tab during a
  step (`http-on-modify-request`, `actors/VimmaActors.sys.mjs:559`) to stop unasked form
  submissions (mcp-forms F16), and computes a URI's site (registrable domain) for links
  (`ctl/AgentAct.sys.mjs:77`, mcp-forms F10). A top-level load to another site, started by a
  step, can be cancelled there before it is sent, the same way.

### Shops

One shop was checked through `vimma-ctl mcp` and Vimma's agent workspace: S-kaupat
(`www.s-kaupat.fi`), a Finnish grocery shop, up to its basket. Its basket buttons are
`type=submit` buttons outside any form. Its checkout was not completed, and no survey of shops
was made. The checkout designs this spec plans for are the three common ones: card fields,
often in a payment provider's frame; a load of a payment provider's or bank's own site (a hosted
payment page); and, with a saved card, one button. C6 covers the first and the third directly,
and the second at the provider's own card fields or pay button.

## Design

1. **Checkpoints are per step, not per grant** (C1), because sending a form and paying cannot be
   taken back, and the user's judgement of a task does not cover a step whose content they have
   not seen. The grant stays in force after a checkpoint (Behaviour 1), because stopping the
   whole task to protect one step would make the user re-grant after every purchase or
   submission and bring back the fatigue mcp-grants removes.
2. **A checkpoint shows the content of the step** (C2), because a yes is only as good as what
   the user saw: a form's values and destination, a payment's site and amount. A form's sensitive
   values are never shown (they are not the agent's to read, mcp-forms F6), only that they go.
3. **A checkpoint looks different from a question** (C3), because questions under a grant are
   rare and mostly routine (a show, a download); the one that spends money or sends data has to
   be recognisable at a glance. The glyph carries it without colour (m7-a11y); `▲` is used
   nowhere else in Vimma's chrome, so it means one thing.
4. **`n` stops only the step** (C4), because the user who refuses one payment usually wants the
   agent to report back, not to lose its grant; ending the grant is one key away
   (mcp-grants G4).
5. **Paying is recognised by several signals, any of which asks** (C5), because a wrong question
   costs one key and a missed payment costs money, and each signal alone misses a common
   checkout (Research, Shops). Rejected: the Payment Request API, which Firefox does not enable;
   asking the agent whether a step pays, because the agent is the party being checked.
6. **The signals are card fields and the button's words** (C6). A step is a payment step when
   the tab's page, in any frame (payment providers' cross-site frames included), holds a payment
   card field (an `autocomplete` `cc-*` name or form autofill's card heuristics), or when the
   control the step acts on has a pay phrase in its text, accessible name or value: a fixed list
   in English, Finnish, Swedish, German, French and Spanish (`pay`, `buy now`, `place order`,
   `confirm order`, `complete purchase`, `maksa`, `osta`, `tilaa`, `vahvista tilaus`, `betala`,
   `köp`, `jetzt kaufen`, `zahlungspflichtig bestellen`, `payer`, `commander`, `pagar`,
   `comprar`, …), matched as whole words, case-insensitively, after NFKC. Card fields catch a
   checkout where a card is typed, and the button's words catch a saved card's one-button
   checkout, which card fields never see because the agent cannot fill them (mcp-forms F6). The
   cost is an extra question on a button such as "Buy now" that only leads to a checkout.
   Rejected: card fields alone, because they miss the one-button checkout, the case with the
   most risk; a cancel-and-ask rule for a load of another site from a checkout page (a hosted
   payment page or a bank), because shops, logins and payment providers move between sites all
   through a purchase, so the rule would ask often where nothing is paid, and cancelling a load
   that a same-site POST started and then repeating the step could place an order twice, while
   a hosted payment page still holds card fields or a pay button of its own, where the
   checkpoint stops the agent; `[mcp] pay_words` and `[mcp] pay_sites` in config.toml, because
   a fixed list keeps the rule the same for every user and the config surface small, and a
   missed phrase is better added to the list for everyone.
7. **The question quotes the total the page states** (C7). The amount is the text of the nearest
   element, in reading order before the control, that holds a currency amount and a total word
   (`total`, `yhteensä`, `summa`, `totalt`, `gesamt`, `importe`, …), cleaned as page text,
   quoted after "the page says", cut at 40 columns, and left out when none is found. The amount
   is what the user most needs to judge a payment, and quoting it as the page's claim keeps it
   honest, since the page chooses it. Rejected: the button and site only, because the user would
   have to look at the page to judge the step; the basket's lines too, because they do not fit
   one line and are better read on the page through `vimma_show`.

## Security and privacy

The checkpoints add no surface: they only add questions. What they read is the page's own
markup in agent tabs (card fields, a button's text, text near an amount), all of which
`vimma_elements` and `vimma_read_page` already read there; nothing is sent to the agent that it
could not already get, and a card field's value is never read (mcp-forms F6).

Threats and what stops them (additions to mcp-grants' and mcp-forms'):

| Threat                                                                                                                                   | Mitigation                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A prompt-injected or mistaken agent buys under a grant.**                                                                              | A payment step asks under any grant (C1, C5), showing the site and the stated amount (C2).                                                                                                                                                                                        |
| **A shop's page hides its payment step** (no card fields, a neutral button, same site).                                                  | Not stopped when no signal matches. The shop is the party that charges, so a shop that hides its checkout from Vimma could equally charge without one; the threat this guards against is the agent, not the shop. The guide says what is recognised.                              |
| **A page states a false amount.**                                                                                                        | The question says "the page says" and quotes it; the user's bank or card statement is the authority, and the guide says so.                                                                                                                                                       |
| **A hosted payment page reached without a signal**: a button whose text is not on the list leads to a payment provider's or bank's site. | The load itself is not stopped (C6 rejects a rule for loads of another site). The checkpoint stops the agent on that site instead, at its card fields or its pay button; a provider page that shows neither, such as a bank's confirm button worded otherwise, is not recognised. |
| **A page floods checkpoints** to train `y`.                                                                                              | Each is an agent's call, so the agent's rates and the mute (vimma-mcp 18) bound them; a page cannot ask by itself.                                                                                                                                                                |

`docs/security.md` gains a rule in §12 (next free M number): a payment step, by the signals of
C6, **must** ask under any grant with only `y` and `n`, and its yes **never** makes or ends a
grant; the rule says what it does not cover: a load of another site is not stopped, so a hosted
payment page reached by a button whose text is not on the list stops the agent only at that
page's own card fields or pay button. M28 gains that the question shows each field's name and
value, never a sensitive field's value.

## Tests

### Vitest (`packages/vimma-core`)

- `agent-checkpoint.test.mjs`: card fields alone, and a pay phrase alone, make a payment step;
  neither makes none; the button phrase list matches whole words in each listed language and not inside
  other words; the amount found near a total word, or none.
- `agent-prompt.test.mjs`: `a payment checkpoint names the button, site and stated amount`;
  `a form checkpoint lists the fields it sends, sensitive ones as •••`; `a checkpoint offers y
and n only, and x is a plain no`; the new grant hint and notice.
- `agent-gate.test.mjs`: `a checkpoint asks under a grant, its yes leaves the grant as it was`.

### Mochitests (`tests/browser/`)

- `browser_vimma_mcp_checkpoint.js` (new): `test_card_fields_in_a_cross_site_frame_make_a_pay_step`,
  `test_pay_button_outside_a_form_asks_under_a_grant`, `test_basket_button_does_not_ask`,
  `test_a_no_stops_the_step_and_keeps_the_grant`, `test_the_stated_total_is_quoted`,
  `test_checkpoint_notice_log_row_and_notification`.
- `browser_vimma_mcp_submit.js`: `test_submit_question_lists_the_fields_it_sends` (hidden fields
  counted, values cleaned).

### e2e (`tools/e2e`, under Xvfb)

- A local shop fixture (basket, checkout with card fields in a frame of a second local host):
  the payment checkpoint and the form checkpoint, screenshotted with the Omarchy theme.

## Docs and changelog

- `docs/guide.md` "Agents (MCP)": a "Checkpoints" part (what asks under a grant, what each
  question shows, what is not recognised); the grant's wording.
- README: the agents feature line names the payment checkpoint.
- `CHANGELOG.md`: added by the maintainer at merge, apart from any baseline line.

## Delivery

1. `feat(mcp): a form submission's question shows the fields it sends` (Behaviour 4, C2 for
   forms).
2. `feat(mcp): paying asks under any grant` (Behaviour 1-3, 5-8, C1, C3-C7).

## Open questions

None: the signals (C6) and what the question shows (C7) are decided above.
