# Flags

Every flag accepted by `lens`, canonical in one table. Per-command behavior
that diverges from the default is noted in the **Notes** column;
command-specific prose lives in `commands.md`.

| Name            | Short | Type    | Default    | Applies to                                         | Notes                                                                                            |
| --------------- | ----- | ------- | ---------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `--config`      | `-c`  | string  | _(unset)_  | global (every verb)                                | Override config discovery. When unset, `lens` searches `lens.yml`, then `lens.yaml`, then `lens.jsonc`, then `lens.json`. |
| `--help`        | `-h`  | boolean | `false`    | global                                             | Print the usage banner and exit `0`. The verb `lens help` behaves identically.                   |
| `--version`     | `-v`  | boolean | `false`    | global                                             | Print the package version and exit `0`. The verb `lens version` behaves identically.             |
| `--dry-run`     | `-n`  | boolean | `false`    | `init`, `sync`, `pull`, `apply`, `add`             | Print what would happen (assembled prompt or config YAML or bundle) without invoking the runner, writing files, or advancing refs. Never accepted by `diff`, `validate`, `status`, `mark`. |
| `--force`       | `-f`  | boolean | `false`    | `init`, `sync`, `pull`                             | `init`: overwrite an existing `lens.yml`. `sync`/`pull`: run even when hashes show no drift. Ignored elsewhere. |
| `--template`    | `-t`  | string  | `webapp`   | `init`                                             | Starter template. Ships: `webapp`, `cli`, `library`, `pipeline`, `protocol`, `blank`.           |
| `--description` |       | string  | _(unset)_  | `add` (required)                                   | Human description of the new lens. Must be non-empty. Also accepted (unused) on other verbs.     |
| `--path`        | `-p`  | string  | `.lenses/<name>.md` | `add`                                     | Override the file path for the new lens.                                                         |
| `--json`        |       | boolean | `false`    | `status`                                           | Emit the status report as a single JSON object on stdout, for scripting and CI integrations.     |

## Canonical rules

- **Shorts are stable.** `-h`, `-v`, `-f`, `-n`, `-p`, `-c`, `-t` always
  map to the long form above.
- **Flag parsing is strict.** Unknown flags surface as `lens: <parse
  error>` and exit `1` (see `exit-codes.md`). Positional-vs-flag order is
  not enforced: `lens init --template cli "my app"` and `lens init "my
  app" --template cli` are equivalent.
- **`--dry-run` is read-only in full.** No filesystem writes, no runner
  invocation, no ref advancement — including for verbs where `--dry-run`
  is not accepted (those simply don't perform runner work in the first
  place).
