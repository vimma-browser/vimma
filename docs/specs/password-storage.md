# Spec: password-storage

Status: accepted · Area: core (`packages/vimma-core/src/config/config.mjs`,
`packages/vimma-core/src/config/defaults.mjs`, `packages/vimma-core/defaults.toml`,
`packages/vimma-core/src/system/setup-steps.mjs`), chrome (`config/ConfigHost.sys.mjs`, a new
`services/Passwords.sys.mjs`), docs (`docs/guide.md`, `docs/limits.md`,
`docs/security/08-config-toml.md`, `docs/security/09-privacy-defaults.md`) · Upstream patches:
none · ADR: none

Issue: [#1616](https://github.com/vimma-browser/vimma/issues/1616)

Engine paths are relative to `engine/` and were read in Firefox 161.0 (`config/milestone.txt`).
Vimma paths are under `src/browser/base/content/vimma/` unless they start with `packages/`,
`tests/` or `docs/`; they were read at commit `5586eaf7`. Anything not confirmed from source is
marked **unverified**.

## Summary

Vimma saves and fills passwords as Firefox does. This spec adds a `[passwords]` table to
`config.toml` that turns the browser's own password saving on or off and chooses whether a saved
login fills into its form as the page loads or only when the user picks it. Both keep Firefox's
defaults. First-run setup asks whether to turn Vimma's saved passwords off, suggests a primary
password to a user who keeps them, and offers password manager extensions the way it offers a
content blocker. The guide gains one section on the choice between Vimma's saved passwords and a
password manager extension, so that a user who keeps passwords elsewhere can make the browser
store none, and a user who keeps them in Vimma knows what protects them.

## Problem

- **No switch in Vimma's own config.** A user who keeps every password in a password manager
  extension (Proton Pass, KeePassXC-Browser, 1Password) and wants the browser to store none has
  to find the checkbox in Firefox's Settings, or `signon.rememberSignons` in `about:config`.
  Every other choice Vimma makes about its own behaviour lives in `config.toml`, which can be
  kept in dotfiles and copied to a new machine.
- **Fill on page load hands the password to the page.** With Firefox's defaults a saved login is
  written into its site's form as soon as the form appears, before the user touches it
  (Research, "Filling"). Any script running on that page, its own or one injected into it, can
  read the field's value.
- **The protection is not obvious.** Without a primary password the saved logins are encrypted
  with a key that is itself protected by nothing, and on Linux `about:logins` shows every
  password without asking for anything (Research, "Storage" and "Re-authentication"). Nothing
  in the guide says so in one place.
- **Turning saving off has a side effect.** The Firefox pref that stops the "Save password?"
  prompt also stops filling the logins already saved (Research, "What the saving pref turns
  off"), so a user who imported passwords from another browser and then turns saving off finds
  that none of them fill.

## Behaviour

1. **`[passwords] save`** (boolean; default `true`) sets Firefox's `signon.rememberSignons`.
   With `save = false` Vimma never offers to save a password and never fills or lists a saved
   login; the logins already stored stay in `about:logins`, unused (decision 7).
2. **`[passwords] fill_on_load`** (boolean; default `true`) sets Firefox's
   `signon.autofillForms`. With `fill_on_load = false` a saved login is not written into a form
   as the page loads; focusing the username or password field opens the list of saved logins,
   and the login fills when the user picks it.
3. **Applied at once.** A change to either key applies when `config.toml` is next read (the
   poll or `:source`), without a restart, to every window and workspace.
4. **Removing a key restores Firefox's behaviour,** and a value the user sets in Firefox's
   Settings (Privacy & Security → Passwords) or in `about:config` wins over `config.toml`
   (decision 2).
5. **First-run setup** gets two steps in the "Essentials" chapter, after "Content blocker"
   (decision 6). When the setup is skipped or left before them, nothing is written and saving
   stays on, as in Firefox.
   - **Password manager**, an action step in the content blocker's style: a curated list of
     password manager extensions (decision 10), `/` searches addons.mozilla.org, `space`
     marks an add-on, and `enter` installs the marked ones, each with Firefox's permission
     prompt. `enter` with nothing marked moves on.
   - **Saved passwords**, a setting step that asks "Turn off passwords saved in Vimma?" with two
     choices, "Keep saving passwords in Vimma" (writes `[passwords] save = true`) and "Turn
     them off" (writes `save = false`). After "Keep saving", when the profile has no primary
     password, the step says what a primary password protects and offers to set one there: a
     key opens Firefox's own primary password dialog over the setup page. When a primary
     password is already set, the step says so and offers nothing more.
6. **The guide** gains a "Saved passwords" section: what Vimma stores and where, what protects
   it with and without a primary password, the two keys, and the trade-off against a password
   manager extension (Docs and changelog).

## Research

### Defaults

- `signon.rememberSignons` defaults to `true` and `signon.autofillForms` to `true`
  (`modules/libpref/init/all.js:2961-2962`). Firefox does not fill on an `http:` page
  (`signon.autofillForms.http` `false`, `all.js:2964`). Vimma's branding prefs change none of
  these; the only `signon.*` pref Vimma sets is `signon.firefoxRelay.feature`
  (`src/browser/branding/vimma/pref/firefox-branding.js:123`).
- Settings shows both prefs as checkboxes (`browser/components/preferences/privacy.inc.xhtml:427`
  and `:433`), and they sync with Firefox Sync
  (`browser/app/profile/firefox.js:1932` and `:1935`).

### Storage

- Vimma is built on the update channel `vimma` (`mozconfig:124`, the `--enable-update-channel`
  line), which is neither `release` nor `esr`, so `signon.storage.rust.enabled` is
  `true` in Vimma builds (`all.js:2995-2999`). Saved logins are therefore migrated to the Rust
  login store, `logins.db` in the profile (`toolkit/components/passwordmgr/storage-rust.sys.mjs:576`),
  whose entries are encrypted with the NSS key in `key4.db`
  (`createLoginStoreWithNssKeymanager`, `storage-rust.sys.mjs:584`). The JSON store
  (`logins.json`, `storage-json.sys.mjs:108`) is still opened at every start
  (`storage-desktop.sys.mjs:28-30`); whether it keeps a copy after migration was not checked.
  Documentation that names only `logins.json` is out of date for Vimma.
- The `key4.db` key is protected by the primary password when one is set
  (`LoginHelper.isPrimaryPasswordSet`, `passwordmgr/LoginHelper.sys.mjs:1545-1549`). Without one
  it opens with no password, so anything that can read the profile folder, a program running as
  the user or a copy of the profile, can decrypt the logins. This follows from NSS's design and
  matches `docs/limits.md:214`; it was checked in source, not by decrypting a profile.

### Re-authentication

- `OSKeyStore.canReauth()` returns `true` only on Windows and macOS, with the comment "We have no
  support on linux (bug 1527745)" (`toolkit/modules/OSKeyStore.sys.mjs:73-83`).
- `LoginHelper.requestReauth` treats a profile with no primary password and no OS
  re-authentication as authorised at once (`LoginHelper.sys.mjs:1679-1693`), and
  `getOSAuthEnabled()` is `false` whenever `canReauth()` is (`LoginHelper.sys.mjs:1557-1560`).
  So on Linux without a primary password, `about:logins` reveals, copies and exports passwords
  without asking. With a primary password it asks for that password.

### Filling

- Firefox handles `DOMFormHasPassword` and `DOMInputPasswordAdded`
  (`passwordmgr/LoginManagerChild.sys.mjs:1474-1487`, registered in
  `toolkit/modules/ActorManagerParent.sys.mjs:446-448`), so a password field a script adds after
  the page loaded is filled like one in the original page.
- `loginsFound` fills only when `LoginHelper.autofillForms` is set and the window is not private
  (`LoginManagerChild.sys.mjs:2104-2113`); otherwise `_fillForm` stops with
  `NO_AUTOFILL_FORMS` and fills nothing (`LoginManagerChild.sys.mjs:2992-2996`). The list on
  focus still offers the logins, and picking one fills it (`onFieldAutoComplete`,
  `LoginManagerChild.sys.mjs:2119`).
- A fill the user did not trigger is refused in a cross-origin subframe and uses only logins
  saved for the form's exact origin (`LoginManagerChild.sys.mjs:2836-2849`). The list shown on
  focus is wider: it also offers logins for other subdomains of the same site
  (`signon.includeOtherSubdomainsInLookup` `true`, `all.js:2984`, used in
  `passwordmgr/LoginManagerParent.sys.mjs:707` and `:794`). Built-in filling matches the exact
  site for the fill on page load, not for the list a user picks from.
- A filled value is an ordinary field value; Firefox has no step that hides it from the page's
  scripts until the user interacts (none was found in `LoginManagerChild.sys.mjs`; **unverified**
  by a test page).

### What the saving pref turns off

`signon.rememberSignons` is read into `LoginHelper.enabled` (`LoginHelper.sys.mjs:454`), and that
flag gates far more than the save prompt: fetching logins to fill a form
(`#fetchLoginsFromParentAndFillForm`, `LoginManagerChild.sys.mjs:1983-1986`), the field event
handlers (`LoginManagerChild.sys.mjs:118-120`), filling a picked login
(`LoginManagerChild.sys.mjs:2119-2122`), offering the list on focus (`shouldSearchForAutoComplete`,
`LoginManagerChild.sys.mjs:3216-3218`) and generated passwords
(`LoginManagerParent.sys.mjs:908`). With saving off, logins already stored, imported ones included, neither fill nor appear in the list. They stay readable
and copyable in `about:logins`.

### Vimma's config and setup today

- `config.toml` is read by `ConfigHost.sys.mjs`, validated and resolved by
  `packages/vimma-core/src/config/config.mjs`, and applied in `apply()`
  (`config/ConfigHost.sys.mjs`) ([m5-config-load](m5-config-load.md)). A config key that sets a
  Firefox pref already exists: `[tabs] sleep_on_low_memory` sets
  `browser.tabs.unloadOnLowMemory` on the default branch, so that nothing is written to
  `prefs.js` and a value set in `about:config` still wins (`services/TabSleep.sys.mjs`,
  `applyUnloadPref`; [tab-sleep](tab-sleep.md) decision 21).
- `LoginHelper` observes the whole `signon.` branch and rereads its cached values on any change
  (`LoginHelper.sys.mjs:434`), so a pref set at run time applies to the next form without a
  restart.
- Firefox's Settings sets the primary password through
  `PasswordSettingHelpers.changeMasterPassword`
  (`browser/components/preferences/config/passwords-autofill.mjs:74-106`), which opens
  `chrome://mozapps/content/preferences/changemp.xhtml` with `gSubDialog`, and first asks for OS
  authentication only where `LoginHelper.getOSAuthEnabled()` is true, never on Linux (bug
  1527745).
- First-run setup is now the chapter flow of [setup-v2](setup-v2.md), which replaced the summary
  flow of [first-run-setup](first-run-setup.md). Its steps are data in
  `packages/vimma-core/src/system/setup-steps.mjs`; a setting step writes its `config.toml` keys
  when the user presses `enter` on a choice, through the one edit queue that
  [docs/security/08-config-toml.md](../security/08-config-toml.md) F1 describes. The "Moving in"
  chapter holds "Default browser" and "Bring your data". The setup is offered once per profile
  (`setup/SetupHost.sys.mjs`, `offer`) and can be left at any step.
- The "Essentials" chapter opens with the "Content blocker" action step
  ([setup-v2](setup-v2.md) behaviour 19): a curated list (uBlock Origin, AdGuard AdBlocker,
  Privacy Badger) with a live addons.mozilla.org search on `/`, and installs through
  `installAddonFromAOM`, each with Firefox's permission prompt
  ([first-run-setup](first-run-setup.md) decisions 3, 4 and 6). The import wizard of "Bring your
  data" opens as a tab dialog over the setup page (setup-v2 decision 17).
- Saved passwords are shared by every workspace: containers keep cookies and site data apart, not
  saved logins (`docs/limits.md:84-85`).

### Password manager extensions

Extensions that fill passwords need a content script on every site they fill, so they hold host
permission for all sites and draw their fill menus inside the page. In exchange they lock their
vault behind their own password, sync across browsers and devices, and do not depend on the
profile's `key4.db`. These are properties of the WebExtension model; the permissions and lock
behaviour of each named extension were not checked (**unverified**).

Read on addons.mozilla.org's public API (`api/v5/addons/addon/<slug>/`) for the password manager
step (decision 10):

| Add-on            | Slug                           | Add-on ID                                    | Licence on AMO              | Badge       | Daily users |
| ----------------- | ------------------------------ | -------------------------------------------- | --------------------------- | ----------- | ----------- |
| Bitwarden         | `bitwarden-password-manager`   | `{446900e4-71c2-419f-a6a7-df9c091e268b}`     | Bitwarden License Agreement | Recommended | about 1.07M |
| Proton Pass       | `proton-pass`                  | `78272b6fa58f4a1abaac99321d503a20@proton.me` | GPL-3.0-only                | none        | about 203k  |
| KeePassXC-Browser | `keepassxc-browser`            | `keepassxc-browser@keepassxc.org`            | GPL-3.0-only                | none        | about 160k  |
| 1Password         | `1password-x-password-manager` | `{d634138d-c276-4fc8-924b-40a0ea21d284}`     | all rights reserved         | Spotlight   | about 387k  |

KeePassXC-Browser fills only with the KeePassXC desktop application installed and connected; the
others work with their own account.

## Design

1. **Two independent keys under `[passwords]`, one per Firefox pref** (decision 9).
   `save` maps to `signon.rememberSignons` and `fill_on_load` to `signon.autofillForms`, so that
   each key does exactly what the Firefox pref it names does, the guide can point to Firefox's own
   documentation for the details, and a user who knows the prefs can predict the result.
2. **Applied on the default branch.** `services/Passwords.sys.mjs` sets both prefs on the
   default branch from the resolved config, as `[tabs] sleep_on_low_memory` does, because then
   nothing is written to `prefs.js`, removing the key returns Firefox's default, and the Settings
   checkboxes and `about:config` keep working and win, as a user who changed them there expects.
   Rejected: writing user values, because Vimma would then overwrite a choice made in Settings
   at every config read and leave its own value in `prefs.js` after the key is removed.
3. **No restart.** The prefs are set in `ConfigHost`'s `apply()`, at startup and on each read,
   so that a change applies to the next form, since `LoginHelper` rereads the `signon.` branch on
   every change (Research).
4. **Saving off does not delete anything.** Turning `save` off only changes a pref, because a
   config switch is easily flipped and deleting stored passwords cannot be undone.
5. **The saved passwords step is a setting step like the others,** written through the existing
   setup edit path, so that it inherits F1's guarantees (one edit queue, atomic write, never from
   a private window) and adds no new way for a page to change `config.toml`.
6. **Saving stays on by default, and first-run setup asks whether to turn it off.** `save`
   defaults to `true`; the setup's saved passwords step offers to turn it off, suggests a primary
   password to a user who keeps saving on and lets them set it in the same step, and the setup
   offers password manager extensions in a step of the content blocker's kind. Because a user
   without a password manager who cannot save passwords tends to reuse them, saving stays
   available; because the setup asks, keeping or dropping it is an explicit choice; and because
   the saved logins are readable by anything that reads the profile until a primary password is
   set, a user who keeps them is guided to protect them. A skipped setup leaves saving on, as in
   Firefox, so that imported logins keep filling. Both steps sit in "Essentials" after "Content
   blocker", because a password manager is an add-on installed the same way, so a user installs
   it in the same sitting as the content blocker, and the saved passwords question comes after
   it because its answer depends on whether a manager was just installed. The primary password
   is set through Firefox's own dialog (`changemp.xhtml`), opened as a tab dialog over the setup
   page as the import wizard is, because that dialog already checks and stores the password and
   Vimma adds no password handling of its own. Rejected: saving off by default, because it
   silently stops imported logins from filling; a setup choice between "a password manager" and
   "Vimma saves them" alone, because it neither installs the manager nor protects the stored
   logins.
7. **Logins already saved stay, unused, when saving is turned off,** and the guide points to
   `about:logins` to export or remove them, because deleting stored passwords from a config
   switch is hard to undo and a user who turns saving back on gets them back. Rejected: offering
   an export or removal from Vimma, because `about:logins` already does both.
8. **Fill on page load keeps Firefox's default (`fill_on_load = true`),** because it is the
   behaviour Firefox users know and a saved login is ready without a key. The trade-off, that a
   script on the page can read a password filled this way, is stated in the guide's "Saved
   passwords" section with the key that turns it off. Rejected: `false` by default, because it
   changes a familiar behaviour for every user rather than for those who choose it.
9. **Two keys, `[passwords] save = true` and `fill_on_load = true`,** because the two settings
   are independent and each maps one-to-one to a Firefox pref (decision 1), with defaults
   matching decisions 6 and 8. Rejected: one `[passwords] manager = "browser" | "none"`, because
   it cannot express filling on choice while saving stays on.

10. **The password manager step lists Bitwarden, Proton Pass and KeePassXC-Browser,** because
    they are well-known password managers with published source (Proton Pass and
    KeePassXC-Browser GPL-3.0 on AMO; Bitwarden's client source is public, under the licence AMO
    links, **unverified** beyond that listing), and between them they cover a hosted account
    (Bitwarden, Proton Pass) and a local vault with no account (KeePassXC); any other manager,
    1Password included, stays one `/` search away. Rejected: Bitwarden alone, the only one AMO
    marks "Recommended", because it leaves out a local vault for a user who wants no account;
    adding 1Password, because its add-on is not published under an open licence ("all rights
    reserved" on AMO) and the list stays short.

## Security and privacy

- **Exposure.** The keys only narrow or restore Firefox's own behaviour; neither exposes a
  password. With `fill_on_load = false`, which a user chooses (decision 8), a page script can no
  longer read a login that the user did not pick. With `save = false` the browser stops adding
  passwords to a store that, without a
  primary password, any program running as the user can read.
- **Who can change it.** `config.toml` is the user's file (F1 to F3); the setup step writes it
  only through F1's setup path. A page cannot set these prefs.
- **Setup installs and dialogs.** The password manager step installs only through the content
  blocker's path (`installAddonFromAOM`, AMO-signed files, Firefox's permission prompt), so
  [docs/security/05-add-ons.md](../security/05-add-ons.md) covers it as it covers the content
  blocker. The primary password is typed into Firefox's own dialog; the setup page never sees
  it.
- **Not a boundary.** Saved logins remain shared by every workspace; this spec does not change
  that (`docs/limits.md:84-85`).
- **Docs.** The implementing pull request adds the password defaults to
  [docs/security/09-privacy-defaults.md](../security/09-privacy-defaults.md) as a new item with
  its tests, and names the saved passwords and password manager steps among F1's setup steps in
  [docs/security/08-config-toml.md](../security/08-config-toml.md).

## Tests

- Vitest (`packages/vimma-core/test/config-passwords.test.ts`):
  `[passwords] save and fill_on_load resolve to their defaults when absent`,
  `a non-boolean save or fill_on_load is an error with its line`,
  `an unknown key in [passwords] is a warning`.
- Vitest (`packages/vimma-core/test/config-passwords.test.ts`):
  `save and fill_on_load default to true`.
- Vitest (`packages/vimma-core/test/setup-steps.test.ts`):
  `the saved passwords step writes save = true to keep and save = false to turn off`,
  `the password manager step follows the content blocker in essentials`,
  `the password manager step lists the curated password managers`.
- Mochitest (`tests/browser/browser_vimma_passwords.js`):
  `save_false_sets_remember_signons_on_the_default_branch`,
  `fill_on_load_false_leaves_a_saved_login_unfilled_until_it_is_picked`,
  `fill_on_load_true_fills_a_saved_login_as_the_page_loads`,
  `a_value_set_in_settings_wins_over_config_toml`,
  `removing_the_key_restores_firefoxs_default`,
  `a_config_change_applies_without_a_restart`.
- Mochitest (`tests/browser/browser_vimma_setup_v2_essentials.js`):
  `the_saved_passwords_step_saves_its_choice_to_config_toml`,
  `keeping_saved_passwords_offers_the_primary_password_dialog_when_none_is_set`,
  `the_primary_password_offer_is_absent_when_one_is_set`,
  `the_password_manager_step_installs_with_the_permission_prompt`,
  `a_skipped_setup_leaves_saving_on`.

## Docs and changelog

- `docs/guide.md`: a "Saved passwords" section under "Privacy defaults", covering what is stored
  (`logins.db` and `key4.db` in the profile), the primary password and how to set it
  (Settings → Privacy & Security → Passwords → Use a primary password), that Linux has no system
  password prompt for `about:logins`, the two keys, that a script on the page can read a password
  filled as the page loads and `fill_on_load = false` stops that, that logins saved before
  `save = false` stay in `about:logins` to export or remove, and the trade-off against a password
  manager extension. "First-run setup" names the two new steps. "Moving over from Firefox or
  Chrome" notes that imported passwords fill only while `save` is on.
- `docs/limits.md`: the Linux `about:logins` limit, beside the existing note on shared saved
  passwords.
- `defaults.toml` and `docs/bindings.md` regenerated with `npm run gen-docs`.
- `CHANGELOG.md`, from the commit subject, for example
  `feat(passwords): [passwords] save and fill_on_load in config.toml`.

## Delivery

1. The `[passwords]` keys, `services/Passwords.sys.mjs`, the security items and the guide
   section. A new config key stops this pull request at ready for the maintainer.
2. The two setup steps, password manager and saved passwords, with the primary password offer.

## Open questions

None.
