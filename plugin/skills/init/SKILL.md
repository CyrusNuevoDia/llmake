---
name: init
description: Initialize a Lens setup in the current directory. With no description argument, surveys the repo (like Claude's /init) to propose a template and draft the intent; with a description argument, passes through to the CLI verbatim.
allowed-tools: Bash Read Glob Grep AskUserQuestion
argument-hint: [description] [--template <name>]
---

## Prereq

Verify `command -v lens` succeeds. If it returns non-zero, tell the user "lens CLI not found. Install with `npm i -g lens-engine`." and stop.

## Dispatch

- If `$ARGUMENTS` contains a positional token that is not a flag (i.e. a description), go to **Passthrough**.
- Otherwise (empty, or only flags like `--template <name>`), go to **Exploration**.

## Passthrough

Run:

    lens init $ARGUMENTS

Stream stdout/stderr. Surface non-zero exit clearly. Stop.

## Exploration

The user invoked `/lens:init` without a description. Survey the repo, propose a template, draft the intent, confirm, then invoke the CLI.

### 1. Survey (read-only)

- Read whichever of `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `Gemfile`, `build.gradle` exists (name, description, scripts, dependencies).
- Read `README.md` (first ~200 lines) if present.
- `Glob` top-level layout: `*`, `src/*`, `app/*`, `cmd/*`.
- `Glob`/`Grep` for structural markers (a `package.json` `bin` field, `.proto` files, etc.).

### 2. Pick a template

The six shipped templates are `webapp`, `cli`, `library`, `pipeline`, `protocol`, `blank`. Use this signal order (first strong match wins):

- **cli** — `package.json` has `bin`; or `src/cli/` exists; or the entrypoint starts with a shebang.
- **webapp** — `src/routes/`, `src/app/api/`, `prisma/`, `src/controllers/`, or similar route/DB layout.
- **protocol** — `.proto` files, `proto/`, `messages/`, or state-machine naming.
- **pipeline** — `airflow/`, `dagster/`, `prefect/`, `src/jobs/`, or `src/workers/`.
- **library** — has `exports`/`main` in package.json, no `bin`, no server/route directories, tests-centric layout.
- **blank** — no strong match.

### 3. Draft the intent

Write 3–6 sentences describing the system. Ground it in what the README and manifest actually say — prefer quoting the README's own phrasing. Do not invent features that aren't in the source.

### 4. Confirm with the user

Use `AskUserQuestion` with two questions:

1. **Template** — options: your chosen template labeled "(Recommended)", one alternative if the repo straddles two, and `blank`.
2. **Intent** — paste the drafted intent. Options: "Use this intent", "Let me edit". If the user picks "Let me edit", ask for the revised intent as free text before continuing.

### 5. Invoke

Run:

    lens init --template <chosen> "<intent>"

Stream output. If it exits non-zero, surface the error; do not proceed to step 6.

### 6. Follow-up

After `lens init` succeeds, tell the user:

> Lens files were populated from your intent. For an existing codebase, run `/lens:pull` next to reflect the actual implementation into the lenses. Then review `.lenses/`, commit, and start iterating.

Do not auto-run `lens pull` — it invokes the runner and can take a minute or more, so users should opt in.
