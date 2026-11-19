## 7. Omarchy hook and the `vimma-open` launcher

The hook (`omarchy/vimma-theme-reload.sh`) runs when you change your Omarchy theme. Vimma
writes it into `~/.config/omarchy/hooks/theme-set.d/`. `vimma-open` (`tools/package/`) is the
desktop entry's launcher (`Exec=/usr/lib/vimma/vimma-open %u`, `/opt/vimma/vimma-open %u` in
the PKGBUILD: by its installed path) and the
command `BROWSER=vimma-open` runs: it names the programs that opened a link, nearest first, for
routing (spec [app-routes](../specs/app-routes.md), decisions 6 to 10), and hands the link to
`vimma` in its own session.

**Reach:** the hook gets the theme name, which comes from a theme anyone can publish.
`vimma-open` gets a URL and its arguments from any local program, reads `/proc` for the names
of its parent processes, and reads `TERM_PROGRAM`, which any program can set.

- O1. The hook **must** only ask running Vimmas to reload their theme (D-Bus, else
  `vimma-ctl reload-theme`) and **never** start a Vimma.
  [`asks every running Vimma, over Firefox's D-Bus remoting, to reload its theme`](../../tools/omarchy/test/theme-hook.test.ts),
  [`never starts Vimma: with none running it does nothing and says nothing`](../../tools/omarchy/test/theme-hook.test.ts)
- O2. The hook **never** passes its arguments (the theme name) on to Vimma or `vimma-ctl`.
  [`never passes its arguments on: a hostile theme name changes nothing`](../../tools/omarchy/test/theme-hook.test.ts)
- O3. `-vimma-reload-theme` **must** open no window or tab.
  [`test_remote_reload_theme`](../../tests/browser/browser_vimma_omarchy_hook.js)
- O4. Vimma **must** write the hook only where none is, or over its own unedited copy; an edited
  copy is yours and never touched. [`test_installer`](../../tests/browser/browser_vimma_omarchy_hook.js)
- O5. `vimma-open` **never** passes a single argument that starts with `-`, so a crafted link
  cannot become a browser flag (`-profile`, `--remote-debugging-port`).
  [`refuses a single argument that is a flag: %u must never smuggle one in`](../../tools/package/test/vimma-open.test.ts)
- O6. The names **must** be at most eight lower-case tokens of at most 64 characters each,
  separated by commas (the seven nearest and the farthest); a name that is not a token is
  passed over, never passed on, so a child that renames itself cannot hide an agent CLI's name
  above it (R8), and an inherited `VIMMA_FROM` is **never** passed on. `TERM_PROGRAM` is added
  only when the walk could not see the terminal (it passed a name that is not a token, or hit
  the 32-step limit), so a job an agent CLI left behind, reparented to pid 1, does not take the
  terminal's name.
  [`never passes a name that is not a simple token, and keeps the names before it`](../../tools/package/test/vimma-open.test.ts),
  [`refuses a name with a newline in it`](../../tools/package/test/vimma-open.test.ts),
  [`never passes a VIMMA_FROM it did not set`](../../tools/package/test/vimma-open.test.ts),
  [`keeps the seven nearest names and the farthest past eight`](../../tools/package/test/vimma-open.test.ts),
  [`a_detached_child_under_an_agent_cli_gets_no_TERM_PROGRAM_name`](../../tools/package/test/vimma-open.test.ts),
  [`stops at the compositor without naming it`](../../tools/package/test/vimma-open.test.ts),
  [`a name that is not a token never hides the names beyond it`](../../tools/package/test/vimma-open.test.ts)
