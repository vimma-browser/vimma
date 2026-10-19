# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Replaces the file Surfer writes from surfer.json (src/ is linked over the engine after the
# branding step). macOS names the app bundle <distribution id>.<MOZ_MACBUNDLE_ID>, and
# configs/macos/mozconfig sets the distribution id to dev.vimma, so the bundle is
# dev.vimma.browser, surfer.json's appId (spec macos-homebrew, open question 4). Linux reads
# only MOZ_APP_DISPLAYNAME from this file.
MOZ_APP_DISPLAYNAME="Vimma"
MOZ_MACBUNDLE_ID="browser"
