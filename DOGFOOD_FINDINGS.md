# Dogfood findings — Phase A (lens on lens)

Branch: `dogfood/lens-on-lens`. Exercised init → pull → sync → pull → apply
flow against the `lens-engine` repo itself using `bun src/index.ts` (dev
entrypoint) and `LENS_RUNNER_OVERRIDE` with a Claude runner.

## Resolution summary

| Finding                                       | Status                 |
| --------------------------------------------- | ---------------------- |
| F1 — compiled `bin/lens` can't find templates | Fixed (`164019e`)      |
| F2 — runner enters plan mode                  | Fixed (`54654ff`)      |
| F3 — `lens init` no integrity check           | Fixed (`9d656da`)      |
| F4 — runner missing `Grep`/`Glob`             | Fixed (`54654ff`)      |
| F5 — `pull` doesn't refresh `sync` entry      | Fixed (`3ac9936`)      |
| F6 — `mark` doesn't refresh lockfile          | Fixed (`dc32182`)      |
| F7 — positive quality observations            | N/A (no fix needed)    |

## Findings

### F1 — compiled `bin/lens` can't resolve templates

`bun run build:bin` produces a single-file compiled binary. At runtime,
`src/templates.ts:19-22` resolves `templatePath(name)` from
`import.meta.url`, which inside the compiled binary becomes
`/$bunfs/src/templates.ts`. `resolve(here, "..", "templates", ...)` then
yields `/$bunfs/templates/cli.yaml` — a path that doesn't exist on disk.

Observed error: `lens: template "cli" not found at
/$bunfs/templates/cli.yaml.`

CLAUDE.md already notes the compiled binary is "local use only, not
published." But even local use is broken — `lens init` (the main thing
you'd want locally) can't find templates. Fix options:

- Embed the `templates/` directory into the compile step (`bun build
  --compile` with embedded files).
- Explicitly error "templates unavailable in compiled binary; use
  `dist/lens.js`" if the compiled path is detected.
- Delete `build:bin` from `package.json` since it doesn't work.

### F2 — default runner enters plan mode

The shipped runner string
(`claude --allowed-tools Read,Write,Edit,Bash --print {prompt}`) runs a
nested Claude Code session. Observed: the nested Claude decided to enter
plan mode and wrote a plan file to `~/.claude/plans/...md` instead of
populating the lens files. `lens init` returned exit 0 and all five lens
files remained 0 bytes.

Cause: `claude --print` in headless mode defaults to a permission mode
that allows the model to opt into plan mode. The generate prompt's
"populate files" instruction was paraphrased into a plan.

Fix: the shipped runner in `templates/*.yaml` should include
`--permission-mode acceptEdits` so the headless session commits to edits
rather than opting into plan mode. Dogfooding used
`LENS_RUNNER_OVERRIDE='claude --allowed-tools Read,Write,Edit,Bash
--permission-mode acceptEdits --print {prompt}'` and that worked.

### F3 — `lens init` has no integrity check on runner output

When the runner exits 0 but writes nothing (F2), `init` still:

1. Hashes the empty lens files and writes them into `.lens/lock.json`.
2. Prints `lens: initialized .lenses/config.yaml (5 lenses). Review
   .lenses/, commit, then edit any lens to start iterating.`
3. Advances `refs/lens/synced`.

A later user wouldn't know anything went wrong until they opened an empty
lens file. Suggested check: after the runner returns 0, if the union of
lens file sizes didn't grow from baseline (all lens files were 0 bytes
pre-runner, all 0 bytes post-runner), emit a warning and suggest
rerunning or inspecting the runner output.

### F4 — default runner missing `Grep` and `Glob`

When `lens pull` sees >50 changed files, it substitutes
`(content omitted: N changed files exceeds prompt cap of 50)` for each
file instead of the file content (see
`src/cli/pull.ts:230-247`). In that branch the nested Claude needs
non-Bash file-exploration tools to do useful work.

The shipped allow-list is `Read,Write,Edit,Bash` — no `Grep` or `Glob`.
The nested Claude can work around via `bash grep` but it's clunky.
Dogfooding used `Read,Write,Edit,Bash,Grep,Glob` in the override and the
runner used Glob/Grep naturally.

Fix: update `templates/*.yaml` runners to
`claude --allowed-tools Read,Write,Edit,Bash,Grep,Glob
--permission-mode acceptEdits --print {prompt}`.

### F5 — `lens pull` doesn't refresh the `sync` task entry in lockfile

After `pull` modifies lens files:

- `.lens/lock.json` gets an updated `pull` entry (new hashes).
- `.lens/lock.json`'s `sync` entry keeps its pre-pull hashes.

Next `lens status` invocation compares current file hashes against
`lock.tasks.sync.files` and reports:

    ⚠ flags       .lenses/flags.md       edited since last sync
    ⚠ manpage     .lenses/manpage.md     edited since last sync

with the suggestion "Run `lens sync` to propagate flags.md edits to other
lenses". This is misleading — the lenses are consistent (pull just made
them match code; no edit drift exists). Running `sync` at this point
would invoke the runner to sync files against themselves.

Fix options (pick one):

- Pull's post-mutation bookkeeping also refreshes
  `lock.tasks.sync.files` for any lens it wrote to. Rationale: pull's
  effect on lens files is expected to produce an internally-consistent
  state (it's written from a single prompt).
- Status-check logic reads both `sync` and `pull` task entries and
  prefers the newer one per-file.

### F6 — `lens mark <synced|applied>` doesn't refresh lockfile entries

Related to F5. `mark` advances the ref but ignores `.lens/lock.json`
(see `src/cli/mark.ts:45`). After a user does `pull → commit → mark
applied → mark synced`, the sync entry in the lockfile is still stale.

Fix: `mark <which>` should also recompute hashes for all lens files and
write them into the corresponding `lock.tasks.<which>` entry as part of
"blessing current state."

### F7 — quality observations (positive)

- Generate prompt produced accurate lens content from **intent alone**.
  The cli template + a well-phrased description was enough for the runner
  to correctly enumerate 10 verbs, 8 flags, 4 exit codes, and
  cross-references. No hallucination observed.
- Pull caught one real drift in the generated content: `commands.md`
  claimed `lens init` returns exit code 2 for a specific failure mode,
  but the actual path returns 1 via `Exit.FAIL`. Corrected surgically.
- Sync correctly pruned propagation: adding `--json` to `commands.md`
  cascaded into `flags.md`, `manpage.md` (3 places), `scenarios.md`
  (variants section). `exit-codes.md` correctly untouched. No
  `.lens/conflicts.md` created.
- Pull correctly pruned propagation: adding `-t` short alias in code
  surfaced only in `flags.md` and `manpage.md`. The other three lenses
  don't track short aliases and were correctly untouched.

## Implications for Phase B (`/lens:init` skill)

- The skill should set `LENS_RUNNER_OVERRIDE` (with
  `--permission-mode acceptEdits` and `Grep,Glob` added) when it
  invokes `lens init` on behalf of the user, at least until F2/F4 are
  fixed in the shipped templates.
- The skill's drafted intent quality matters: F7 shows that a detailed
  intent produces detailed lenses. The skill should invest in reading
  README.md and package.json well.
- The skill should recommend `/lens:pull` as a follow-up to `/lens:init`
  for existing codebases — because init's intent-driven generation won't
  read code, only pull grounds lenses in actual implementation.