- O7. A theme's `colors.toml` (anyone can publish a theme) **must** give only `#rrggbb` colours
  and one CSS rule, and be read in bounded time however deep or large it is.
  [`parseOmarchyColors never throws; a palette has every key, as #rrggbb or a mode`](../../packages/vimma-core/test/fuzz/theme.fuzz.test.ts),
  [`any theme file and any accepted font give CSS that tokensToCss accepts`](../../packages/vimma-core/test/fuzz/theme.fuzz.test.ts),
  [`a hostile theme file is read in bounded time: deep, huge, many keys`](../../packages/vimma-core/test/fuzz/theme.fuzz.test.ts)
- O8. `--from` **must** take exactly one app token and one URL that does not start with `-`
  (else exit 64): it names a program, never a workspace, so the choice stays with config.toml.
  [`--from refuses a name that is not a token`](../../tools/package/test/vimma-open.test.ts),
  [`--from refuses a URL that is a flag`](../../tools/package/test/vimma-open.test.ts),
  [`--from names the app and skips the walk`](../../tools/package/test/vimma-open.test.ts)
- O9. `vimma-open` **never** runs a command of a multiplexer it passes (`tmux`, `herdr`,
  `zellij`): asking a server for its client would run your tmux hooks on every link, and could
  name the wrong terminal. Its server ends the list instead.
  [`never runs tmux or herdr`](../../tools/package/test/vimma-open.test.ts),
  [`a daemonised tmux server ends the list at tmux, whatever its clients`](../../tools/package/test/vimma-open.test.ts)

- O10. Settings' Make default button **must** register only the package's own desktop entry,
  never a command another program chose. On Linux, BrowserGlue's `browser-before-ui-startup`
  category runs `services/AppLauncher.sys.mjs` (before the command line runs, so before Firefox
  handles `vimma -setDefaultBrowser`, and before the first window), which starts Firefox's shell
  service with `MOZ_APP_LAUNCHER` set to the `vimma-open` next to the binary, replacing any value
  inherited from the caller, and then
  sets it to empty, so no program Vimma starts inherits it (a Firefox started from one would take
  `vimma-open` as itself, bug 1494436). An AppImage, known by its own `is-packaged-app` marker
  and never by the caller's `APPDIR`, keeps `AppRun`'s value (the `.AppImage`); without a
  `vimma-open` next to the binary (the tarball, a build from source) nothing is set. When something
  starts the shell service first (the profile service making a dedicated default profile on a
  first start), it has taken another command; Vimma reports that in
  the console, and Make default then asks GIO for the first desktop entry it lists whose `Exec` program is
  that `vimma-open` (usually the package's; a user entry in `~/.local/share/applications` that
  runs it, with any arguments, comes first, as for Firefox's own button, see §11) and sets it, for what Firefox's own button sets, or runs Firefox's method
  when there is none, under Flatpak, or when a policy forbids it. The default-browser check then also counts that
  entry when GIO names it for both http and https, by the same exact-path match, with a quoted
  or escaped program never matching. `vimma -setDefaultBrowser` is the same explicit request as
  the button and takes the same path, on time or late. A program that can write
  `~/.local/share/applications` or
  `mimeapps.list` can choose the default browser itself, so a desktop entry there that also runs
  `vimma-open` is outside this boundary (§11). On Omarchy, where GIO names Omarchy's router
  (`omarchy-browser.desktop`) as the http and https handler, Vimma also counts itself the
  default when the entry the router opens (the first installed one past it in the
  `mimeapps.list` files, as `omarchy-cmd-default-browser` reads them) runs exactly the absolute
  command the shell service took as Vimma's own, read line by line exactly as Omarchy's launcher
  reads it, so a relative or quoted command, or a line Omarchy skips, never matches. This
  changes only what Firefox's default-browser check reports (Settings, the startup prompt,
  messaging targeting), never which program opens a link, and nothing is read unless GIO names
  the router.
  [`test_omarchy_s_router_to_vimma_counts_as_default`](../../tests/browser/browser_vimma_app_launcher.js),
  [`test_without_omarchy_s_router_nothing_is_read`](../../tests/browser/browser_vimma_app_launcher.js),
  [`a quoted Exec never counts, since Omarchy's launcher cannot run it`](../../packages/vimma-core/test/default-browser.test.ts),
  [`matches the program by its exact absolute path, never by name or a relative one`](../../packages/vimma-core/test/default-browser.test.ts),
  [`test_the_shell_service_starts_with_the_launcher_next_to_the_binary`](../../tests/browser/browser_vimma_app_launcher.js),
  [`test_an_inherited_value_never_picks_another_program`](../../tests/browser/browser_vimma_app_launcher.js),
  [`test_an_inherited_appdir_never_keeps_another_program`](../../tests/browser/browser_vimma_app_launcher.js),
  [`test_a_shell_service_already_running_is_reported_and_the_value_emptied`](../../tests/browser/browser_vimma_app_launcher.js),
  [`test_startup_named_the_launcher_before_anything_else_started_the_service`](../../tests/browser/browser_vimma_app_launcher.js),
  [`test_the_launcher_is_named_before_the_command_line_runs`](../../tests/browser/browser_vimma_app_launcher.js),
  [`test_an_appimage_keeps_apprun_s_value`](../../tests/browser/browser_vimma_app_launcher.js),
  [`test_make_default_sets_the_package_entry_after_a_late_start`](../../tests/browser/browser_vimma_app_launcher.js),
  [`test_without_the_package_entry_make_default_keeps_firefox_s_way`](../../tests/browser/browser_vimma_app_launcher.js),
  [`test_a_policy_against_make_default_is_left_to_firefox`](../../tests/browser/browser_vimma_app_launcher.js),
  [`test_under_flatpak_make_default_is_left_to_firefox`](../../tests/browser/browser_vimma_app_launcher.js),
  [`test_a_late_start_counts_the_package_entry_as_the_default`](../../tests/browser/browser_vimma_app_launcher.js),
  [`never counts a quoted or escaped program, which it does not parse`](../../packages/vimma-core/test/default-browser.test.ts),
  [`names each package's installed vimma-open by its absolute path in the desktop entry`](../../tools/package/test/package.test.ts)
