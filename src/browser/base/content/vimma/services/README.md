# `vimma/services/`

Process-wide adjustments to Firefox, each on its own: the app launcher name
(`AppLauncher.sys.mjs`), Mozilla service defaults (`MozillaServices.sys.mjs`), the wake lock
while a video plays (`WakeLock.sys.mjs`), no downloads panel for a download Firefox shows in a
tab of its own (`ViewedDownloads.sys.mjs`), and tabs put to sleep after a time unseen
(`TabSleep.sys.mjs`, which learns the config, the agent connections and the panes on screen
from what `vimma.js` hands its `init`), and Firefox's password saving and fill on page load from `[passwords]`
(`Passwords.sys.mjs`, which `ConfigHost` calls after each read of `config.toml`).

**Entry points:** each module's `init()`, called once by `vimma.js`; the app launcher first,
before anything starts Firefox's shell service. `Passwords.configure()`, called by
`config/ConfigHost.sys.mjs`.

**May import (layer 1, [ADR-026](../../../../../../docs/adr/026-module-layering.md)):** `core/` only.

**Read more:** [m0-mozilla-services](../../../../../../docs/specs/m0-mozilla-services.md),
[wake-lock](../../../../../../docs/specs/wake-lock.md), [downloads](../../../../../../docs/specs/downloads.md),
[tab-sleep](../../../../../../docs/specs/tab-sleep.md),
[password-storage](../../../../../../docs/specs/password-storage.md).
