# Writing a spec

A spec in `docs/specs/<name>.md` describes one feature or change before it is built. It is read by
contributors who were not part of the discussion that led to it, by the reviewer of every PR that
implements it, and by anyone trying to understand later why Vimma behaves the way it does. Write
it as finished technical documentation, not as a record of how it was decided.

Every new spec follows this page. A spec that is edited for any other reason is brought up to it
in the same PR.

## Writing rules

- **Write for an outside reader.** Assume they know Vimma's guide and Firefox's front end, but
  nothing about the conversation, issue thread or session that produced the spec. Every term
  is either in `docs/guide.md` or defined where it is first used.
- **State decisions, with their reasons.** Write "Vimma does X, because Y; Z was rejected
  because W". Each decision is a numbered item that starts with a bold title
  (`1. **Title.** Text`) in the Design section or a section whose heading says "Decisions", and
  its text gives the reason with "because", "so that", "so", "since", "in order to" or
  "Reason:". A decision without a reason is a choice the next reader cannot re-examine, so
  `npm run spec-lint` fails on one in a draft or accepted spec (below, "Checks"). Do not write who asked for it, who chose it, when, or how the choice was reached.
  No "the user said", "user request", "user decision", "the coordinator", quoted chat messages
  or dates of conversations.
  <!-- process-wording: these rules quote the phrases they ban -->
- **No process residue.** Agent instructions, session handovers, to-do lists for the author and
  "first draft" notes do not belong in a spec. Handover notes go in the PR description.
- **Verify every fact.** A claim about Firefox cites the engine path and line, and the Firefox
  version it was checked against. A claim about another tool (Hyprland, Omarchy, release-please)
  says the version and how it was checked. A claim about Vimma's own code cites the file. If
  something was not checked, say so.
- **Be precise.** Exact key names, pref names, file paths, limits and units. Requirements use
  **must**, **must not** and **may** where the behaviour is tested; prose explains the rest.
- **Plain, professional English.** Active voice, present tense, short sentences. No marketing,
  no filler, no emoji. Consistent with the terms in `docs/guide.md`.
- **One feature per spec.** If the scope grows past what one PR series can deliver, split it.

## Lifecycle

A spec moves through three statuses, set on its `Status:` line.

1. **Draft.** The spec merges to `main` as soon as it meets this page, with `Status: draft` and
   its open questions listed in its Open questions section. It does not wait in an open pull
   request for answers. The same change opens the feature's GitHub issue.
2. **Accepted.** Each answer is a small edit, merged at once: the answer moves into Design as a
   decision with its reason, and the question is removed. When no question is open, the status
   becomes `accepted` and the feature can be built.
3. **Implemented.** The status becomes `implemented` with the last sub-PR of its Delivery
   section.

The `Status:` line starts with one of these three words. A short note may follow it, in
parentheses or after a comma: which sub-PRs are built, or the issue that tracks a part that is
not. Each implementing pull request updates that note, and the last one sets `implemented`.

A draft or accepted spec names its GitHub issue on an `Issue:` line (`Issues:` for several),
its own paragraph under the status line. A spec delivered in several issues lists each of them.

### Implemented specs are frozen

An implemented spec, and every milestone spec (`m0-*` to `m7-*`), is a record of the design as
it was built and of the reasons at that time. It is not rewritten when the code changes later,
because a reader comparing it with the history of the code needs the design that the code was
written against.

- A later change gets a spec of its own, or goes into the spec of the feature that is still
  being built and changes it.
- Where an implemented spec no longer matches the code, it gets a short note at that place:
  `(Since changed: <what changed>; <where it is described now>.)`. When the whole spec is
  affected, the note is a paragraph starting "Since changed:" under the status line.
- A part that was specified but never built is named on the status line with its issue, for
  example `implemented, except the leftovers in #<issue>`.
- A change that moves paths named in many implemented specs is noted here once rather than at
  each place. Since #937, `packages/vimma-core/src/<name>.mjs` in a spec means the module of that
  name in one of the folders that `ARCHITECTURE.md`'s "Module map" lists.

### Keeping statuses current

Two checks keep a status from drifting away from the work.

