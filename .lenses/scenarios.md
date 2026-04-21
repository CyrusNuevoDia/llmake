# Scenarios

Task-focused walkthroughs. Each section names an outcome the user is
after, then lists the command sequence, the expected output or side
effect, and any prerequisite state.

## The user wants to bootstrap a new lens set

- **Prerequisites:** a git repo (optional but recommended); a runner the
  `{prompt}` placeholder can be passed to — e.g. `claude --print`.
- **Commands:**
  - `lens init "a team invoicing app"` — or `lens init` to be prompted
    interactively when stdin is a TTY.
- **Effect:** writes `lens.yml` populated from the `webapp` template,
  creates empty `.lenses/<name>.md` files for every lens, invokes the
  runner with the generate prompt, writes `.lenses/lock.json`, and
  advances `refs/lens/synced` to HEAD.
- **Variants:** pass `--template cli` (or `library`/`pipeline`/
  `protocol`/`blank`) to pick a different starter set. Add `--force` to
  overwrite an existing config. Add `--dry-run` to print the substituted
  YAML to stdout and exit without touching the filesystem.

## The user wants to see what's drifted

- **Prerequisites:** an initialized lens set.
- **Commands:** `lens status`.
- **Effect:** prints the repo path, config path, current
  `refs/lens/synced` and `refs/lens/applied` SHAs, a per-lens table with
  `✓` / `⚠` symbols, the code-drift count, and next-step suggestions
  ("Run `lens sync` to propagate …", "Run `lens pull` OR `lens apply`").
  Always exits `0` when the config loads.
- **Variants:** `lens status --json` emits the same data as a single
  JSON object on stdout for scripting and CI integrations.

## The user edited one lens and wants the rest to catch up

- **Prerequisites:** `lens.yml` exists; one or more lens files have
  unsaved or committed edits.
- **Commands:**
  - `lens sync` to run the sync prompt over the changed-lens closure
    (pruned via `affects` if declared).
  - If the runner writes `.lenses/conflicts.md`, `lens` prints the body;
    resolve manually and re-run `lens sync`.
  - If the working tree is dirty at the end, `lens` prints "Commit
    changes and run 'lens mark synced' to advance ref."
- **Effect:** updates lens file contents, rewrites the `sync` entry in
  `.lenses/lock.json`, and advances `refs/lens/synced` when the tree is
  clean (ignoring `.lenses/lock.json`).

## The user wants to preview what `lens apply` would do

- **Prerequisites:** `lens.yml` exists.
- **Commands:** `lens diff`.
- **Effect:** prints a drift summary (lens file count, code file count
  since `refs/lens/applied`) followed by the same bundle `lens apply`
  would emit, without the plan-mode handoff footer. No side effects.

## The user wants to hand the current lens set to a coding agent

- **Prerequisites:** an up-to-date lens set (ideally clean after
  `lens sync`).
- **Commands:**
  - `lens apply` to print the context bundle with the handoff footer.
  - Or `/lens:apply` inside Claude Code for integrated plan mode.
  - After the agent writes code and you commit, run
    `lens mark applied` to advance `refs/lens/applied`.
- **Effect:** `lens apply` itself is read-only: no runner, no lockfile
  write, no ref update. The agent performs the code edits; `lens mark
  applied` records "code now matches lenses."

## The user wants code changes reflected back in the lenses

- **Prerequisites:** code has changed since `refs/lens/applied`;
  `pullSources` globs declared per lens (or run in a git repo so the
  fallback — all tracked files outside `.lenses/`, `lens.yml` (and
  variants), `node_modules/`, `.git/` — kicks in).
- **Commands:** `lens pull`.
- **Effect:** invokes the runner with the pull prompt over changed files,
  writes the `pull` entry in `.lenses/lock.json`, and advances
  `refs/lens/applied` when the tree is clean. Dirty trees print "Commit
  changes and run 'lens mark applied' to advance ref."

## The user wants to add a new lens to the set

- **Prerequisites:** `lens.yml` exists.
- **Commands:** `lens add wireframes --description "ASCII wireframes for
  every screen"` (add `--path` to override the default
  `.lenses/wireframes.md`).
- **Effect:** appends the new lens to the YAML, creates an empty file,
  runs the generate prompt so the new lens is populated alongside the
  existing ones, updates the `generate` lockfile entry, and advances
  `refs/lens/synced` when the tree is clean.
- **Variants:** `--dry-run` prints the updated YAML and exits without
  touching disk.

## The user wants to sanity-check config before running anything

- **Prerequisites:** `lens.yml` exists.
- **Commands:** `lens validate`.
- **Effect:** runs six checks — config parses, `{prompt}` present in
  runner, lens paths exist, unique names, unique paths, `pullSources`
  globs resolve — and prints a `✓` / `⚠` / `✗` report. Exits `0` if no
  hard check failed (warnings do not fail); exits `1` on any `✗`.

## The user wants to manually bless "code matches lenses now"

- **Prerequisites:** inside a git repo; HEAD resolvable; code and lenses
  are believed to match.
- **Commands:** `lens mark applied` (or `lens mark synced`).
- **Effect:** moves `refs/lens/applied` (or `refs/lens/synced`) to HEAD
  and prints `lens: advanced refs/lens/applied to <short-sha>`. Fails
  with exit `1` if the ref already points at HEAD; fails with exit `3`
  outside a git repo.

## The user wants to point `lens` at a non-default config location

- **Prerequisites:** a config file anywhere on disk.
- **Commands:** `lens --config path/to/lenses.yaml status` (or any
  other verb).
- **Effect:** skips discovery and loads the given path. Works globally on
  every verb; see `flags.md` for exhaustive flag semantics.
