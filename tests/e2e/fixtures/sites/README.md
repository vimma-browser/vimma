# Site snapshots

Recorded pages for the site suite's offline gate (`npm run sites -- --offline`, run by e2e.yml on
every pull request; spec [site-compat](../../../../docs/specs/site-compat.md), "Snapshot layer").
Each file is a page's rendered document as the browser built it, with its scripts, event
handlers, images, frames, fonts and every network reference removed, the stylesheets it uses
inlined, and every link pointing to `followed.html`. Each starts with a Content-Security-Policy
that lets nothing run or load. `tools/sites/test/snapshot.test.mjs` checks all of that for every
file here, and that each one is listed in `snapshots.json` with its licence.

Only pages whose licence allows redistribution are recorded (`SNAPSHOT_LICENCES` in
`tools/sites/snapshot.mjs`). The files are kept byte-exact as the recorder wrote them, so
prettier skips them.

## Attribution

Each snapshot is an adaptation of the page below: the same text and markup, without the page's
scripts and media. Its licence applies to that file, not to the rest of this repository.

| File               | Page                                                                                              | Authors                                                                                                           | Licence                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `wikipedia.html`   | "Vim (text editor)", <https://en.wikipedia.org/wiki/Vim_(text_editor)>                            | Wikipedia contributors ([history](<https://en.wikipedia.org/w/index.php?title=Vim_(text_editor)&action=history>)) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)                                                                                |
| `mdn.html`         | "Array", <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array> | Mozilla Contributors                                                                                              | [CC BY-SA 2.5](https://creativecommons.org/licenses/by-sa/2.5/); the inlined site styles are MPL-2.0 ([mdn/fred](https://github.com/mdn/fred)) |
| `python-docs.html` | "pathlib — Object-oriented filesystem paths", <https://docs.python.org/3/library/pathlib.html>    | Python Software Foundation                                                                                        | PSF-2.0 ([PSF License Version 2](https://docs.python.org/3/license.html)); code examples also 0BSD                                             |
| `rust-std.html`    | "Vec in std::vec", <https://doc.rust-lang.org/std/vec/struct.Vec.html>                            | The Rust Project Developers                                                                                       | MIT OR Apache-2.0 ([rust-lang/rust](https://github.com/rust-lang/rust))                                                                        |

All four were recorded on 2026-10-21, each from a copy of the page and its stylesheets fetched once
(`--record <id>=<url>`).

## Recording a snapshot

`npm run sites -- --record <id>` loads the live page in a fresh profile and writes the snapshot
into `site-compat-output/snapshots/`, after checking it; `--record <id>=<url>` records from a
saved copy of the page instead. Review the file, copy it here, and add its `snapshots.json` entry:
`expect` holds each check's result on the snapshot (`pass` or `skip`), which the gate then holds
it to, and the attribution row above.

## Licence of rust-std.html

`rust-std.html` is a copy of documentation generated from the Rust standard library, which is
dual-licensed under the MIT licence and the Apache License, Version 2.0, at the user's option.
Copyrights in the Rust project are retained by their contributors
([COPYRIGHT](https://github.com/rust-lang/rust/blob/master/COPYRIGHT)). The MIT licence's text:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software
> and associated documentation files (the "Software"), to deal in the Software without
> restriction, including without limitation the rights to use, copy, modify, merge, publish,
> distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
> Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
> BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
> DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
