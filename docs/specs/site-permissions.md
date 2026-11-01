# Spec: site-permissions

Status: implemented · Area: core (`packages/vimma-core/src/sitepermissions.mjs`, `picker.mjs`,
`cmdline.mjs`, `actions.mjs`), host (`host/permission-ops.mjs`, `VimmaHost`), UI
(`ui/picker.mjs`) · Upstream patches: none · ADR: none

Issue: [#684](https://github.com/vimma-browser/vimma/issues/684)

## Summary

`:site` (or `:permissions`) opens a picker over the selected tab's site permissions: every
permission Firefox's Page Info lists, with the state Firefox has for this site. `a`, `b` and `r`
allow, block or reset the selected one, and `Enter` steps to its next state, all through
Firefox's own `SitePermissions` module. Checking or changing what a site may do no longer needs
the mouse.

## Problem

Firefox shows a site's permissions in the site information panel (the padlock in the address
bar) and in Page Info's Permissions tab. Both are mouse-first: the panel lists only the
permissions already set, and Page Info is a separate window of radio buttons. With the toolbar
hidden there is no padlock to click at all. A keyboard user cannot see whether a site may use
the camera, or take back a location permission, without leaving the keyboard.

## Behaviour

1. `:site` and `:permissions` open the site permissions picker for the selected tab. It has no
   default key; `site_permissions` can be bound in `config.toml`.
2. The heading names the site (`Site permissions · example.com`); in the private workspace it
   adds `private: until the private workspace closes`.
3. The picker lists every permission Page Info lists, sorted by Firefox's label. Each row shows
   Firefox's label for the state in effect, then how long a site setting lasts (`temporary`,
   `this session`, `set by policy`), or `default` when the site has no setting of its own, and
   `locked` when a locked pref decides it. A `●` marks a row the site has its own setting for.
4. `a` allows, `b` blocks, `r` resets the selected permission to the default; `Enter` steps to
   the next of the states Firefox offers for it. The picker stays open and the row shows the new
   state. `/` searches by label; `Esc` or `q` closes.
5. A state Firefox does not offer for a permission is refused with a notice (`Share the screen
cannot be set to allow`), and so is `r` on a row that has no site setting.
6. A row set by policy or locked by a pref is read only: every key is refused with a notice.
7. The picker acts only on the page it was opened for: when the tab goes to another page while
   it is open, a key closes it with `the page changed: run :site again`, and selecting another
   tab closes it.
8. On a page without site permissions (`about:blank` and other `about:` pages), `:site` says
   `this page has no site permissions` and opens nothing.
9. In the agent workspace, `:site` says
   `site permissions are not changed in the agent workspace` and opens nothing.

## Research

Checked against Firefox 159.0 (`FIREFOX_159_0_RELEASE`):

- `browser/modules/SitePermissions.sys.mjs` is the module behind both of Firefox's permission
  surfaces. `listPermissions()` gives every known permission; `getPermissionLabel(id)` its
  label; `getAvailableStates(id)` the states it may take, in the order Firefox shows them;
  `getDefault(id)` its default; `getMultichoiceStateLabel(id, state)` a state's label;
  `getForPrincipal(principal, id, browser)` the state in effect and its scope (persistent,
  session, policy, or temporary for the tab); `getAllForBrowser(browser)` adds the globally
  blocked ones (`SCOPE_GLOBAL`); `isSupportedPrincipal(principal)` is true only for `http`,
  `https`, `moz-extension` and `file` content principals.
