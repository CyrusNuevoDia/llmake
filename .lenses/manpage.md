# lens(1) — man page

Derived without drift from `commands.md`, `flags.md`, `scenarios.md`, and
`exit-codes.md`. Language, option list, and exit-status table must match
those lenses verbatim; edit there first and let `lens sync` propagate.

## NAME

`lens` — maintain prose "lens" artifacts in sync with each other and with
the code.

## SYNOPSIS

```
lens init [<description>] [--template <name>] [--force] [--dry-run] [--config <path>]
lens sync [--force] [--dry-run] [--config <path>]
lens pull [--force] [--dry-run] [--config <path>]
lens apply [--dry-run] [--config <path>]
lens diff [--config <path>]
lens validate [--config <path>]
lens status [--json] [--config <path>]
lens add <name> --description <text> [--path <path>] [--dry-run] [--config <path>]
lens mark <synced|applied>
lens --help
lens --version
```

## DESCRIPTION

A **lens** is a prose markdown artifact describing one aspect of a
software system — schema, api, roles, flows, commands, exit codes — stored
in `.lenses/<name>.md`. Code is a downstream derivation of the lens set.

Two directions of consistency:

- **Horizontal** (lens ↔ lens) — edits to one lens propagate to related
  lenses via `lens sync`.
- **Vertical** (lens ↔ code) — `lens apply` hands lenses to a coding
  agent to drive code; `lens pull` reflects code changes back into
  lenses.

Two git refs track state:

- `refs/lens/synced` — commit at which lenses were last internally
  consistent. Advanced by `init`, `sync`, `add` on a clean tree; manually
  by `lens mark synced`.
- `refs/lens/applied` — commit at which code last matched lenses.
  Advanced by `pull` on a clean tree; manually by `lens mark applied`
  (typically after a coding agent run kicked off by `lens apply`).

Config lives at `lens.yml` at the repo root (or `lens.yaml`, `lens.jsonc`,
or `lens.json`; discovered in that order). The lockfile lives at
`.lenses/lock.json` and records hashes of lens files and pull-source
files across the `generate`, `sync`, and `pull` tasks. Commit both.

The runner is any shell command containing the literal `{prompt}` token;
`lens` shell-escapes the prompt and invokes via a login shell so your
`$PATH` is loaded. Default: `claude --allowed-tools
Read,Write,Edit,Bash,Grep,Glob --permission-mode acceptEdits --print
{prompt}`. The environment variable `LENS_RUNNER_OVERRIDE` swaps the
configured runner for a single invocation and bypasses your shell rc
files.

## COMMANDS

**init** [_description_]
&nbsp;&nbsp;&nbsp;&nbsp;Scaffold `lens.yml` from a template, generate
initial lens content via the runner, write `.lenses/lock.json`, advance
`refs/lens/synced`.

**sync**
&nbsp;&nbsp;&nbsp;&nbsp;Reconcile lens files with each other. Runs the
sync prompt over changed lenses and their transitive `affects` closure.
Surfaces `.lenses/conflicts.md` if the runner leaves one behind.

**pull**
&nbsp;&nbsp;&nbsp;&nbsp;Reflect code changes back into lenses using
`pullSources` globs (or all git-tracked files outside `.lenses/`,
`lens.yml` (and variants), `node_modules/`, `.git/` as a fallback).

**apply**
&nbsp;&nbsp;&nbsp;&nbsp;Assemble a read-only context bundle (intent,
lenses, diff since `refs/lens/applied`, changed code files, file tree)
and print it to stdout for consumption by a coding agent. No runner, no
lockfile write, no ref update.

**diff**
&nbsp;&nbsp;&nbsp;&nbsp;Preview what `lens apply` would emit, preceded by
a drift summary. Side-effect-free.

**validate**
&nbsp;&nbsp;&nbsp;&nbsp;Sanity-check config: parse, `{prompt}` present in
runner, lens files exist, unique names, unique paths, `pullSources`
globs resolve (warning only).

**status**
&nbsp;&nbsp;&nbsp;&nbsp;Print a drift report: refs, per-lens state,
code-drift count, next-step suggestions. With `--json`, emit the same
data as a single JSON object for scripting and CI integrations.

