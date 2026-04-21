# Lens Claude Plugin

Install:
- `cp -r plugin ~/.claude/plugins/lens`
- For local development: `ln -s "$(pwd)/plugin" ~/.claude/plugins/lens`

Requires the Lens CLI:
- `npm i -g lens-engine`

Commands:
- `/lens:init [description]` — initialize Lens in the current directory. With no description, surveys the repo (like Claude's `/init`) to propose a template and draft the intent before calling the CLI.
- `/lens:sync` — sync lens artifacts from the current workspace state.
- `/lens:status` — show Lens status for the current directory.
- `/lens:apply` — open plan mode from `lens apply --dry-run` context.
- `/lens:mark synced` — advance `refs/lens/synced` to `HEAD`.
- `/lens:mark applied` — advance `refs/lens/applied` to `HEAD`.
- `/lens:pull` — placeholder for the future `lens pull` command.
- `/lens:add` — placeholder for the future `lens add` command.
