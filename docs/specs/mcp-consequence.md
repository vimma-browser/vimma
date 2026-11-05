# Spec: mcp-consequence

Status: implemented · Area: `packages/vimma-core/src/`
(`agent-checkpoint.mjs`, `agent.mjs`, `agent-prompt.mjs`); `src/browser/base/content/vimma/`
(`ctl/agent-commands.mjs`, `ctl/AgentGate.sys.mjs`, `actors/agent-fields.mjs`,
`host/agent-ui.mjs`, `agent/AgentChat.sys.mjs`); `tools/vimma-ctl` (`src/mcp.rs`: the
instructions and `vimma_activate`'s description); `tools/agent-bench/` (the two-shop scenario) ·
Upstream patches: none · ADR: [ADR-019](../adr/019-agents-over-mcp.md) (unchanged). No new
dependency.

Issue: [#693](https://github.com/vimma-browser/vimma/issues/693)

Changes [mcp-checkpoints](mcp-checkpoints.md) C1, C5 and C6 and [mcp-forms](mcp-forms.md) F15,
which are implemented and keep their text with a "Since changed" note. Decisions of those specs
are written "mcp-checkpoints C1" and "mcp-forms F15"; this spec's own are "K1", "K2", and so on.
Engine paths are relative to `engine/` (Firefox 159.0.1). Vimma paths are under
`src/browser/base/content/vimma/` unless they start with `packages/`, `tools/` or `tests/`.

## Summary

Under a grant, a click that sends a form asks only when sending it has a consequence the user
has to judge: it pays, or it sends text or personal details. A form that sends only the page's
own values, such as a shop's "add to basket" form with a product id and a quantity, runs under
the grant like any other click. A form question that still repeats on one site can be answered
with `a`, which allows that button on that site for the rest of the grant; paying never can.

## Problem

- **A basket form asks every time.** mcp-forms F15 asks before every form submission, under any
  grant. A shop whose "add to basket" button is a submit button in a form (one of the two shop
  designs in issue #693) asks once per item: a task of five items in two shops is ten questions
  that say nothing the user needs to judge, which trains a reflexive `y` for the question that
  does matter.
- **The pay words are no rule.** Sites name buttons in any language and agents do more than
  shop, so a list of words (mcp-checkpoints C6) can only add questions; it cannot say that a
  step is harmless. Whether a step asks has to follow from what it does.

## Behaviour

1. **A harmless form runs under the grant.** Under a grant, a `vimma_activate` click that submits
   a form runs without a question when the step is not a payment step (mcp-checkpoints C6) and
   the form sends no text or personal details (K2). It shows the grant's notice and gets a
   `:mcp log` row like any granted click, both naming the form's method and destination host.
   The submission guard (mcp-forms F16) lets that one submission through as it does after a yes.
2. **A consequential form still asks** as a checkpoint (mcp-checkpoints Behaviour 4), under any
   grant, when it is a payment step, or sends a password, payment card, one-time-code or file
   field, an identity field, or free text (K2), or when Vimma cannot tell what it sends (K3).
   Without a grant every form submission asks as it does today.
3. **A fill that submits always asks** (mcp-forms F15, unchanged), because what it sends is what
   the agent typed (K4).
4. **`a` on a form checkpoint allows that button on that site for the rest of the grant.** Under
   a grant, a form checkpoint that is not a payment step and sends no password, card,
   one-time-code or file field has the hint `y send it · a always here · n stop`. `a` sends this
   form and lets later clicks that send a form from a page of the same site, with the same
   method, destination and button text (K5), run as in Behaviour 1 until the grant ends. A count
   before `a` is ignored: the allowance lasts as long as the grant. Its notice reads
   `allowed "Add to basket" on shop.example for this grant`, and its `:mcp log` row's outcome is
   `allowed (checkpoint, for the grant)`. A payment checkpoint keeps `y pay · n stop`.
5. **The grant's notice says what still asks:**
   `claude-code may use the agent workspace until it quits; paying and sending text or personal details still ask (ctrl+b shift+a ends it)`.
6. **The pay words stay.** The phrase list of mcp-checkpoints C6 still makes a step a payment
   step; it adds questions and never removes one (K6).

## Research

### Firefox (159.0.1)

- **Identity fields.** `getAutocompleteInfo().fieldName` gives an input's or select's
  autocomplete field name (`name`, `given-name`, `email`, `tel`, `street-address`,
  `postal-code`, `bday`, `username` and the rest), and form autofill's
  `FormAutofillHeuristics.getFormInfo` infers the same names for fields without one
  (`toolkit/components/formautofill/shared/FormAutofillHeuristics.sys.mjs`); Vimma's child
  already uses both for card fields (`actors/agent-fields.mjs`, `cardFieldShown`, `cardFields`).
- **The Payment Request API is still off.** `dom.payments.request.enabled` defaults to `false`
  (`modules/libpref/init/StaticPrefList.yaml:4189`), so `PaymentRequest` does not exist in
  Vimma's pages and is no signal (mcp-checkpoints C5).

### Shops

The two shop designs of issue #693: S-kaupat's basket buttons are `type=submit` buttons outside
any form, so they are ordinary clicks today; the other design, a submit button in a small form
per product, sends hidden fields (a product id, a token) and a quantity. The fixture shop of
`tools/agent-bench/shop.mjs` gains the second design for the two-shop scenario.

## Design

1. **Under a grant a click's form asks by its consequence (K1),** because a grant is the user's
   yes to the task, and what the task's steps cannot be trusted with is spending money and
   sending what someone wrote or who someone is: a basket form changes only the basket, which
   the agent may change with ordinary clicks anyway (mcp-forms F17). This is the narrowest change
   that ends repeated basket questions while every payment and every message still asks.
   Rejected: keeping F15 as it is, because the repeated questions train the user to answer `y`
   without reading; deciding by the page the submission leads to (a checkout or a payment
   provider), because the next page is known only after the request is sent, and cancelling it
   and asking then could send it twice when the user says yes (mcp-checkpoints C6).
2. **What makes a form consequential (K2).** A submission is consequential when it is a payment
   step (mcp-checkpoints C6), or when the form sends any of: a password, payment card or
   one-time-code field (mcp-forms F6); a file field; an identity field, one whose autocomplete
   field name, given by the page or inferred by form autofill's heuristics, is a name, an email
   address, a telephone number, a postal address part, a birth date, a username or an
   organisation, or whose type is `email` or `tel`; or free text, a `textarea` or a text-like
   input (`text`, `url` and inputs without a known type) whose value is not empty and is not a
   quantity (at most three ASCII digits, with decimals, read on the raw value so that digits
   of other scripts or compatibility forms never pass, and a code or account number is text),
   because those are where a message, a sign-up or a person's details go. Hidden fields,
   checkboxes, radio buttons, selects, numbers, dates other than a birth date, empty fields, a
   `type=search` field and the pressed button's own value are not, because they hold values the
   page chose or the agent picked from the page's own options. The child marks each sent field
   that is a text or an identity field, and the parent decides from that list, so the rule is
   one pure function in core (`agent-checkpoint.mjs`). The child judges the form again just
   before it presses the button and skips the click when it no longer passes, because another
   call, such as a fill, may write into the form between the judgement and the click.
   Rejected: free text of any value, because a quantity box written as a text input would make
   every basket form ask again; the field's name (`message`, `comment`), because names are the
   page's choice in any language, the same weakness as the pay words.
3. **A doubt asks (K3).** When the child does not say in time what the form sends, says
   something malformed, the form sends more fields than the question can list, or a value is
   longer than the child reads of it, the submission asks, because a missed question can send a message or an order while a wrong one
   costs one key.
4. **A fill that submits always asks (K4),** because it sends the values the agent has just
   typed, which is the content the user is asked to judge; a search goes by URL instead
   (agent-speed S2), so a fill that submits is rare in a granted task.
5. **The `a` key allows one button on one site (K5),** because a site whose forms the rules of
   K2 cannot place (a basket form with a delivery postcode field, a quantity box with a unit
   in it) would otherwise ask on every item. The allowance is the tab's site (registrable
   domain), the form's method and destination (scheme, host, port and path, not the query) and
   the pressed button's text after cleaning (mcp-checkpoints Behaviour 4), held per connection
   in memory and ended with the grant (`ctrl+b shift+a`, `:mcp revoke`, the grant's end, the
   connection's close, stopping a built-in conversation). It never covers a payment step or a
   form that sends a password, card, one-time-code or file field, checked again on every later
   click, and it is offered only under a grant, so a yes without one cannot make it. Rejected:
   one allowance for the whole site, because a site's sign-up or message form would ride on its
   basket button; the label of the element list, because labels change with every list; the
   form's values, because a basket form differs per product and the allowance would never match
   again.
6. **The pay words are only an extra signal (K6),** because a word list can never be complete,
   so it may add a question but never decide that a step is harmless. Card fields shown in any
   frame and the pay phrases stay the payment signals of mcp-checkpoints C6, with "a doubt asks";
   a page that hides a checkout behind a neutral button outside a form is still not recognised,
   as mcp-checkpoints' threat table says.

## Security and privacy

The change removes questions, so it widens what a grant allows: under a grant, an agent may now
send a form that sends no text, no personal details and no secret, and, after `a`, the forms of
one button on one site. What limits it:

| Threat                                                                                            | Mitigation                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A prompt-injected agent sends a message or signs up under a grant.**                            | Free text and identity fields ask (K2); a fill that submits always asks (K4).                                                                                                                                                                                   |
| **A page hides a message in hidden fields** (its script copies typed text into a hidden field).   | Not stopped, as a page's own `fetch` is not (mcp-forms F17): the page is the party that sends, and it could send the same text without a form. The threat guarded against is the agent's own step, which K2 judges by the fields it sends.                      |
| **A page makes a payment look like a basket form.**                                               | A payment step asks first (mcp-checkpoints C6, unchanged), and `a` never covers one; a checkout behind a neutral button is not recognised, as before.                                                                                                           |
| **A page trains `a` on a harmless button, then reuses its destination for a consequential form.** | The allowance is checked on every click against K2's secrets and payment signals, and a different button text or path asks again; free text and identity fields under an allowed button are what `a` allows for that one button, by the answer on its question. |
| **An allowance outlives the task.**                                                               | It ends with the grant and the connection, and is held in memory only.                                                                                                                                                                                          |

`docs/security.md` M28 changes: a click that submits a form must ask under a grant when it is
consequential (K2, K3) or not covered by an allowance (K5), and an unasked submission is the only
one the guard lets through; M33 gains that its question never offers `a`.

## Tests

### Vitest (`packages/vimma-core`)

- `agent-checkpoint.test.mjs`: `a form of hidden fields, numbers and choices is not
consequential`; `free text, an identity field, a secret or a file makes it consequential`; `an
unknown or overflowing field list is consequential`; `a payment step is consequential`.
- `agent.test.mjs`: `an allowance runs its key under the grant`, `an allowance ends with the
grant`, `an always request is not covered by an allowance`.
- `agent-prompt.test.mjs`: `a form checkpoint under a grant offers a`, `a payment checkpoint
never offers a`, the allowance's notice and log outcome, the new grant notice.

### Mochitests (`tests/browser/`)

- `browser_vimma_mcp_checkpoint.js`: `test_basket_form_runs_under_a_grant`,
  `test_message_form_asks_under_a_grant`, `test_a_allows_that_button_on_that_site`,
  `test_a_is_not_offered_on_a_pay_step`.
- `browser_vimma_mcp_submit.js`: the existing tests that a submission asks without a grant stay
  green.

### Bench (`tools/agent-bench`)

- The two-shop scenario of issue #693 (Delivery 2, `npm run agent-bench -- --two-shops`,
  `tools/agent-bench/two-shops.mjs`): five items compared across two local shops on two hosts,
  whose product cards name the product in a heading and show the price apart. One shop's add
  button is an icon-only button named by its `aria-label` whose script posts to the shop; the
  other's is a repeated "Add", the submit button of a form with hidden fields and a quantity.
  The scripted floor finds each product's button by its name in the element list, and the run
  fails unless both baskets hold each shop's cheapest match, only the two checkouts ask, and no
  result says that questions are waiting. CI runs it with `--check` in `e2e.yml`.

## Docs and changelog

- `docs/guide.md`, "Checkpoints: sending a form and paying": which forms ask under a grant, and
  the `a` key.
- `docs/security.md` M28 and M33.
- `CHANGELOG.md`: written by release-please from the commit.

## Delivery

1. `feat(mcp): ask before a form by what it sends, not every time` (K1-K6, Behaviour 1-6).
2. `test(bench): two shops and five items under one grant` (issue #693's acceptance target).

## Open questions

None: issue #693's question 1 is answered by K1 to K6.
