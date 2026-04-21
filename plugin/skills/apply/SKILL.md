---
name: apply
description: Make the codebase match the lenses via Claude Code plan mode.
allowed-tools: Bash(lens:*) EnterPlanMode
---

1. Prereqs: `lens` on PATH, `.lenses/config.yaml` exists (if not, tell user and stop).
2. Run `lens apply --dry-run` via Bash. Capture stdout — this is the context bundle.
3. Invoke the `EnterPlanMode` tool with a plan prompt consisting of:

   ---
   You are about to make code changes that bring the codebase in line with the lens artifacts below. Focus on the deltas since the last apply; ignore unchanged lenses unless their current implementation is broken.

   <paste the captured bundle here, verbatim>
   ---

4. After the user exits plan mode (plan accepted + changes applied):
   - Run `git status --porcelain` via Bash.
   - If empty AND HEAD has advanced past refs/lens/applied, run `lens mark-applied`.
   - Else, tell the user: "Commit your changes, then run `/lens:mark applied` to advance the ref."
