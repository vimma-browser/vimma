#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# A stand-in for a version manager's program (mise, asdf, volta) in
# browser_vimma_agent_cli_run.js (docs/specs/builtin-agent-cli.md C4): its shims are links
# named like a tool, and it picks the tool by the name it was started as. Started as `claude`
# it runs the fake CLI beside it; started under its own name with Claude Code's arguments, it
# fails as mise's argument parser does.
import os
import sys

name = os.path.basename(sys.argv[0])
if name == "claude":
    here = os.path.dirname(os.path.realpath(__file__))
    cli = os.path.join(here, "fake_vimma_agent_cli.py")
    os.execv(sys.executable, [sys.executable, cli] + sys.argv[1:])
sys.stderr.write(
    f"error: unexpected argument '{sys.argv[1] if len(sys.argv) > 1 else ''}' found\n\n"
    f"Usage: {name} [OPTIONS] [COMMAND]\n\nFor more information, try '--help'.\n"
)
sys.exit(2)