- **`npm run spec-lint`** (part of `npm run lint`, and a step of CI's required check) fails
  when a spec's `Status:` line does not start with `draft`, `accepted` or `implemented`; when an
  ADR's `- Status:` line does not start with `Proposed`, `Accepted`, `Superseded`, `Deprecated`
  or `Rejected`; when a draft or accepted spec has no `Issue:` line; and when a decision in a
  draft or accepted spec has no reason (Writing rules). Implemented specs are frozen and are not
  checked for reasons. The decisions that predate the check are listed by title in
  `tools/spec-lint/decisions-baseline.json`; giving one a reason, or the spec becoming
  implemented, makes its entry fail as no longer needed, so the list only shrinks. No new
  entry is added to it.
- **`spec-status.yml`** runs `npm run spec-status` (`tools/spec-lint/spec-status.ts`) every day,
  whenever an issue is closed or reopened, and when `docs/specs/` changes on `main`. It reports a
  draft or accepted spec whose issues are all closed, an implemented spec with an open issue, an
  open issue whose `spec:draft` or `spec:accepted` label differs from the spec, and an `Issue:`
  number that is not an issue. A spec put on hold keeps its `draft` or `accepted` status, and its
  issue is closed as not planned with the `on-hold` label; the check does not report it, because
  the work is parked rather than built, and reopening the issue resumes it. The report is one
  issue labelled `spec-status`, updated on each run and closed when nothing is left. Fix it in
  the spec (status or `Issue:` line) or on the issue. The check cannot run in pull request CI,
  because a status drifts when an issue closes, which no pull request sees; and it cannot fix
  the spec itself, because `main` takes changes only through pull requests.

### The feature's issue

Every planned feature has one GitHub issue. It is the backlog entry, and the
[roadmap](../roadmap.md) links to it instead of describing the feature itself.

- **Title:** the feature's name.
- **Body:** a short reason for the feature, a link to the spec on `main`, and the spec's open
  questions as a numbered checklist, each with its options and a recommendation, worded as in
  the spec.
- **Labels:** `planned`, and `spec:draft` or `spec:accepted` to match the spec; `ready` once it
  can be built; others such as `security` where they apply. A milestone is optional.
- **Board:** the [Vimma roadmap](https://github.com/orgs/vimma-browser/projects/1) project tracks
  each issue as Planned, In progress or Done.

The maintainer answers the questions in a comment on the issue. The answers then go into the
spec as above, and the issue's labels follow the spec's status. The implementing pull requests
reference the issue, and the last one closes it.

A pull request exists only for work that is ready to merge. Anything waiting on a decision is a
question in an issue, not an open pull request.

## Template

Copy this skeleton. Sections that do not apply stay, with one line saying why (for example "No
upstream patch.").

```markdown
# Spec: <name>

Status: draft | accepted | implemented · Area: <files and modules touched> · Upstream patches:
<none, or each new patch with its ADR-003 register line> · ADR: <links, or none>

Issue: [#<n>](https://github.com/vimma-browser/vimma/issues/<n>)

## Summary

Two to four sentences: what changes for the user, and why it is worth doing.

## Problem

What does not work or is missing today, in product terms. Concrete examples.

## Behaviour

User stories ("As a Vimma user, ...") or a numbered list of behaviours. Each one is observable
and maps to at least one test below. Include the keys, commands and config it adds or changes.

## Research

What was checked before designing it: Firefox source (engine path:line, Firefox version), other
browsers or forks, platform facts. Only what the design depends on.

## Design

How it works: modules, data flow, state, the Firefox APIs used and why they are the right ones.
Numbered decisions, each with its reason and the alternatives rejected:

1. **<Decision as a short title>.** What Vimma does, because <reason>. Rejected: <alternative>,
   because <reason>.

## Security and privacy

What it exposes, to whom, and what stops misuse. "No new surface" with a sentence of reasoning is
an acceptable answer.

## Tests

The acceptance criteria as test names, by layer (vitest in `vimma-core`, mochitest, e2e). They
are written first and seen to fail.

## Docs and changelog

The `docs/guide.md` sections, README lines and `CHANGELOG.md` entries the change needs.

## Delivery

The PR or sub-PRs, in order, each independently mergeable and tested.

## Open questions

Each question states the options, their trade-offs and a recommendation. When it is answered,
the answer moves into Design as a decision with its reason, and the question is removed.
```

## Before the spec is merged

- [ ] Every section of the template is present, and the `Issue:` line names the feature's issue.
- [ ] Every decision gives its reason.
- [ ] No sentence depends on knowing the discussion that produced the spec.
- [ ] Every claim about Firefox or another tool cites a source and a version.
- [ ] Every behaviour has a test.
- [ ] Every open question has its options and a recommendation, and the feature's issue lists
      them.
- [ ] `npx prettier --check` and `npm run spec-lint` pass.
