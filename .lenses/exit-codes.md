# Exit codes

Canonical numbered mapping. All examples, help text, manpage prose, and
command documentation must align with this list.

| Code | Meaning                     | Condition that returns it                                                                                                                                                                                                      |
| ---- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Success                     | The verb completed without error. For `sync`/`pull`, also returned when there is nothing to do (hashes show no drift and `--force` is not set).                                                                                 |
| 1    | Operation failed            | Catch-all for per-verb failures: runner exited non-zero; a lens file is missing on disk; `lens add` was called with a duplicate name or empty description; `lens init` found an existing config without `--force`; an unknown verb was passed; CLI argument parsing failed; `lens validate` reported a hard-check failure; `lens mark` rejected because the ref already points at HEAD. |
| 2    | Config missing or invalid   | `lens.yml` (or `lens.yaml`/`lens.jsonc`/`lens.json`) could not be discovered, could not be read, or failed Zod schema validation. Returned before any runner invocation or lockfile write.                                      |
| 3    | Git state incompatible      | A verb that requires a git repo was run outside one, or HEAD could not be resolved. Currently only `lens mark <synced\|applied>` returns this — other verbs degrade gracefully (they skip ref advancement) instead of erroring. |

## Notes

- The four codes are exhaustive. If you catch yourself writing "exit 4" or
  "exit 99" somewhere, fold the condition into `1` unless it is genuinely
  a new class of failure worth documenting here first.
- Warnings in `lens validate` (unresolved `pullSources` globs) do **not**
  escalate to exit `1`. Only hard-check failures do.
- Ref-advancement is always best-effort inside `sync`/`pull`/`init`/`add`.
  A failure to write `refs/lens/synced` or `refs/lens/applied` after a
  successful runner pass does not change the exit code — the verb still
  exits `0` and prints guidance to run `lens mark <synced|applied>`.
