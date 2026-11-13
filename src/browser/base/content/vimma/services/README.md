# `vimma/services/`

Process-wide adjustments to Firefox, each on its own: the app launcher name
(`AppLauncher.sys.mjs`), Mozilla service defaults (`MozillaServices.sys.mjs`), the wake lock
while a video plays (`WakeLock.sys.mjs`), and no downloads panel for a download Firefox shows in
a tab of its own (`ViewedDownloads.sys.mjs`).

**Entry points:** each module's `init()`, called once by `vimma.js`; the app launcher first,
before anything starts Firefox's shell service.

**May import (layer 1, [ADR-026](../../../../../../docs/adr/026-module-layering.md)):** `core/` only.

**Read more:** [m0-mozilla-services](../../../../../../docs/specs/m0-mozilla-services.md),
[wake-lock](../../../../../../docs/specs/wake-lock.md), [downloads](../../../../../../docs/specs/downloads.md).
