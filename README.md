# lens

> Multi-representation programming. Keep prose intent artifacts ("lenses") in sync with each other and with the code.

## Install

    npm i -g lens-engine     # binary: lens
    # or: bun add -g lens-engine
    # or: pnpm add -g lens-engine

Run without installing: `npx lens-engine <verb>`, `bunx lens-engine <verb>`.

## Quick start

    lens init "a team invoicing app"         # scaffold lens.yml + .lenses/, populate via runner
    # edit .lenses/schema.md, .lenses/api.md, ... by hand
    lens sync                                 # propagate edits across lens set
    lens status                               # see drift
    lens apply                                # print plan-mode bundle for the coding agent
    lens pull                                 # reflect code changes back into lenses
    lens diff                                 # preview what apply would do (no plan mode)
    lens validate                             # sanity-check config

## What lens does

A **lens** is a prose artifact describing one aspect of the system — schema, API, roles, flows, wireframes — stored in `.lenses/<name>.md`. Code is a downstream derivation of the lens set.

Two directions of consistency:

- **Horizontal** (lens ↔ lens): edit one → `lens sync` propagates.
- **Vertical** (lens ↔ code): `lens apply` drives code from lenses; `lens pull` drives lenses from code.

State is tracked via two git refs:

- `refs/lens/synced` — commit at which lenses were last internally consistent.
- `refs/lens/applied` — commit at which code last matched lenses.

When a verb completes against a clean working tree, the corresponding ref advances automatically. When the tree is dirty, the verb instructs you to commit + run `lens mark synced` or `lens mark applied`.

## CLI reference

```
lens init [description] [--template <name>] [--force] [--dry-run]
lens sync [--force] [--dry-run]
lens pull [--force] [--dry-run]
lens apply [--dry-run]
lens diff                                    # preview of apply bundle
lens validate                                # sanity-check config
lens status                                  # drift report
lens add <name> --description <text> [--path <path>] [--dry-run]
lens mark <synced|applied>
lens --config <path>                         # override lens.yml discovery
lens --help
lens --version
```

### Templates

Ship with six starter lens sets:

| Template   | Lenses                                                |
| ---------- | ----------------------------------------------------- |
| `webapp`   | schema, api, roles, jobs, flows, wireframes           |
| `cli`      | commands, flags, exit-codes, scenarios, manpage       |
| `library`  | public-api, types, errors, examples                   |
| `pipeline` | inputs, stages, outputs, failure-modes, observability |
| `protocol` | messages, state-machine, wire-format, conformance     |
| `blank`    | (no lenses — grow with `lens add`)                    |

`lens init` defaults to `webapp`. Pass `--template <name>` to pick another.

### Exit codes

| Code | Meaning                                                      |
| ---- | ------------------------------------------------------------ |
| 0    | Success                                                      |
| 1    | Operation failed (runner error, missing lens, etc.)          |
| 2    | Config missing or invalid                                    |
| 3    | Git state incompatible (e.g. `lens mark ...` outside a repo) |

## Config (`lens.yml`)

```yaml
intent: |
  A team invoicing app. Teams have admins and members. …

runner: claude --allowed-tools Read,Write,Edit,Bash,Grep,Glob --permission-mode acceptEdits --print {prompt}

settings:
  autoApprove: false

lenses:
  - name: schema
    path: .lenses/schema.md
    description: |
      Normalized relational schema as markdown. For each table: …
    pullSources:
      - prisma/**/*.prisma
      - src/db/**/*.ts
    affects: [api, roles] # optional: prune sync context

  - name: api
    path: .lenses/api.md
    description: |
      Every REST endpoint as a markdown table: Method, Path, …
    pullSources:
      - src/routes/**/*.ts
```

Discovery order: `lens.yml` → `lens.yaml` → `lens.jsonc` → `lens.json`.

### `pullSources`

Globs identifying which code files each lens watches during `lens pull`. If absent, pull falls back to every git-tracked file outside `.lenses/` and `lens.yml` (and its `.yaml`/`.jsonc`/`.json` variants).

### `affects`

Optional `string[]` of lens names this lens can influence. When any lens declares `affects`, `lens sync`'s prompt is pruned to changed lenses plus their transitive closure — useful for large lens sets.

## Runner contract

The runner must be a shell command containing `{prompt}`. Lens substitutes a shell-escaped prompt in place of `{prompt}` and invokes via a login shell so your `$PATH` is loaded. The runner is expected to write files via tool use (Claude's Read/Write/Edit tools, plus Grep/Glob for large-codebase `pull`) — Lens detects changes by re-hashing lens files on the next run, not by parsing runner output.

When using `claude` as the runner, pass `--permission-mode acceptEdits` so the headless session commits to edits instead of entering plan mode. The shipped templates do this by default.

### Runner override

`LENS_RUNNER_OVERRIDE="<cmd> {prompt}"` swaps the config's runner for a single invocation. Useful for tests and ops. Under the override, Lens uses a plain non-login `/bin/bash` so the command doesn't depend on your `.zshrc`/`.bashrc` succeeding.

## The lockfile (`.lenses/lock.json`)

Tracks hashes of lens files (and pull-source files) across tasks (`generate`, `sync`, `pull`). Commit it — it's how collaborators share "what was the last internally-consistent state."

## Claude Code plugin

`plugin/` ships a Claude Code plugin:

```
/lens:init [description]  # no arg → surveys repo, drafts intent, like /init
/lens:sync
/lens:status
/lens:apply               # enters plan mode with the apply bundle
/lens:pull
/lens:add <name> --description "..."
/lens:mark <synced|applied>
```

Install: copy `plugin/` to `~/.claude/plugins/lens/` (or symlink for local dev).

## Development

```bash
bun install                     # deps
bun run typecheck               # tsc --noEmit
bun x ultracite check           # Biome lint via Ultracite preset
bun test                        # integration tests
bun run build                   # produces dist/lens.js
```

## License

GPL-3.0
