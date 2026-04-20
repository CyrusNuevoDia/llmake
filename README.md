# lens

> Multi-representation programming. Keep prose intent artifacts in sync with each other and the code.

Install:

    npm i -g lens-engine     # binary: lens
    # or: bun add -g lens-engine
    # or: pnpm add -g lens-engine

Status: **Phase 1** — `lens init` only. Other verbs land in subsequent phases.

## Usage

    lens init [description] [--template <webapp|blank>]
    lens --help
    lens --version

## How it works

Lens ships two primitives:

- **Lens files** — prose artifacts describing one aspect of the system (schema, API, roles, …) that live in `.lenses/`.
- **A runner** — the command used to invoke an LLM with generated prompts. Default: `claude --allowed-tools Read,Write,Edit,Bash --print {prompt}`.

Config lives at `.lenses/config.yaml`. Lockfile at `.lens/lock.json` (commit it).

See `.claude/SPEC.md` for the full design.

## License

GPL-3.0
