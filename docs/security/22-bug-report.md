## 22. The `:bug` report (`ui/report.mjs`)

`:bug` (or **Copy redacted report** on `about:vimma`) copies a plain-text report of Vimma's state
to the clipboard, made to be pasted into a public GitHub issue. These rules keep addresses and
your home directory out of it; what they cannot keep out is under Limits. Spec:
[m5-about-vimma](../specs/m5-about-vimma.md).

**Reach:** only you, with `:bug`, `:about` or the page's button; the report goes to the
clipboard and nowhere else. Paths in it come from your config, your theme and Firefox's
errors.

- BG1. The report **never** contains a URL: every `scheme://…` (web pages, `file:///`,
  extensions) becomes `<url>`, and page titles **never** enter it.
  [`drops URLs, whatever the scheme`](../../packages/vimma-core/test/report.test.ts),
  [`bug_copies_a_redacted_report`](../../tests/browser/browser_vimma_about.js)
- BG2. Every path under `$HOME` **must** start with `~`, with the home matched as a whole name:
  what follows it in the report is the end, whitespace, `/`, `\`, the punctuation around a path
  in the report or an error message (`:` `;` `,` `"` `'` `` ` `` `<` `>`), any opening,
  closing or quotation punctuation (`(` `)` `[` `]` `{` `}` `“` `”` `‘` `’` `«` `»` `「` `」`
  …), `…` (which also ends an error the report cut to length), or a run of `.`, `!` and `?`
  closing a sentence (`/home/alice... done`).
  [`turns paths under $HOME into ~`](../../packages/vimma-core/test/report.test.ts),
  [`ends a home at whitespace, a path separator or the punctuation that delimits a path`](../../packages/vimma-core/test/report.test.ts),
  [`a home that ends in punctuation is whole before a slash, a space or the end`](../../packages/vimma-core/test/report.test.ts),
  [`redacts a home the cut leaves right before its …`](../../packages/vimma-core/test/report.test.ts)
- BG3. The home **must** match whatever Unicode normal form the home and the path are written
  in (an NFD `$HOME` is common on macOS), and the rest of the report keeps its own characters.
  [`matches a home and a path in different Unicode normal forms (#1173)`](../../packages/vimma-core/test/report.test.ts),
  [`redactReport redacts exactly what the brute-force rule does`](../../packages/vimma-core/test/fuzz/strings.fuzz.test.ts)
- BG4. A path that only begins with the home's text, such as another user's home
  (`/home/alicebob`, `/home/alice+b`, `/home/josé` for a home of `/home/jos`), is **never**
  partly redacted: letters in any script, marks, digits, `+`, `~`, `@`, emoji, joiners and
  connector punctuation all continue a name.
  [`leaves other paths and look-alike prefixes alone`](../../packages/vimma-core/test/report.test.ts),
  [`reads letters past ASCII as part of a name`](../../packages/vimma-core/test/report.test.ts),
  [`reads +, emoji, joiners and connector punctuation as part of a name (#1173)`](../../packages/vimma-core/test/report.test.ts)
- BG5. Redaction **must** run in linear time, whatever the home and the report (CodeQL
  `js/polynomial-redos`): a scan, not a regular expression built from `$HOME`.
  [`strips a home's trailing slashes in linear time (CodeQL js/polynomial-redos)`](../../packages/vimma-core/test/report.test.ts),
  [`redacts a 3 MB report in linear time, in either normal form`](../../packages/vimma-core/test/report.test.ts),
  [`stays linear on near misses and on one long run of non-ASCII text`](../../packages/vimma-core/test/report.test.ts),
  [`each runs in bounded time on long runs of one character`](../../packages/vimma-core/test/fuzz/strings.fuzz.test.ts)
- BG6. The control socket's token **never** appears in `about:vimma` or the report.
  [`the_control_token_never_appears`](../../tests/browser/browser_vimma_about.js)

**Limits.** Read the report before you paste it. Redaction knows only `$HOME` and URLs:

- Your user name elsewhere stays: in a path outside your home (`/run/media/alice/…`,
  `/tmp/alice-…`), in a workspace name, or in a home reached another way (a symlinked `/home`
  shown as `/var/home/alice`, or different letter case on a case-insensitive disk).
- The home's text is redacted wherever it is followed by one of BG2's characters, not only at
  the start of a path: `/srv/home/alice/x` with a home of `/home/alice` becomes `/srv~/x`, and a
  sibling named `/home/alice,old` becomes `~,old`.
- A name that ends in `.`, `!` or `?` before a space is read as a sentence's end (`/home/alice.`
  is the home).
- Everything else continues a name (#1173): ASCII `=` `|` `*` `&` `%` `$` `^` `#` `@` `~` `+`,
  and `.`, `!` or `?` with no whitespace after them, so the home is not found in
  `HOME=/home/alice|x` or `/home/alice!x`, and those stay as written. The other side of the
  trade: a sibling such as `/home/alice+b` is never partly redacted (BG4).