- O11. Besides Settings' button, the startup prompt and `vimma -setDefaultBrowser`, only the setup
  page's default browser step asks for Make default (spec [setup-v2](../specs/setup-v2.md),
  behaviour 22), and only through Firefox's shell service, so O10 and Firefox's own checks
  apply. It **never** asks where Settings would hide its button: a policy that forbids Make
  default (`DefaultBrowserSettingEnabled`), a locked `pref.general.disable_button.default_browser`,
  or Flatpak; and it asks nothing when Vimma already is the default. No control, MCP or agent
  code can reach the setup host.
  [`set_default_browser_calls_the_shell_service`](../../tests/browser/browser_vimma_setup_moving_in.js),
  [`set_default_browser_respects_the_policy`](../../tests/browser/browser_vimma_setup_moving_in.js),
  [`set_default_browser_respects_the_locked_button_pref`](../../tests/browser/browser_vimma_setup_moving_in.js),
  [`set_default_browser_does_nothing_when_vimma_already_is`](../../tests/browser/browser_vimma_setup_moving_in.js),
  [`asks for Make default and the import wizard only from the setup host`](../../tools/security/test/chrome-source.test.ts)

Allowed: two or more arguments (other than `--from`) pass through unchanged; a local app that
runs `vimma-open` with its own flags could run `vimma` with them directly. Any local program can
also name itself as any program, by `--from`, by the name of its executable or by a chain it
forges (a renamed, detached process): the names are a hint that only selects a workspace a rule
already routes to (R4), the boundary §11 accepts for programs running as you. For the same
reason `VIMMA_BIN`, `VIMMA_OPEN_PROC` and `VIMMA_OPEN_PPID`, which the tests use, are honoured:
they give the caller no more than `--from`, and what they point at comes out only as token names.
[`passes anything but one URL through unchanged`](../../tools/package/test/vimma-open.test.ts)
