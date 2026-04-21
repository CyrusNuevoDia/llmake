# Commands

Every top-level `lens` verb, with purpose, positional arguments, supported
flags, and exit codes. Flag semantics are canonical in `flags.md`; exit-code
conditions are canonical in `exit-codes.md` — this lens links to them rather
than duplicating prose.

## `lens init`

Scaffold a new `.lenses/config.yaml`, create empty lens files, run the
configured runner with the generate prompt to populate them from the intent
+ template, write `.lens/lock.json`, and advance `refs/lens/synced` if the
working tree is in a git repo.

- **Positional args:** `[description]` — one-line intent string. If omitted
  and stdin is a TTY, `lens` prompts interactively.
- **Flags:** `--template`, `--force`, `--dry-run`, `--config`. See
  `flags.md`.
- **Exit codes:** `0` on success; `1` if the description is empty, the
  template is missing the `__LENS_INTENT_PLACEHOLDER__` marker, the config
  already exists without `--force`, or the runner fails. See
  `exit-codes.md`.

## `lens sync`

Reconcile lens files with each other. Hashes each lens file against the
sync baseline in the lockfile, invokes the runner with the sync prompt over
the changed-lens closure (pruned via `affects` when defined), records new
hashes, and — if the working tree is clean (ignoring `.lens/lock.json`) —
advances `refs/lens/synced` to HEAD. If the runner writes
`.lens/conflicts.md`, `lens` surfaces it and asks you to resolve manually.

- **Positional args:** none.
- **Flags:** `--force` (run even when no drift), `--dry-run` (print the
  prompt, don't invoke the runner), `--config`.
- **Exit codes:** `0` on success or nothing-to-sync; `1` on runner failure
  or a missing lens file; `2` on missing or invalid config.

## `lens pull`

Reflect code changes back into the lens set. Resolves each lens's
`pullSources` globs (falls back to all git-tracked files outside `.lenses/`,
`.lens/`, `node_modules/`, and `.git/`), hashes them, and runs the runner
with the pull prompt over changed files. On success, writes the new
`pull` lockfile entry and advances `refs/lens/applied` when the tree is
clean.

- **Positional args:** none.
- **Flags:** `--force`, `--dry-run`, `--config`.
- **Exit codes:** `0` on success or nothing-to-pull; `1` when a lens file
  is missing, no code sources can be resolved, or the runner fails; `2` on
  missing or invalid config.

## `lens apply`

Assemble a read-only context bundle (intent, lenses, diff since
`refs/lens/applied`, list of changed code files, repo file tree) and print
it to stdout. Unlike `sync` and `pull`, `apply` does **not** invoke the
runner, write the lockfile, or advance any ref — pipe it to your coding
agent or run `/lens:apply` in Claude Code for integrated plan-mode handoff.

- **Positional args:** none.
- **Flags:** `--dry-run` (omit the handoff footer), `--config`.
- **Exit codes:** `0` on success; `1` if a lens file is missing or the git
  tree lookup fails; `2` on missing or invalid config.

## `lens diff`

Print a drift summary (lens file count changed since `refs/lens/applied`,
code file count changed since `refs/lens/applied`) followed by the same
bundle `lens apply` would emit — without the handoff footer. Purely a
preview; side-effect-free.

- **Positional args:** none.
- **Flags:** `--config`.
- **Exit codes:** `0` on success; `1` on apply-bundle assembly failure;
  `2` on missing or invalid config.

## `lens validate`

Sanity-check the config. Runs independent checks:

1. Config loads and parses.
2. `runner` contains the required `{prompt}` placeholder.
3. All lens paths exist on disk.
4. Lens names are unique.
5. Lens paths are unique.
6. Every `pullSources` glob resolves to at least one file (warning only).

- **Positional args:** none.
- **Flags:** `--config`.
- **Exit codes:** `0` when every hard check passes (warnings do not fail);
  `1` when any hard check fails; `2` on missing or invalid config.

## `lens status`

Print a drift report: repository path, config path and lens count, the
current `refs/lens/synced` and `refs/lens/applied` SHAs with relative
time, a per-lens table (`✓ up to date` / `⚠ edited since last sync` /
`⚠ missing on disk`), the code-drift count since last apply, and next-step
suggestions. With `--json`, emit the same data as a single JSON object
to stdout (for scripting and CI integrations).

- **Positional args:** none.
- **Flags:** `--config`, `--json` (machine-readable output).
- **Exit codes:** `0` on success; `2` on missing or invalid config.

## `lens add`

Append a new lens to the config, create an empty lens file at the chosen
path, and invoke the runner with the generate prompt so the new lens is
populated alongside the existing set. On success, advances
`refs/lens/synced` when the working tree is clean.

- **Positional args:** `<name>` — required lens name.
- **Flags:** `--description` (required, non-empty), `--path` (default
  `.lenses/<name>.md`), `--dry-run`, `--config`.
- **Exit codes:** `0` on success; `1` if `<name>` or `--description` is
  missing, the name collides with an existing lens, or the runner fails;
  `2` if no config file exists.

## `lens mark <synced|applied>`

Manually advance `refs/lens/synced` or `refs/lens/applied` to HEAD.
Intended for the "runner done, commit made, now bless it" path when the
automatic ref advancement at the end of `sync`/`pull` was skipped (dirty
tree, non-git environment, etc.).

- **Positional args:** `<synced|applied>` — which ref to advance.
- **Flags:** none.
- **Exit codes:** `0` on success; `1` on bad argument or when the ref is
  already at HEAD; `3` when not in a git repo or HEAD cannot be resolved.

## `lens --help` / `lens --version`

Print the usage banner or the package version and exit `0`. `--help`
(short `-h`) and `--version` (short `-v`) are global; `lens help` and
`lens version` are accepted as verbs too.
