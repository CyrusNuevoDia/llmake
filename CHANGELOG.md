# Changelog

## Unreleased

### Breaking

- Config file moved from `.lenses/config.yaml` to `lens.yml` at the repo root. Discovery order is now `lens.yml` → `lens.yaml` → `lens.jsonc` → `lens.json`.
- Lockfile moved from `.lens/lock.json` to `.lenses/lock.json`.
- Transient conflicts file moved from `.lens/conflicts.md` to `.lenses/conflicts.md`.
- The `.lens/` directory is gone — everything tool-owned except the config now lives inside `.lenses/` alongside the prose lens files.

## 0.1.0 — Initial public release (2026-04-21)

First public release of `lens-engine`. Ships a CLI (`lens`) and Claude Code plugin for keeping prose "lens" artifacts in sync with each other and with the code.

### CLI verbs

- `lens init [description] [--template <name>]` — scaffold `lens.yml` + `.lenses/` from one of six starter templates and generate initial lens content via your configured runner.
- `lens sync` — propagate edits across the lens set. Emits structured `<lens-conflict>` blocks when propagation is ambiguous.
- `lens pull` — reflect code changes back into the lenses. Per-lens `pullSources` globs; falls back to git-tracked files.
- `lens apply` / `lens diff` — assemble a context bundle (intent + lenses + code diff) for a downstream coding agent. The plugin wires this into Claude Code plan mode.
- `lens add <name> --description "..."` — append a lens to the config (YAML-formatting-preserving) and generate its initial content.
- `lens status` — drift report against `refs/lens/synced` and `refs/lens/applied`.
- `lens validate` — sanity-check the config.
- `lens mark <synced|applied>` — advance either git ref to `HEAD`.

### State model

- Two git refs — `refs/lens/synced` (horizontal lens ↔ lens consistency) and `refs/lens/applied` (vertical lens ↔ code consistency) — advance automatically on clean trees. On dirty trees the verb prints commit-then-`lens mark` guidance.
- Lockfile at `.lenses/lock.json` — content-addressed hashes per task (`generate`, `sync`, `pull`). Commit it.

### Runner contract

- Config field `runner:` is a shell command containing `{prompt}`. Lens substitutes a shell-escaped prompt and invokes via a login shell so your `$PATH` is loaded.
- Shipped default (all six templates): `claude --allowed-tools Read,Write,Edit,Bash,Grep,Glob --permission-mode acceptEdits --print {prompt}`.
- `LENS_RUNNER_OVERRIDE` env var swaps the runner for a single invocation (tests/ops).

### Templates

`webapp`, `cli`, `library`, `pipeline`, `protocol`, `blank` — all six embedded into the compiled binary as a filesystem-fallback.

### Claude Code plugin

- Seven skills: `init`, `sync`, `pull`, `apply`, `add`, `mark`, `status`.
- `/lens:init` with no description argument surveys the repo, proposes a template, and drafts the intent — like Claude's `/init`.
- `/lens:apply` opens plan mode with the apply bundle, then auto-advances `refs/lens/applied` when the working tree is clean post-plan.

### Exit codes

`0` success · `1` operation failed · `2` config missing or invalid · `3` git state incompatible.
