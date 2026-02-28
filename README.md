# pi-jj

Pi extension package for **Jujutsu-first** workflows.

## Current feature set

- `jj` checkpoints on every agent loop (first turn per prompt)
- Rewind/restore integration for `/fork` and `/tree`
- Optional undo of last file rewind
- Session-persisted checkpoint metadata (`jj-checkpoint` custom entries)
- **Onboarding prompt**: on first submitted prompt in a git repo that is not yet a jj repo, extension offers:
  - `Yes (jj git init --colocate)`
  - `Not now`
- `/jj-init` command to initialize a git repo for jj manually
- `/jj-checkpoints` command for quick checkpoint summary

## Why prompt for jj init?

Yes — for a jj-focused package, prompting once per session is a good UX:
- it removes setup friction,
- keeps users in-flow,
- and makes jj behavior explicit instead of silently doing nothing.

The extension only prompts when:
1. repo is not already a jj repo,
2. repo is a git repo,
3. UI is interactive.

## Install

Add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/absolute/path/to/pi-jj/index.ts"
  ]
}
```

Then restart Pi or run `/reload`.

## Next package evolution

- Split into multiple extensions (e.g. `jj-rewind`, `jj-workspace`, `jj-log-tools`)
- Add companion skills under `.pi/skills/` or package resources
- Add configurable policies in settings (`silentCheckpoints`, max checkpoints, onboarding behavior)
