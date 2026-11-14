## 11. Out of scope and trust boundaries

- **Gecko itself.** Page isolation, the sandbox, TLS and the JavaScript engine are Firefox's.
  Vimma is only as safe as the Firefox release under it, so security comes from shipping each
  Firefox release, and each security dot release, quickly: §10 above and
  [docs/rebase.md](../rebase.md) ("Security dot release: the fast path"). Source and dev builds
  have no built-in updater, and release builds will carry Firefox's updater pointed at
  updates.vimma.dev only (UP12,
  [`update_url_matches_the_build`](../../tests/browser/browser_vimma_updater.js)); until then
  updates come with your package or Vimma's update check (§16).
- **Malware running as you.** It can read your profile, cookies, the control token and
  config.toml, and drive any app you run. Vimma does not defend against it; file modes keep out
  other local users, not your own processes.
- **Root and physical access** are out of scope.
- **What agents do outside Vimma.** Vimma bounds what a local AI agent can do _through Vimma_
  (§12): the agent workspace only, each request asked. It cannot bound what the agent does with
  its own shell, files and network, or what its host lets it do unasked; that is the agent
  host's matter. A prompt-injected agent with a shell can also read the control token like any
  process of yours, which is why the `full` role is a separate switch to keep off.
- **Build infrastructure.** Trusted: GitHub's hosted runner image and the Actions service,
  Mozilla's release key, and the toolchains Mozilla's build fetches. Everything else that
  reaches a build is verified or pinned: Firefox source (B1), Vimma's code (the release tag or
  `main`, written only through reviewed pull requests), npm packages (lockfile integrity, B3,
  B4) and actions (commit SHAs). A cosign signature on a release attests "built by
  `release.yml` at this tag on a GitHub-hosted runner from these verified inputs"; it does not
  attest that the binary is reproducible, or anything about a compromised runner image or
  Actions service (spec [build-supply-chain](../specs/build-supply-chain.md), decision 20).
- **What you type.** Commands you type yourself (`:open`, `:source`, the control socket with your
  token) act with your authority; the rules above stop text from others from doing the same.
