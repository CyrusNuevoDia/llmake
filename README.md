# lens

> Multi-representation programming. Keep prose intent artifacts in sync with each other and the code.

Install:

    npm i -g lens-engine     # binary: lens
    # or: bun add -g lens-engine
    # or: pnpm add -g lens-engine

Status: **Phase 2** — `init`, `sync`, `status`, `mark-synced`, `mark-applied`. `apply`, `pull`, `add` land in subsequent phases.

## Usage

    lens init [description] [--template <name>]   # webapp, cli, library, pipeline, protocol, blank
    lens sync [--force] [--dry-run]
    lens status
    lens mark-synced
    lens mark-applied
    lens --help
    lens --version

## Git refs

Lens tracks two refs per repo:

- `refs/lens/synced` — advanced after successful `sync` (or `init`). Marks the commit at which lenses were last internally consistent.
- `refs/lens/applied` — advanced after successful `apply` or `pull` (Phase 3+). Marks the commit at which code last matched lenses.

When a lens operation completes with a dirty working tree, the corresponding ref is NOT advanced automatically — commit your changes first, then run `lens mark-synced` or `lens mark-applied`.

## Runner override

Set `LENS_RUNNER_OVERRIDE="<command> {prompt}"` to swap the configured runner for a single invocation (tests, ops, debugging). Under the override, commands run in a plain non-login `/bin/bash` shell so they don't depend on the user's `.zshrc`/`.bashrc` succeeding.

## How it works

Lens ships two primitives:

- **Lens files** — prose artifacts describing one aspect of the system (schema, API, roles, …) that live in `.lenses/`.
- **A runner** — the command used to invoke an LLM with generated prompts. Default: `claude --allowed-tools Read,Write,Edit,Bash --print {prompt}`.

Config lives at `.lenses/config.yaml`. Lockfile at `.lens/lock.json` (commit it).

See `.claude/SPEC.md` for the full design.

## License

GPL-3.0
