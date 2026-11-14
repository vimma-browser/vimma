## 17. Site compatibility workflow (`sites.yml`, `tools/sites`)

Spec: [site-compat](../specs/site-compat.md), decisions 1, 11 and 12, and its snapshot layer (SC5). Every night a hosted runner
loads about 25 live websites in an artifact build, compares the results with the previous
scheduled run and keeps one issue labelled `site-compat` up to date. Who can reach it: the
_pages_ it loads, which choose their titles, their text, where they redirect and what the checks
report about them, and so choose text that ends up in a GitHub issue. Nobody else: the workflow
runs on `schedule` and `workflow_dispatch` only, never on a pull request.

- SC1. The job that runs the browser on live pages holds **only** `contents: read`, and no step
  of it keeps or exports a token (checkout uses its read-only token and does not persist it); the workflow reads no secret, and the top-level permissions are empty. The
  diff and the issue text are made by a second job, on a fresh runner, from that job's
  `results.json` alone, with read permissions only (`actions` for the artifacts, `issues` to
  find the open issue), so code that escaped the browser onto its runner could not rewrite the
  issue text. The suite's step turns workflow commands off while it logs page text, so a page
  cannot add annotations or masks to the run.
  [`the browser job only reads the repository, and holds no token in any step`](../../tools/test/sites-workflow.test.mjs),
  [`the compare job only reads, and works from the browser job's results.json alone`](../../tools/test/sites-workflow.test.mjs),
  [`stops workflow commands while the suite logs page text`](../../tools/test/sites-workflow.test.mjs),
  [`has no secrets, and no permission at the top level`](../../tools/test/sites-workflow.test.mjs),
  [`runs nightly and by hand, never on a pull request or a push`](../../tools/test/sites-workflow.test.mjs)
- SC2. `issues: write` is **only** in the report job, which checks out nothing and runs no
  repository code: it runs `gh` on the `issue.md` the compare job wrote, passed as `--body-file`.
  The action and issue number reach its script through `env`, never through an expression in the
  script, and the number must be digits.
  The report job downloads the compare job's own upload by its artifact id, and runs only when
  that job succeeded, so an artifact of the same name uploaded from the browser job's runner is
  never the one posted.
  [`issues: write is only in the report job, which checks out and runs no repository code`](../../tools/test/sites-workflow.test.mjs),
  [`the report job takes the compare job's own upload, by id, only after it succeeded`](../../tools/test/sites-workflow.test.mjs)
- SC3. Text from a page or a check (titles, failure reasons) **never** reaches the issue body
  outside an inline code span, so GitHub renders no mention, issue or commit reference, link,
  image or HTML from it. Each value is put on one line with control and format characters
  (bidirectional overrides among them) replaced, cut to 160 characters, and fenced with more
  backticks than it contains. Lists stop at 50 entries and the body at 60 000 characters. The run
  link is written only when it is a GitHub Actions run URL, and the baseline's commit only when
  it is hexadecimal.
  [`puts no untrusted text outside a code span`](../../tools/sites/test/diff.test.ts),
  [`wraps text in a code span, where GitHub renders no mention, reference, link or HTML`](../../tools/sites/test/diff.test.ts),
  [`picks a fence longer than any run of backticks inside, padded at a backtick edge`](../../tools/sites/test/diff.test.ts),
  [`puts everything on one line: newlines, control and bidirectional characters`](../../tools/sites/test/diff.test.ts),
  [`cuts to MAX_TEXT characters, and says when it is empty`](../../tools/sites/test/diff.test.ts),
  [`caps the list and the body`](../../tools/sites/test/diff.test.ts),
  [`drops a run URL that is not GitHub's`](../../tools/sites/test/diff.test.ts)
- SC4. The previous run's `results.json` and `diff.json` are used **only** when they have the
  expected shape: site ids of lowercase letters, digits and dashes, statuses and check ids from
  fixed sets, strings where strings belong. Anything else is reported and compared as no
  baseline, so a damaged artifact cannot inject names or open an issue. Site names come from the
  repository's `sites.json`, whose test forbids anything GitHub would turn into a mention,
  reference or link.
  [`names nothing GitHub would turn into a mention, reference or link`](../../tools/sites/test/sites-data.test.ts),
  [`rejects a run of the wrong shape, unknown statuses and check ids, and odd site ids`](../../tools/sites/test/diff.test.ts),
  [`round-trips the tracked list through diff.json, and rejects one of the wrong shape`](../../tools/sites/test/diff.test.ts),
  [`reports no baseline when the previous artifact is missing or malformed`](../../tools/sites/test/compare.test.ts)
- SC5. The **snapshot gate** (`npm run sites -- --offline`, run by e2e.yml on every pull request)
  loads only the files in `tests/e2e/fixtures/sites/`, from a page server on 127.0.0.1, and never
  a live site: no other mode of the suite runs in e2e.yml. Each snapshot is third-party page
  content, recorded once and committed, so a test holds every file to the recorder's guarantees:
  it starts with a Content-Security-Policy that lets nothing run or load (`default-src 'none'`,
  inline styles only), and holds no script, event handler, frame, image or other embedded
  content, no URL attribute, no `url()`, `@import` or `image-set()` in a style, and no link but a
  fragment or the local `followed.html`. The checker reads markup where the browser's parser
  could read text (inside `<svg>`, after an abrupt comment end), never the reverse, and decodes
  CSS escapes and comments first. It is a backstop of what the recorder removes, not the only
  barrier: the policy blocks anything it might miss, and the offline profile sends every host
  but 127.0.0.1 to a proxy port where nothing listens, with WebRTC off. A pull request can change
  the checker and its tests as well as the snapshots, so the review of that pull request is the
  control; what such a change could reach is the job below. Only pages whose licence allows a copy are recorded
  (`--record` refuses any other id), and a new or changed snapshot is reviewed in its pull
  request like code. The step runs in the mochitest job (`contents: read`, no secret); its report
  and screenshots, which show only committed snapshots, are uploaded as an artifact when it
  fails, and nothing from it reaches an issue.
  [`rejects scripts and every element that loads or embeds something`](../../tools/sites/test/snapshot.test.ts),
  [`rejects event handlers however they are written`](../../tools/sites/test/snapshot.test.ts),
  [`allows only fragment links and the follow target as href`](../../tools/sites/test/snapshot.test.ts),
  [`rejects every other attribute that names a URL`](../../tools/sites/test/snapshot.test.ts),
  [`rejects url(), @import and image-set() in styles`](../../tools/sites/test/snapshot.test.ts),
  [`wants the doctype, and the CSP as the first thing in <head>`](../../tools/sites/test/snapshot.test.ts),
  [`ends a comment where the parser does: <!-->, <!--->, --!>`](../../tools/sites/test/snapshot.test.ts),
  [`reads markup inside raw-text elements too, as in <svg>, where they are not raw`](../../tools/sites/test/snapshot.test.ts),
  [`reads CSS escapes and comments before looking for loads`](../../tools/sites/test/snapshot.test.ts),
  [`each have a manifest entry with a licence that allows redistribution`](../../tools/sites/test/snapshot.test.ts),
  [`runs the suite only offline, after the e2e scenarios, on the artifact build`](../../tools/test/sites-workflow.test.mjs)
