# Lens — Implementation Spec

> **Handoff document for a coding agent.** This spec defines Lens, to be built as a fork of [llmake](https://github.com/CyrusNuevoDia/llmake). Lens extends llmake with lens-specific semantics (cross-file sync, git ref management, plan-mode integration) while preserving llmake's core primitives (content-addressed change detection, runner-agnostic execution, lockfile-based state).

---

## 0. Summary

Lens is a CLI and Claude Code plugin for **multi-representation programming**. Developers maintain a set of prose intent artifacts ("lenses") — schema, API, roles, flows, etc. — as files on disk. Lens keeps them in sync with each other and with the codebase.

The CLI (`lens`) is a fork of llmake with added semantics for lens workflows. The Claude Code plugin is a thin skill pack that shells out to the CLI and handles plan-mode handoff.

**Core verbs**: `init`, `add`, `sync`, `apply`, `pull`, `status`.

---

## 1. Fork Relationship

- **Source**: `github.com/CyrusNuevoDia/llmake`
- **Fork**: Rename repo to `lens` (or `lens-engine` if maintaining llmake alongside is desired — but default is full rename).
- **Binary**: `lens`
- **Package name (npm)**: `lens` if available, otherwise `@cyrusnuevodia/lens`.
- **Config discovery order**: `.lenses/config.yaml` → `.lenses/config.jsonc` → `.lenses/config.json`. The old llmake formats (`llmake.ts`, `llmake.jsonc`, etc.) are **not supported** in Lens. This is a hard break from llmake's config surface.

Preserve from llmake:

- SHA-256 per-file hashing + merkle root
- Lockfile structure (renamed `.llmake.lock` → `.lens/lock.json`)
- Runner-agnostic `{prompt}` substitution
- Login-shell execution semantics
- `--force`, `--dry-run`, `--status`, `--config`, `--help`, `--version` flags

Replace or add:

- Config format and discovery (see §3)
- Task model: internally derived from lens set, not user-defined (see §4)
- New template variables: `{changed_files}`, `{git_diff_since:<ref>}` (see §5)
- Git ref management: `lens/synced`, `lens/applied` (see §6)
- New verbs: `init`, `add`, `sync`, `apply`, `pull`, `status` (see §7)

---

## 2. Mental Model

> **Lenses are projections of intent.** Code is a downstream derivation.

A **lens** is a file on disk (markdown, YAML, Prisma, whatever the user configures) that captures one aspect of the system. Lenses live in `.lenses/` by default but can be pointed anywhere.

Two directions of consistency:

- **Horizontal**: Lens ↔ Lens. Edit one, the others may need updates. Handled by `lens sync`.
- **Vertical**: Lens ↔ Code. Lenses can drive code generation (`lens apply`), or code changes can be reflected back into lenses (`lens pull`).

Two git refs track state:

- `lens/synced` — commit at which lenses were last internally consistent
- `lens/applied` — commit at which code last matched lenses

These refs let `lens status` report drift precisely and let `sync`/`apply`/`pull` compute accurate deltas.

---

## 3. Config Format

Single user-facing config: `.lenses/config.yaml`. No secondary `llmake.jsonc`.

```yaml
# Seed description of the system. Passed into every generation prompt.
intent: |
  A team invoicing app. Teams have admins and members. Teams create clients,
  send invoices, and track payment status (draft → sent → paid → overdue → void).
  Only admins can send invoices; members can create drafts.

# Runner command for LLM invocation. {prompt} is substituted at execution time.
runner: claude --allowed-tools Read,Write,Edit,Bash --print {prompt}

# Optional global settings
settings:
  autoApprove: false # If true, sync/pull skip user review

# The lens set. Order is not significant.
lenses:
  - name: schema
    path: .lenses/schema.md
    description: |
      Normalized relational schema as markdown. For each table: a markdown
      table with columns (name, type, nullable, PK/FK, constraints). End
      with a "Relationships" section listing cardinalities.

  - name: api
    path: .lenses/api.md
    description: |
      Every REST endpoint as a markdown table: Method, Path, Description,
      Auth (role required), Request body, Response body.

  - name: roles
    path: .lenses/roles.md
    description: |
      Every role in the system. For each, a bulleted list of what they can
      and cannot do. Group by resource.

  # ... etc
```

### Config schema

| Field                  | Type    | Required | Description                                                |
| ---------------------- | ------- | -------- | ---------------------------------------------------------- |
| `intent`               | string  | Yes      | Seed description. Included in generation prompts.          |
| `runner`               | string  | Yes      | Command template. Must contain `{prompt}`.                 |
| `settings.autoApprove` | boolean | No       | Default `false`. If `true`, skip user review in sync/pull. |
| `lenses`               | array   | Yes      | Lens definitions. At least one required after `init`.      |
| `lenses[].name`        | string  | Yes      | Unique identifier. Used in CLI args.                       |
| `lenses[].path`        | string  | Yes      | File path. Can be anywhere in repo, not just `.lenses/`.   |
| `lenses[].description` | string  | Yes      | What the lens should contain. Used as generation guidance. |

Note: No per-lens `prompt` field. The prompt is _assembled_ by Lens from the lens's `description` plus the global intent and other lenses' current state. See §5.

---

## 4. Internal Task Model

> **Key design decision**: Users do not define tasks. Lens derives the task set from the lens configuration.

Internally, Lens runs exactly **three kinds of tasks**:

1. **Generate** — populate empty/missing lens files from intent + other lenses' current content.
2. **Sync** — propagate edits across the lens set. Run after user edits one or more lenses.
3. **Pull** — update lenses to reflect current code state.

Each task type has a prompt template (§5) with variable substitution. Tasks are assembled at runtime, not stored in config.

`apply` is not a task in the llmake sense — it's a special verb that hands off to Claude Code's plan mode.

### Hash tracking per task

Preserve llmake's lockfile mechanism. The lockfile (`.lens/lock.json`) tracks:

```json
{
  "version": 1,
  "tasks": {
    "sync": {
      "last_run": "2026-04-20T10:30:00.000Z",
      "sources_hash": "sha256:...",
      "files": { ".lenses/schema.md": "sha256:...", ... }
    },
    "pull": { ... }
  }
}
```

For `sync`, the `sources` set is **all lens files** (`lenses[].path` for every lens). A change to any lens triggers sync.

For `pull`, the `sources` set is code files. The user declares them in a `pullSources` field per lens (Phase 4 — see §9).

---

## 5. Prompt Templates

> **Design principle**: Push semantic decisions into prompts, not into the task graph. The LLM decides which files to update; the engine only decides which prompts to run.

Template variables available at prompt-assembly time:

| Variable                  | Meaning                                                                       |
| ------------------------- | ----------------------------------------------------------------------------- |
| `{intent}`                | The `intent` field from config                                                |
| `{lenses}`                | A structured dump of every lens: name, path, description, current content     |
| `{changed_files}`         | List of files that changed (by hash) since last task run                      |
| `{changed_files_content}` | Same, but with file contents inlined                                          |
| `{git_diff_since:<ref>}`  | `git diff <ref> -- <task-sources>` output. Empty string if ref doesn't exist. |

The engine substitutes these at runtime. If a variable appears in a template but has no value (e.g. `git_diff_since` when the ref doesn't exist), substitute a placeholder: `(no previous sync — treat current state as baseline)`.

### 5.1 Generate prompt (used by `init` and `add`)

```
You are initializing a set of lens files that describe a software system.

INTENT (what the user wants to build):
{intent}

LENS DEFINITIONS (what each lens should contain):
{lenses}

CURRENT STATE OF LENS FILES (some may be empty):
{changed_files_content}

Populate any lens files that are currently empty or missing. For each lens,
use its description as guidance for format and content. Maintain internal
consistency: if the schema lens defines a User table, the roles lens should
reference it, etc.

Do nothing to lens files that already have content. Making no changes to
non-empty files is correct.

Use Write or Edit tools to update the files at the paths listed in the
lens definitions.
```

### 5.2 Sync prompt

```
You are maintaining consistency across a set of lens files.

INTENT:
{intent}

LENS DEFINITIONS:
{lenses}

CHANGES SINCE LAST SYNC:
{git_diff_since:lens/synced}

CURRENT FULL CONTENT OF ALL LENSES:
{changed_files_content}

The user has edited one or more lens files. Read the diff above to see what
changed. Update any other lens files that need to change to restore
consistency.

Rules:
- Preserve human-authored prose where possible. Prefer targeted edits over
  full rewrites.
- Making no changes to a lens that is already consistent is correct and
  expected. Do not rewrite files that don't need updates.
- If two changes imply contradictory updates to a third lens, do not guess.
  Instead, leave the third lens unchanged and print a clearly-labeled
  conflict report explaining the contradiction.
- Use Edit (preferred) or Write tools to update files.
```

### 5.3 Pull prompt

```
You are updating lens files to reflect the current state of the codebase.

INTENT:
{intent}

LENS DEFINITIONS:
{lenses}

CURRENT LENS CONTENT:
{changed_files_content}

CODE CHANGES SINCE LAST PULL:
{git_diff_since:lens/applied}

For each lens, determine whether the code state implies changes to that
lens. If yes, update the lens file. If no, leave it alone.

Focus on intent-level changes. Do not pollute lenses with implementation
details — only surface what belongs at the lens's level of abstraction.

Use Edit or Write tools to update files.
```

---

## 6. Git Ref Management

Two refs, managed by the engine:

- `lens/synced` — advanced after every successful `sync` (and after `init`/`add` generation, since those also produce internally-consistent state).
- `lens/applied` — advanced after every successful `apply` (and after `pull`, since pull makes lenses match code).

### Ref semantics

- Refs point to **commits**, not working-tree state. The engine does not auto-commit — it advances the ref only when the user has a clean working tree and the operation succeeded, OR when the engine creates its own commit (see below).
- On first `sync`/`apply`/`pull` in a repo, if the ref doesn't exist, create it pointing at current HEAD.
- If the working tree has uncommitted changes when an operation completes successfully, the engine:
  1. Prints a message: `"Lens operation complete. Commit your changes and run 'lens mark-synced' (or mark-applied) to advance the ref."`
  2. Does NOT advance the ref automatically.
  3. Provides `lens mark-synced` and `lens mark-applied` as explicit verbs that advance the corresponding ref to HEAD.

This avoids the engine making commits on the user's behalf, which is invasive. The user controls commits; Lens tracks state.

### Ref creation/update

Use `git update-ref refs/heads/lens/synced <sha>` or equivalent. Refs are in a namespaced location (`refs/lens/synced`, `refs/lens/applied`) to avoid colliding with branches. Use `refs/lens/*` not `refs/heads/lens/*`.

```bash
git update-ref refs/lens/synced HEAD
git rev-parse refs/lens/synced     # read
```

### Missing-ref handling

When computing `{git_diff_since:lens/synced}`:

- If ref exists: `git diff <ref> -- <paths>`
- If ref does not exist: substitute placeholder string `(no previous sync — treat current state as baseline)`

---

## 7. CLI Surface

```
lens init [description] [--template <name>]
lens add <name> [--description <text>] [--path <path>]
lens sync [--force] [--dry-run]
lens apply [--dry-run]
lens pull [--force] [--dry-run]
lens status
lens mark-synced
lens mark-applied
lens --config <path>
lens --help
lens --version
```

### 7.1 `lens init [description]`

Initialize a Lens setup in the current directory.

Behavior:

1. If `.lenses/config.yaml` already exists, fail with a clear error unless `--force` is passed.
2. Prompt for intent if `[description]` is not provided (read from stdin).
3. Select template: either from `--template` flag, or default to `webapp`.
4. Write `.lenses/config.yaml` with intent + template's lens definitions + default runner.
5. Create empty files at each `lenses[].path`.
6. Run the generate task to populate lens files.
7. Create `refs/lens/synced` pointing at HEAD (if in a git repo).
8. Print next steps: "Review `.lenses/`, commit, then edit any lens to start iterating."

### 7.2 `lens add <name>`

Add a new lens to the set.

Behavior:

1. Read `.lenses/config.yaml`.
2. Prompt for description and path (or accept via flags).
3. Append to `lenses[]`.
4. Write updated config.
5. Create empty file at `path`.
6. Run generate task (only this lens is empty — generate will populate just it).
7. Print: "Added lens '{name}'. Review and commit."

### 7.3 `lens sync [--force]`

Reconcile lens files with each other.

Behavior:

1. Check that all lens files listed in config exist. If any are missing, fail with clear message suggesting `lens add` or manual creation.
2. Compute sources hash over all lens files.
3. If `--force` is passed OR sources hash changed since last sync (per lockfile): proceed. Otherwise, print "Nothing to sync" and exit 0.
4. Assemble sync prompt with `{git_diff_since:lens/synced}` populated.
5. Invoke runner with assembled prompt.
6. On runner success:
   - Update lockfile with new hashes.
   - If working tree is clean: advance `refs/lens/synced` to HEAD automatically.
   - If working tree is dirty: print "Sync complete. Commit changes and run `lens mark-synced` to advance ref."
7. On runner failure: exit 1 without updating lockfile or ref.

### 7.4 `lens apply`

Make the codebase match the lenses. This verb **delegates to Claude Code plan mode** when run via the plugin; as a pure CLI, it prepares context and prints instructions.

CLI behavior:

1. Assemble context: all lens files + `git diff lens/applied -- .lenses/` + a scan summary of the codebase (file tree, not contents).
2. Print the assembled context bundle to stdout with instructions: "Pipe this to your coding agent, or run `/lens:apply` in Claude Code for integrated plan-mode handoff."
3. Do not invoke a runner directly for `apply` — this is a user-in-the-loop operation, and plan mode in Claude Code is the right surface.
4. `lens apply --dry-run` prints the same context without the instructions footer.

The plugin-side `/lens:apply` command (see §8) handles the actual plan-mode entry.

### 7.5 `lens pull [--force]`

Update lens files to reflect current code state.

Behavior mirrors `sync`, but:

- Sources are code files, not lens files. Initially (MVP) use a hardcoded heuristic: every file tracked by git that is NOT under `.lenses/`. Phase 4 adds per-lens `pullSources` glob config.
- Prompt template is the pull prompt (§5.3).
- Ref advanced on success is `refs/lens/applied` (since pulling means lenses now match code).

### 7.6 `lens status`

Print a structured status report:

```
Lens status
───────────

Repository: /Users/cyrus/work/invoicing-app
Config:     .lenses/config.yaml (6 lenses)

Refs:
  lens/synced   abc1234 (2 hours ago)
  lens/applied  def5678 (1 day ago)

Lens set:
  ✓ schema        .lenses/schema.md           up to date
  ⚠ api           .lenses/api.md              edited since last sync
  ✓ roles         .lenses/roles.md            up to date
  ✓ flows         .lenses/flows.md            up to date
  ✓ jobs          .lenses/jobs.md             up to date
  ✓ wireframes    .lenses/wireframes.md       up to date

Code:
  ⚠ 12 code files changed since last apply

Suggestions:
  • Run `lens sync` to propagate api.md edits to other lenses
  • Run `lens pull` to reflect code changes in lenses, OR
    run `lens apply` to propagate lens changes into code
```

Status derivation:

- For each lens: compare current hash to lockfile hash. If different, mark as "edited since last sync."
- For code: `git diff --name-only lens/applied -- . ':(exclude).lenses/'` count.
- Suggestions follow from the detected drift pattern.

### 7.7 `lens mark-synced` / `lens mark-applied`

Advance the corresponding ref to HEAD. Fail if HEAD is the same as the ref already, or if not in a git repo.

---

## 8. Claude Code Plugin

Standard plugin layout:

```
lens-plugin/
├── .claude-plugin/
│   └── plugin.json
├── commands/
│   ├── lens:init.md
│   ├── lens:add.md
│   ├── lens:sync.md
│   ├── lens:apply.md
│   ├── lens:pull.md
│   └── lens:status.md
└── skills/
    ├── lens-init/SKILL.md
    ├── lens-add/SKILL.md
    ├── lens-sync/SKILL.md
    ├── lens-apply/SKILL.md
    ├── lens-pull/SKILL.md
    └── lens-status/SKILL.md
```

Each skill is thin. The pattern for all except `apply`:

1. Parse slash command arguments.
2. Run `lens <verb> <args>` via Bash tool.
3. Stream output to the Claude Code transcript.
4. If the CLI exits non-zero, surface the error to the user.

### `/lens:apply` — the one special case

This skill does real orchestration because the CLI's `apply` stops short of plan mode.

1. Run `lens apply --dry-run` to get the assembled context bundle.
2. Call `EnterPlanMode` with a prompt constructed as:
   > "Here are the lens files and the delta since last apply. Produce a plan to make the codebase match the lenses. Focus on the deltas; ignore unchanged lenses unless their implementation is currently broken."
   > Followed by the context bundle.
3. After plan execution completes:
   - Check git working-tree state.
   - If clean and HEAD has advanced: run `lens mark-applied`.
   - If dirty: instruct the user to commit and run `lens mark-applied` manually.

### Plugin prerequisites check

On any slash command invocation, skills should first check:

1. `lens` binary is on PATH. If not, instruct: `npm i -g lens` (or equivalent).
2. `.lenses/config.yaml` exists (skip this check for `/lens:init`).

If either check fails, surface a clean error and exit without calling the CLI.

---

## 9. Templates

Templates are pre-built `.lenses/config.yaml` files shipped with the CLI. Stored in the repo under `templates/<name>.yaml`.

### MVP template set

| Template           | Lenses                                                |
| ------------------ | ----------------------------------------------------- |
| `webapp` (default) | schema, api, roles, jobs, flows, wireframes           |
| `cli`              | commands, flags, exit-codes, scenarios, manpage       |
| `library`          | public-api, types, errors, examples                   |
| `pipeline`         | inputs, stages, outputs, failure-modes, observability |
| `protocol`         | messages, state-machine, wire-format, conformance     |
| `blank`            | (no lenses — user adds with `lens add`)               |

### Template file format

Identical to user `.lenses/config.yaml` format. The `intent` field in templates is a placeholder (`TODO: describe your system`); `lens init` replaces it with the user's actual description before writing.

### Template selection

```bash
lens init --template cli "A CLI for managing Docker compose files"
```

If `--template` is omitted, use `webapp`. A future `lens init --interactive` could prompt the user to pick.

### Ship templates via package resources

Templates live in `templates/` in the npm package. The `lens init` command reads them from the installed package directory. Do NOT fetch from the internet at runtime.

---

## 10. Implementation Phases

Each phase is independently demoable.

### Phase 1 — Fork + CLI skeleton + `init`

- Fork llmake, rename to `lens`.
- Rip out user-facing task config; replace with lens-centric config schema.
- Implement `lens init` including template loading, file scaffolding, and initial generate pass.
- Ship `webapp` and `blank` templates.
- Preserve llmake's lockfile, runner, and hashing infrastructure.

**Milestone**: `lens init "a task tracker"` produces a `.lenses/` directory with 6 populated lens files.

### Phase 2 — `sync` + `status`

- Implement `lens sync` with `{git_diff_since:lens/synced}` template variable.
- Implement git ref management (`refs/lens/synced`, `lens mark-synced`).
- Implement `lens status`.
- Add `cli`, `library`, `pipeline`, `protocol` templates.

**Milestone**: User edits `schema.md`, runs `lens sync`, other lenses update consistently. `lens status` accurately reports drift.

### Phase 3 — `apply` + plugin

- Implement `lens apply --dry-run` (context bundle assembly).
- Implement `refs/lens/applied` + `lens mark-applied`.
- Build Claude Code plugin with all slash commands.
- `/lens:apply` handles plan-mode entry and post-plan ref advancement.

**Milestone**: Full loop: user iterates on lenses → `/lens:apply` → plan mode generates code → ref advances.

### Phase 4 — `pull` + `add`

- Implement `lens pull` with pullSources config per lens.
- Implement `lens add <name>` for extending the lens set.
- Add per-lens `pullSources` field to config schema.

**Milestone**: Bidirectional sync. User modifies code directly, runs `lens pull`, relevant lenses update.

### Phase 5 — Polish

- `lens diff` — preview `apply` changes without entering plan mode.
- `lens validate` — sanity-check config (missing files, broken paths, unreachable lenses).
- Conflict surfacing in sync output (structured format, not just prose).
- Optional `affects:` graph in config to prune sync scope for large lens sets.

---

## 11. Key Implementation Notes

### 11.1 Prompt assembly via single-task-then-LLM-decides

llmake's model is N tasks → N LLM calls. Lens's model is **1 task → 1 LLM call → LLM updates multiple files via tool use**. This requires the runner to have write access to lens files.

The default runner (`claude --allowed-tools Read,Write,Edit,Bash --print {prompt}`) provides this. The engine does not need to know which files the LLM updated — the lockfile hash comparison on the next run detects all changes.

If a user supplies a runner that cannot write files (e.g. `llm -m gpt-4o {prompt}` with no tool use), Lens will not work correctly. Document this prominently in the README.

### 11.2 Working tree cleanliness

Many operations (sync, apply, pull, mark-\*) depend on git state. The engine should:

- Check `git status --porcelain` to determine cleanliness.
- Warn loudly when operating on a dirty tree.
- Never force-commit. Never amend commits.
- Never move refs when the operation would lose user work.

### 11.3 `{changed_files}` vs `{changed_files_content}`

llmake passes changed file contents. For Lens:

- `{changed_files}`: Just file paths, one per line.
- `{changed_files_content}`: Paths + contents in structured format (e.g. XML blocks).

Both should be available; prompt templates choose which to use. The sync prompt needs content; a lightweight "what's dirty" status check needs only paths.

### 11.4 Lockfile location

Move from `.llmake.lock` (llmake default, repo root) to `.lens/lock.json`. This groups lens-engine state under a single hidden directory, leaving room for future cached artifacts (e.g. pre-computed diffs, template cache) under `.lens/`.

Add `.lens/` to a default `.gitignore` entry created by `lens init`? **No.** The lockfile _should_ be committed — it's how team members share state. Document this clearly.

### 11.5 Error handling

Every CLI verb should:

- Validate config before doing anything destructive.
- Exit with meaningful codes:
  - `0` — success
  - `1` — operation failure (runner error, conflict, etc.)
  - `2` — config missing or invalid
  - `3` — git state incompatible (e.g., mark-synced on dirty tree)
- Print errors to stderr, results to stdout.

### 11.6 Concurrency

Out of scope for MVP. Assume single-user, single-invocation. Add file locking in Phase 5 if needed.

---

## 12. Non-Goals

Explicitly NOT in scope for any phase of this spec:

- A visual editor. Lenses are files; editors are user choice.
- A web UI or service component. Lens is a local CLI + Claude Code plugin only.
- Multi-user collaborative editing beyond what git provides.
- LLM caching or prompt deduplication across invocations.
- Non-Claude runners as first-class citizens (they should work, but are not tested or optimized for).
- Support for non-git version control systems.

---

## 13. Open Questions for Implementation

Surface these to the user (Cyrus) before implementing if they block progress. Otherwise, note the decision taken in PR descriptions.

1. **Package name**: `lens` on npm is likely taken. Fall back to `@cyrusnuevodia/lens` or choose alternative?
2. **Binary conflict**: `lens` is a common word; some systems may have a `lens` binary already. Consider shipping `lensctl` or similar as a fallback. Default: `lens`.
3. **Shell-quoting edge cases**: Lens templates and prompts contain user-authored prose including quotes, newlines, and markdown. llmake shell-escapes the `{prompt}` substitution. Verify this holds for Lens's much longer prompts (possibly tens of KB). If shell arg length limits become an issue, consider writing prompt to a temp file and passing `--prompt-file` to supported runners.
4. **Plan mode API surface**: Verify Claude Code's current plan mode entry points. If plan mode cannot be entered programmatically from a skill, `/lens:apply` must end by instructing the user to enter plan mode manually.

---

## 14. Definition of Done (per phase)

A phase is complete when:

- All listed verbs work end-to-end on a test project.
- `lens status` accurately reflects state after each operation.
- Integration test script exists that runs the full flow and checks expected file states + ref positions.
- README for that phase's verbs is written.
- Changelog entry added.

---

_End of spec. Implement Phase 1 first; verify; proceed in order._
