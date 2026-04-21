---
name: add
description: Append a new lens to lens.yml and generate its initial content.
allowed-tools: Bash(lens:*)
argument-hint: <name> --description "<text>" [--path <path>]
---

Before running the CLI, verify:
1. `lens` binary is on PATH. If `command -v lens` returns non-zero, tell the user: "lens CLI not found. Install with `npm i -g lens-engine`."
2. `lens.yml` exists (use `Bash` tool to test `-f lens.yml`). If not, tell the user: "No `lens.yml` found. Run `/lens:init` first."

The CLI requires `<name>` and `--description "<text>"`; it will exit non-zero with a clear error if either is missing. Run (passing arguments through verbatim):

    lens add $ARGUMENTS

Stream the CLI's stdout/stderr to the user. If it exits non-zero, surface the error clearly.
