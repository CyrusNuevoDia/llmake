---
name: mark
description: Advance refs/lens/synced or refs/lens/applied to HEAD.
allowed-tools: Bash(lens:*)
argument-hint: <synced|applied>
---

Run `lens mark $ARGUMENTS` via Bash (pass arguments through verbatim — the
CLI handles the `<synced|applied>` validation and prints a usage error if
missing or unknown).

Stream the CLI's stdout/stderr to the user. If it exits non-zero, surface
the error clearly.
