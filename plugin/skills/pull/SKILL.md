---
name: pull
description: Reflect code changes back into the lens files.
allowed-tools: Bash(lens:*)
---

Before running the CLI, verify:
1. `lens` binary is on PATH. If `command -v lens` returns non-zero, tell the user: "lens CLI not found. Install with `npm i -g lens-engine`."
2. `.lenses/config.yaml` exists (use `Bash` tool to test `-f .lenses/config.yaml`). If not, tell the user: "No `.lenses/config.yaml` found. Run `/lens:init` first."

Then run (passing arguments through verbatim):

    lens pull $ARGUMENTS

`lens pull` invokes the configured runner (an LLM session) and can take a minute or more on larger repos. Stream the CLI's stdout/stderr to the user. If it exits non-zero, surface the error clearly.
