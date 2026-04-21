---
name: mark
description: Advance refs/lens/synced or refs/lens/applied to HEAD.
allowed-tools: Bash(lens:*)
argument-hint: <synced|applied>
---

Parse $0:
- If "$0" == "synced": run `lens mark-synced`
- If "$0" == "applied": run `lens mark-applied`
- Else: tell the user "Usage: /lens:mark <synced|applied>" and stop.