**add** _name_
&nbsp;&nbsp;&nbsp;&nbsp;Append a new lens to the config, create an empty
file at `--path` (default `.lenses/<name>.md`), and regenerate via the
runner.

**mark** _synced_|_applied_
&nbsp;&nbsp;&nbsp;&nbsp;Manually advance `refs/lens/synced` or
`refs/lens/applied` to HEAD. Intended after a commit when automatic
ref-advancement was skipped (dirty tree at verb end, non-git environment,
etc.).

## OPTIONS

**-c, --config** _path_
&nbsp;&nbsp;&nbsp;&nbsp;Use a specific config file. When unset,
discovery searches `lens.yml`, then `lens.yaml`, then `lens.jsonc`, then
`lens.json`. Accepted by every verb.

**-n, --dry-run**
&nbsp;&nbsp;&nbsp;&nbsp;Print what would happen (assembled prompt,
substituted YAML, or apply bundle) without invoking the runner, writing
files, or advancing refs. Accepted by `init`, `sync`, `pull`, `apply`,
`add`.

**-f, --force**
&nbsp;&nbsp;&nbsp;&nbsp;For `init`, overwrite an existing config. For
`sync`/`pull`, run even when hashes show no drift.

**-t, --template** _name_
&nbsp;&nbsp;&nbsp;&nbsp;Starter template for `lens init`. One of
`webapp` (default), `cli`, `library`, `pipeline`, `protocol`, `blank`.

**--description** _text_
&nbsp;&nbsp;&nbsp;&nbsp;Required, non-empty description for `lens add`.

**-p, --path** _path_
&nbsp;&nbsp;&nbsp;&nbsp;Override the lens file path for `lens add`.

**--json**
&nbsp;&nbsp;&nbsp;&nbsp;Machine-readable output for `lens status`: emit
the report as a single JSON object on stdout.

**-h, --help**
&nbsp;&nbsp;&nbsp;&nbsp;Print usage and exit `0`.

**-v, --version**
&nbsp;&nbsp;&nbsp;&nbsp;Print version and exit `0`.

## EXIT STATUS

| Code | Meaning                   |
| ---- | ------------------------- |
| 0    | Success                   |
| 1    | Operation failed          |
| 2    | Config missing or invalid |
| 3    | Git state incompatible    |

See `exit-codes.md` for the exhaustive list of conditions that produce
each code. `0` is also returned when `sync` or `pull` find nothing to
do.

## EXAMPLES

Bootstrap a new project:

```
lens init "a team invoicing app"
```

Propagate an edit in one lens to the rest:

```
vim .lenses/schema.md
lens sync
```

Hand the current lens set to a coding agent:

```
lens apply | my-agent
# agent writes code, commit happens…
lens mark applied
```

Reflect code changes back into lenses:

```
lens pull
```

Preview what `apply` would emit, without the handoff footer:

```
lens diff
```

Validate configuration before running anything:

```
lens validate
```

Use a non-default config location:

```
lens --config my/path/config.yaml status
```

## FILES

- `lens.yml` — config: intent, runner, settings, lenses (discovered, or
  `lens.yaml`/`lens.jsonc`/`lens.json` fallbacks).
- `.lenses/<name>.md` — the lens files themselves, one per entry in
  `lens.yml`'s `lenses:`.
- `.lenses/lock.json` — lockfile: per-task hashes for `generate`, `sync`,
  `pull`. Commit it.
- `.lenses/conflicts.md` — transient side-channel file the runner writes
  when `sync` cannot resolve contradictory edits. Removed by `lens` at
  the start of each `sync`; surfaced to stdout when present after the
  run; delete manually when resolved.

## ENVIRONMENT

**LENS_RUNNER_OVERRIDE**
Shell command containing `{prompt}` that swaps the configured runner for a single invocation. When set, `lens` uses a plain non-login `/bin/bash` so the command does not depend on user rc-file success. Useful for tests and ops.

## SEE ALSO

`commands.md`, `flags.md`, `exit-codes.md`, `scenarios.md`, the Claude
Code plugin at `plugin/` (slash commands `/lens:init`, `/lens:sync`,
`/lens:status`, `/lens:apply`, `/lens:pull`, `/lens:add`, `/lens:mark`).
