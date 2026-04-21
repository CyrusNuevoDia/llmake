---
name: init
description: Initialize a Lens setup in the current directory.
allowed-tools: Bash(lens:*)
argument-hint: [description] [--template <name>]
---

Before running the CLI, verify:
1. `lens` binary is on PATH. If `command -v lens` returns non-zero, tell the user: "lens CLI not found. Install with `npm i -g lens-engine`."

Then run (passing arguments through verbatim):

    lens init $ARGUMENTS

Stream the CLI's stdout/stderr to the user. If it exits non-zero, surface the error clearly.