- `browser/base/content/pageinfo/permissions.js` (Page Info's Permissions tab) lists every
  permission with a label but `open-protocol-handler`, changes one with
  `SitePermissions.setForPrincipal(principal, id, state)` and resets one with
  `SitePermissions.removeFromPrincipal(principal, id)`. It disables a row whose scope is
  `SCOPE_POLICY` or `SCOPE_GLOBAL`, and a row whose default pref is locked: `xpinstall` not
  allowed by policy for `install`, `dom.disable_open_during_load` for `popup`,
  `media.autoplay.default` for `autoplay-media`, `network.cookie.cookieBehavior` for `cookie`,
  and `permissions.default.<id>` for `geo`, `desktop-notification`, `camera`, `microphone`,
  `xr` and `screen`. For `cookie` with no site permission it selects no state, because the
  site's cookies follow the cookie settings rather than one state.
- `setForPrincipal` stores a persistent permission (a session one in a private window, by the
  permission manager), and removes the site's entry when the state is the default.
  `removeFromPrincipal` with the tab's browser also drops a temporary permission for that tab.
- Vimma sets `permissions.isolateBy.userContext` (`src/browser/branding/vimma/pref/`
  `firefox-branding.js`), so a permission is kept per container, and so per workspace: the
  principal of the selected tab carries its workspace's container.

## Design

The picker is the `GotoPicker` dialog (`ui/picker.mjs`) with a new item kind, `permission`.
Core `sitepermissions.mjs` turns `PermissionRecord`s, read by the host from `SitePermissions`,
into rows, and decides what a key asks for (`permissionPlan`). The host, `host/permission-ops.mjs`,
records the page the picker was opened for, reads the records, and applies a plan with one
`SitePermissions` call.

1. **`:site` and `:permissions`, no default key.** The picker opens from the command line only,
   because a default key is a keymap change that needs its own review, and every free `prefix`
   letter that fits is taken (`prefix+shift+p` opens the private workspace). Rejected:
   `ctrl+b P`, because it is taken. Users can bind `site_permissions`.
2. **Page Info's list, not only the set permissions.** Every row Page Info shows is listed, so
   that a permission can be blocked before the site asks for it, and a user sees the default
   for each. Rejected: the site information panel's list of set permissions only, because it
   cannot pre-block.
3. **Firefox's code paths only.** A change is one call, `SitePermissions.setForPrincipal` (allow,
   block, next) or `SitePermissions.removeFromPrincipal` (reset), the calls Page Info makes, so
   that Firefox stores, scopes, notifies and removes the permission as it does for its own UI.
   Vimma writes no permission directly through `Services.perms`.
4. **Firefox's states and labels.** `a` and `b` are offered only when Firefox offers allow or
   block for that permission, and `Enter` steps through `getAvailableStates` in Firefox's order,
   because a state Firefox does not offer (allow for screen sharing) is one its prompts would
   never set. Labels come from `getPermissionLabel` and `getMultichoiceStateLabel`, so rows read
   as Firefox's own surfaces do and follow its localisation.
5. **The real state.** A row shows `getForPrincipal` with the tab's browser, so a temporary
   permission given to this tab shows, and a globally blocked one (`SCOPE_GLOBAL`) overrides it,
   as the site information panel does. Cookies with no site permission show `Firefox's cookie
settings`, because, as in Page Info, no single state describes them.
6. **Policy and locked prefs are read only.** A row with `SCOPE_POLICY` or `SCOPE_GLOBAL`, or
   whose pref Page Info treats as locking it, refuses every key, because an administrator's
   policy or a locked pref decides it and Page Info disables the same rows.
7. **Only the page it was opened for.** The host keeps the browser and the content principal
   it opened for, and every key checks that the selected browser is that browser and its
   principal equals that principal; otherwise the picker closes, so that a page that navigates
   or redirects under the picker never gets a permission meant for the page before. Selecting
   another tab closes the picker too.
8. **Never in the agent workspace.** `:site`, and every key, refuse when the selected tab's
   container or its page's principal is the agent workspace's, because a permission there would
   act on pages an agent drives. Agents cannot open the picker: no control or MCP command
   reaches it, and agent keys are a fixed list without it.
9. **Per workspace.** A change applies to the site in the tab's workspace only, because Vimma
   isolates permissions by container; the private workspace's last until it closes, because a
   private window keeps permissions for its session only.

## Security and privacy

The picker changes what a site may do (camera, microphone, location, notifications), so it is
in `docs/security.md` §19 (rules SP1 to SP5). Only you reach it, with `:site` or a key you
bind. No control-socket or MCP command reaches it, and agent keys cannot. It shows only the
selected page's permissions, which the site information panel shows already, and stores
nothing of its own.

## Tests

- Vitest (`packages/vimma-core/test/sitepermissions.test.mjs`): rows, scope and lock words, the
  keys, refusals, `next` order, the heading, `:site` and `:permissions`, no default key.
- Vitest (`tools/security/test/chrome-source.test.mjs`):
  `changes a site permission only from the site permissions picker`.
- Mochitest (`tests/browser/browser_vimma_site_permissions.js`): every Page Info permission
  with its real state; keys change it through Firefox and the row follows; a state Firefox
  does not offer is refused; a locked default is read only; it acts only on the page it was
  opened for; a page without site permissions says so; the agent workspace refuses and grants
  nothing.

## Docs and changelog

`docs/guide.md`: "Site permissions" section and the `:site` row of the command table;
`docs/security.md` §19. The changelog line is the commit subject.

## Delivery

One pull request: tests, core, host, UI and docs.

## Open questions

None.
