# Security policy

## Supported versions

Vimma is pre-alpha. Only the latest `main` is supported: fixes land there, and there are no
release branches or backports.

## Reporting a vulnerability

Please report privately, not in a public issue or pull request: use GitHub's private
vulnerability reporting, under the repository's **Security** tab, **Report a vulnerability**.

If that button is missing, open a public issue that says only "I have a security report,
please contact me", with no details.

Include what you can: the Vimma commit, the Firefox version (`about:vimma`), steps to
reproduce, and what an attacker gains.

A flaw in Firefox itself (Gecko) that Vimma did not introduce belongs to Mozilla: report it
through [Mozilla's process](https://www.mozilla.org/security/bug-bounty/). Vimma picks up the
fix with the next Firefox release: an automated, tested bump PR within hours of the release, and
a security dot release merged within 3 days ([docs/rebase.md](docs/rebase.md),
[docs/security/10-firefox-updates.md](docs/security/10-firefox-updates.md) §10).

## What to expect

Vimma is maintained by one person in their own time, so these are aims, not guarantees:

- an acknowledgement within a week;
- an assessment, and a fix or a plan, within 30 days for anything that lets a web page, an
  extension or another local user break a rule in [docs/security/](docs/security/README.md);
- credit in the advisory, unless you prefer not to be named;
- a GitHub security advisory once the fix is on `main`.

## Security model

[docs/security/](docs/security/README.md) lists, for each risky part of Vimma, what it may do, what
it
must never do, who can reach it, and the tests that enforce each rule. A report that one of
those rules does not hold is always in scope.
