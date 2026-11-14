# Security model

What each risky part of Vimma may do, what it must never do, who can reach it, and the test that
holds it to that. It is a page of rules, not code: review it like a contract. Reporting a
vulnerability: [SECURITY.md](../../SECURITY.md).

**How to read it.** Each rule is one "must" or "never" sentence, followed by the tests that
enforce it, as `test name` links into the test file. CI fails if a link stops resolving
(`tools/security/check-doc-links.ts`), so a renamed or deleted test cannot leave a rule
unguarded. **⚠ gap** marks a rule the code does not meet yet, with its issue.

**Fuzzing.** Every parser of outside input (the control protocol, vimma-ctl's JSON, `config.toml`,
routing rules, key notation, the command line, a theme's `colors.toml`) is fuzzed with
property-based tests: a fixed seed on every PR, a random seed and many more cases nightly
(`.github/workflows/fuzz.yml`, spec [m7-fuzzing](../specs/m7-fuzzing.md)). Rules S11, U7, R6, F5 and
O7 rest on them.
[`parseKey and parseBinding throw nothing but KeyNotationError, on any text`](../../packages/vimma-core/test/fuzz/keys.fuzz.test.mjs),
[`json_parse_never_panics`](../../tools/vimma-ctl/tests/protocol_props.rs),
[`decoders_never_panic_and_accept_only_the_schema`](../../tools/vimma-ctl/tests/protocol_props.rs)

**Who can reach what.** _You_ means the local user Vimma runs as. _Other local users_ are other
accounts on the same machine. _Pages_ are web content, which runs in sandboxed content
processes. _Extensions_ are installed WebExtensions. _Local apps_ are other programs running as
you.

## Sections

One page per numbered section; §12 is two pages, the second being its part on the built-in agent.
A section keeps its number and a rule keeps its identifier (a letter prefix and a number, such as
S9 or M62), so a citation that gives only those ("security.md M62", "§12") finds its page here.

| Section | Page                                                                            | Rules               |
| ------- | ------------------------------------------------------------------------------- | ------------------- |
| §1      | [Control socket](01-control-socket.md)                                          | S1 to S14           |
| §2      | [Workspace routing](02-workspace-routing.md)                                    | R1 to R6, R8 to R10 |
| §3      | [Workspace deletion and containers](03-workspace-deletion-and-containers.md)    | W1 to W7            |
| §4      | [Opening URLs from untrusted text](04-opening-urls-from-untrusted-text.md)      | U1 to U7            |
| §5      | [Add-ons](05-add-ons.md)                                                        | A1 to A3            |
| §6      | [Chrome UI rendering](06-chrome-ui-rendering.md)                                | C1 to C4            |
| §7      | [Omarchy hook and the `vimma-open` launcher](07-omarchy-hook-and-vimma-open.md) | O1 to O10           |
| §8      | [config.toml](08-config-toml.md)                                                | F1 to F5            |
| §9      | [Privacy defaults](09-privacy-defaults.md)                                      | P1 to P8            |
| §10     | [Firefox updates](10-firefox-updates.md)                                        | G1 to G15           |
| §11     | [Out of scope and trust boundaries](11-out-of-scope-and-trust-boundaries.md)    | none                |
| §12     | [Agents (MCP)](12-agents-mcp.md)                                                | M1 to M34, M62      |
| §12     | [Agents (MCP): the built-in agent](12-agents-mcp-built-in-agent.md)             | M35 to M61          |
| §13     | [Page modes](13-page-modes.md)                                                  | K1 to K9            |
| §14     | [Build and release supply chain](14-build-and-release-supply-chain.md)          | B1 to B19           |
| §15     | [Live grep](15-live-grep.md)                                                    | L1 to L8            |
| §16     | [Update check](16-update-check.md)                                              | UP1 to UP14         |
| §17     | [Site compatibility workflow](17-site-compatibility-workflow.md)                | SC1 to SC5          |
| §18     | [Release download counts workflow](18-release-download-counts-workflow.md)      | DC1 to DC4          |
| §19     | [Site permissions](19-site-permissions.md)                                      | SP1 to SP5          |
| §20     | [The PDF viewer](20-pdf-viewer.md)                                              | V1 to V12           |
| §21     | [Downloads picker](21-downloads-picker.md)                                      | D1 to D6            |
