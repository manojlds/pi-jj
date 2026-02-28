# pi-jj

Pi extension package for **Jujutsu-first** workflows.

## Current feature set

- `jj` checkpoints on every agent loop (first turn per prompt)
- checkpoint metadata captures revision + change id + operation id
- Rewind/restore integration for `/fork` and `/tree`
- Optional undo of last file rewind
- Session-persisted checkpoint metadata (`jj-checkpoint` custom entries)
- auto-labels Pi entries as `jj:<change-short>` for easier `/tree` navigation
- **Onboarding prompt**: on first submitted prompt in a git repo that is not yet a jj repo, extension offers:
  - `Yes (jj git init --colocate)`
  - `Not now`
- `/jj-init` command to initialize a git repo for jj manually
- `/jj-deinit` command to remove jj metadata for test/reset workflows
  - `/jj-deinit` => remove `.jj` only
  - `/jj-deinit full` => remove `.jj` + delete `refs/jj/*`
- `/jj-checkpoints` command with interactive checkpoint UI
  - `/jj-checkpoints` => interactive picker + actions (restore/copy/show)
  - `/jj-checkpoints plain` => plain text list
- `/jj-stack-status` command for current revision/change/op + mutable stack + latest checkpoint summary
- `/jj-pr-plan` command for stacked PR plan (`/jj-pr-plan [--remote origin]`)
- `/jj-pr-publish` command to publish/update stacked PRs
  - supports `--dry-run`, `--draft`, and `--remote <name>`
- `/jj-settings` command to inspect/reload effective extension settings
- LLM-callable tool: `jj_stack_pr_flow` (queues slash commands as follow-up messages)
- Packaged skill: `jj-stacked-pr` (`/skill:jj-stacked-pr`) for safe stacked-PR execution flow

## Existing flow (today)

### 1) Session start / onboarding

- If repo is already a jj repo: extension starts in ready mode.
- If repo is a git repo but not a jj repo:
  - on first submitted prompt, Pi asks whether to run `jj git init --colocate`.
  - you can also run `/jj-init` manually.
- If repo is not a git repo: extension is inactive (`pi-jj: not a git repo`).

### 2) Checkpoint capture per prompt

- On first agent turn for each prompt, extension captures:
  - current revision
  - current change id
  - current operation id
- At turn end, it stores checkpoint metadata as a session custom entry (`jj-checkpoint`) and labels the user entry as `jj:<change-short>`.

Useful command:
- `/jj-checkpoints` (interactive)
- `/jj-checkpoints plain` (text list)

### 3) Rewind behavior for `/fork` and `/tree`

When navigating history, extension offers rewind options:
- keep conversation only / keep current files
- restore files from matched checkpoint revision
- restore files only (for fork flow)
- undo last file rewind

Current rewind implementation is **code-only restore** via `jj restore --from <revision>`.

### 4) Stack inspection and plan

- `/jj-stack-status` shows:
  - current revision/change/op
  - checkpoint summary
  - mutable stack entries around `@`
- `/jj-pr-plan [--remote origin]` shows per-change stacked publish intent:
  - generated branch name (`push-<change-short>`)
  - computed base target (default branch for first PR, previous stack branch for later PRs)
  - dry-run push command

### 5) Publish/update stacked PRs

- `/jj-pr-publish [--dry-run] [--draft] [--remote origin]`
- Flow:
  1. verify jj repo + detect stack
  2. verify GitHub auth (`gh auth status`)
  3. confirm plan in UI
  4. for each stack node:
     - push change (`jj git push --change <changeId> --remote <remote>`)
     - create PR if none exists for head branch
     - update PR (base/title/body) if existing PR is open
  5. persist publish metadata as `jj-pr-state` session custom entry
  6. update latest matching checkpoint label with `pr:#<number>` when available

Notes:
- existing closed/merged PRs are currently not reopened/recreated by this command.
- `--dry-run` reports planned records without pushing/creating PRs.

### 6) Agent-callable flow (tool + skill)

To make this flow callable by the model (not only by user slash commands), the package includes:

- Tool: `jj_stack_pr_flow`
  - actions: `status`, `checkpoints`, `init`, `plan`, `publish`, `settings`, `settings-reload`
  - publish defaults to `--dry-run` unless `dryRun=false` is explicitly passed
  - implementation queues follow-up slash commands (e.g. `/jj-pr-plan`, `/jj-pr-publish ...`)
- Skill: `jj-stacked-pr`
  - invoke manually via `/skill:jj-stacked-pr`
  - guides the model through status → plan → dry-run publish → confirmed real publish

### 7) Reset / teardown

- `/jj-deinit` removes `.jj` only
- `/jj-deinit full` removes `.jj` and deletes `refs/jj/*`

## Why prompt for jj init?

Yes — for a jj-focused package, prompting once per session is a good UX:
- it removes setup friction,
- keeps users in-flow,
- and makes jj behavior explicit instead of silently doing nothing.

The extension only prompts when:
1. repo is not already a jj repo,
2. repo is a git repo,
3. UI is interactive,
4. `piJj.promptForInit` is not set to `false`.

## Configuration

Add optional settings under `piJj` in `~/.pi/agent/settings.json`:

```json
{
  "piJj": {
    "silentCheckpoints": false,
    "maxCheckpoints": 200,
    "checkpointListLimit": 30,
    "promptForInit": true
  }
}
```

- `silentCheckpoints` (default `false`): hide per-turn checkpoint notifications and show a compact status (`pi-jj: ready`).
- `maxCheckpoints` (default `200`, clamped `10..5000`): max in-memory/session-rebuilt checkpoints kept for rewind resolution.
- `checkpointListLimit` (default `30`, clamped `5..200`): number of checkpoints shown in `/jj-checkpoints` UI/plain list.
- `promptForInit` (default `true`): whether to ask to initialize jj on first submitted prompt in git repos.

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
