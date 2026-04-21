---
name: status
description: Show the current Lens status for this directory.
allowed-tools: Bash(lens:*)
---

Before running the CLI, verify:
1. `lens` binary is on PATH. If `command -v lens` returns non-zero, tell the user: "lens CLI not found. Install with `npm i -g lens-engine`."
2. `.lenses/config.yaml` exists (use `Bash` tool to test `-f .lenses/config.yaml`). If not, tell the user: "No `.lenses/config.yaml` found. Run `/lens:init` first."

Then run:

    lens status

Stream the CLI's stdout/stderr to the user. If it exits non-zero, surface the error clearly.
