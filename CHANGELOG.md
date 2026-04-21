# Changelog

## 0.0.1 — Initial release (forked from llmake)

Complete fork of `llmake` into `lens-engine`, delivering all five phases of `.claude/SPEC.md`.

### Phase 1 — scaffold + `lens init`
- Renamed package to `lens-engine`; CLI binary `lens`.
- New config format: `.lenses/config.yaml` (jsonc/json fallbacks).
- Config schema: `intent`, `runner`, optional `settings`, `lenses[]`.
- Lockfile relocated to `.lens/lock.json`.
- Prompt-template engine with `{intent}` / `{lenses}` / `{changed_files}` / `{changed_files_content}` / `{git_diff_since:<ref>}` substitution.
- Shipped templates: `webapp` (default), `blank`.
- Shared exit codes module (`src/exit.ts`): 0/1/2/3 per SPEC §11.5.
- `LENS_RUNNER_OVERRIDE` env var for tests and ops.
- `lens init` scaffolds `.lenses/`, runs the generate prompt, writes lockfile, and (in a git repo) advances `refs/lens/synced`.

### Phase 2 — `sync`, `status`, `mark-*`, git refs
- `src/git.ts` Promise-based wrappers: `isGitRepo`, `isWorkingTreeClean`, `getHead`, `refExists`, `readRef`, `updateRef`, `diffSince`, `changedSince`, `repoRoot`, `commitRelativeTime`.
- `lens sync` — propagate edits across the lens set. Advances `refs/lens/synced` on clean trees; instructs `lens mark-synced` when dirty.
- `lens status` — formatted drift report (refs + lens set + code drift + suggestions).
- `lens mark-synced` / `lens mark-applied` — advance either ref to HEAD.
- Four additional templates: `cli`, `library`, `pipeline`, `protocol`.
- Every verb works both inside and outside a git repo (except `mark-*`, which requires git).

### Phase 3 — `apply` + Claude Code plugin
- `lens apply` — assembles a context bundle (intent + lenses + `git diff refs/lens/applied` + file tree) for downstream coding agents. Does not invoke the runner; this is a user-in-the-loop handoff.
- Claude Code plugin at `plugin/`: skills for every verb, `/lens:apply` drives plan mode via `EnterPlanMode`, post-plan `git`-state check then `lens mark-applied`.

### Phase 4 — `pull` + `add`
- `LensDef.pullSources?: string[]` — globs identifying code files each lens tracks.
- `lens pull` — reflect code changes back into lenses. Unions per-lens pullSources (or falls back to git-tracked files).
- `lens add <name>` — append a lens to the config in a YAML-formatting-preserving way (via `yaml.parseDocument` + `doc.toString()`), create the lens file, run generate for the new lens.
- webapp template ships reasonable `pullSources` defaults.

### Phase 5 — polish
- `lens diff` — preview the apply bundle with a drift-summary header; read-only.
- `lens validate` — sanity-check config (schema, `{prompt}`, lens-file existence, duplicate names/paths, pullSources match).
- Structured conflict surfacing in `lens sync`: the sync prompt instructs the model to emit `<lens-conflict>` XML blocks, and the CLI parses + surfaces them in a dedicated section. Conflict presence does NOT fail sync — user resolves manually.
- `LensDef.affects?: string[]` — optional graph; when declared, sync's prompt context is pruned to (changed lenses ∪ transitive affects closure).
- Runner tee-capture: `executeRunner(..., { capture: true })` streams output to the terminal AND buffers it for the caller.

### Infrastructure
- 78 integration tests across 15 files.
- Biome/Ultracite-clean.
- Bun bundler produces a single `dist/lens.js` (0.5 MB) with `#!/usr/bin/env node` shebang.
- Pure Node.js runtime APIs — no Bun-specific surfaces in source.
