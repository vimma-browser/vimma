/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Where Vimma's update certificates (primary.der, secondary.der) are committed, relative to the
 * repository root. A module of its own so `npm run import` (tools/import/link-update-certs.mjs),
 * which the release build runs, reads the path without the certificate tools.
 */
export const CERT_DIR = "configs/updater";
