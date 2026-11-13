# `vimma/updates/`

Vimma's update check and the AppImage's self-update (`VimmaUpdates.sys.mjs`): it fetches the
signed manifest from `updates.vimma.dev`, checks it against the pinned keys in vimma-core, and
says when a newer version is out.

**Entry points:** `VimmaUpdates`, started by `vimma.js`; the host shows its notices
(`host/update-ui.mjs`).

**May import (layer 1, [ADR-026](../../../../../../docs/adr/026-module-layering.md)):** `core/` only.

**Security:** a security-sensitive module; [docs/security.md](../../../../../../docs/security.md) section 16 is
its contract.

**Read more:** [Updates and release](../../../../../../docs/architecture/updates-and-release.md),
[m6a-updater](../../../../../../docs/specs/m6a-updater.md).
