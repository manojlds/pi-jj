# pi-jj

Pi extension package for **Jujutsu-first** workflows.

## Features

- **Checkpoints**: automatic jj snapshots on every agent turn with rewind support
- **Stacked PRs**: inspect, plan, publish, and sync stacked PRs via GitHub
- **Onboarding**: guided jj init with user/email config and restore mode selection
- **Agent integration**: LLM-callable tool + packaged skill for safe stacked-PR workflows

## How it works

### Onboarding

On first prompt in a git repo that isn't yet a jj repo, the extension offers to initialize:

1. `jj git init --colocate` to set up jj alongside git
2. Checks `user.name` / `user.email` — if missing, offers to copy from git config (`jj config set --repo`)
3. Prompts for restore mode preference (`file` or `operation`)

You can also run `/jj-init` manually. `/jj-deinit` removes jj metadata (`/jj-deinit full` also cleans `refs/jj/*`).

### Checkpoint system

**Capture**: On the first agent turn per prompt, the extension snapshots:
- `commit_id` (revision) — the exact file state
- `change_id` — stable identity across rewrites
- `operation_id` (pre-turn) — jj operation before the agent ran
- `operation_id` (post-turn) — jj operation after the agent finished

These are persisted as `jj-checkpoint` session custom entries and the user's chat entry is labeled `jj:<change-short>` for `/tree` navigation.

**Restore** (via `/fork`, `/tree`, or `/jj-checkpoints`):

Two modes, configurable via `restoreMode` setting:

| Mode | Command | What it restores | Trade-offs |
|------|---------|-----------------|------------|
| `file` (default) | `jj restore --from <revision>` | File contents only | Safe, no side effects on bookmarks or op history |
| `operation` | `jj op restore <operationId>` + `jj git fetch --all-remotes` | Full repo state (working copy, bookmarks, visible heads) | More complete but rewinds operation history; auto-fetches to resync remotes |

When navigating to a **user message** in `/tree`, the pre-turn operation ID is used (state before the agent ran). When navigating to an **agent message**, the post-turn operation ID is used (state after the agent finished).

Undo always uses `jj op restore` back to the pre-restore operation, regardless of mode.

**Commands**:
- `/jj-checkpoints` — interactive picker with restore/copy/details actions
- `/jj-checkpoints plain` — text list

### Stacked PR flow

The stacked PR system manages a linear stack of jj changes as GitHub PRs with correct base targeting.

#### jj concepts used

- **Change**: a stable unit of work with a `change_id` that persists across amends/rebases
- **Commit** (revision): an immutable snapshot; each change can have many commits over time
- **Bookmark**: jj's equivalent of a git branch — required for pushing to a remote
- **Operation**: a point-in-time snapshot of the entire repo state

#### Stack detection

The extension uses the revset `(ancestors(@) | descendants(@)) & mutable()` with `--reversed` to find all mutable changes in the current stack, ordered bottom-up from trunk. Empty changes with no description (typically the working copy `@`) are filtered out.

#### Flow

**1. Inspect** — `/jj-stack-status`

Shows current revision/change/operation, checkpoint count, latest PR snapshot, and the mutable stack with per-change PR state:

```
stack:
1. ksrmwuon rev:abc123 auth refactor (pr:#1 open)
2. yqosqzzy rev:def456 add login endpoint (pr:#2 open)
3. mzvwutvl rev:ghi789 add tests (pr:-)
```

**2. Plan** — `/jj-pr-plan [--remote origin]`

For each stack entry, computes:
- **Bookmark name**: `push-<change-id-short>` (jj's default convention)
- **Base target**: first change → repo default branch (e.g. `main`), subsequent changes → previous change's bookmark
- Shows the exact commands that will run

**3. Publish** — `/jj-pr-publish [--dry-run] [--draft] [--remote origin]`

For each change, bottom-up:
1. `jj bookmark set push-<short> -r <changeId>` — attach a named bookmark
2. `jj git push --bookmark push-<short> --remote origin` — push to remote
3. `gh pr create --head push-<short> --base <base>` — create PR (or `gh pr edit` to update if PR exists and is open)

Base targeting creates the PR dependency chain:
```
PR #1 (auth refactor)       base: main
PR #2 (add login endpoint)  base: push-ksrmwuon  (PR #1's branch)
PR #3 (add tests)           base: push-yqosqzzy  (PR #2's branch)
```

`--dry-run` reports the plan without pushing or creating PRs. `--draft` creates draft PRs.

**4. Update after amending**

When you amend a change mid-stack, jj automatically rebases all descendants. Just re-run `/jj-pr-publish` — it sets the same bookmarks on the (now rewritten) commits and pushes the updated state.

**5. Sync** — `/jj-pr-sync [--remote origin]`

Queries GitHub for current PR state and:
- Updates session labels with PR numbers and state (`pr:#1 merged`, `pr:#2 open`)
- **Retargets bases after merges**: if PR #1 merged, PR #2's base is automatically changed from `push-ksrmwuon` to `main` via `gh pr edit --base`
- Reports retargeted PRs in the output

The retargeting logic walks backward through the stack: for each open PR, it finds the nearest ancestor that is still open. If all ancestors are merged/closed, the base becomes the default branch.

**6. Close stack (optional after all merges)** — `/jj-stack-close [--remote origin]`

Closes out a finished stack by:
- refreshing PR state first and refusing to proceed if PRs are still open (unless `--force`)
- deleting stack `push-*` bookmarks (unless `--keep-bookmarks`)
- pushing bookmark deletions to the remote (with fetch + one retry on stale-ref errors)
- creating a fresh working change from `main@origin` (`--no-new-change` to skip)

Use `--dry-run` first to preview actions.

#### Agent integration

The flow is accessible to the LLM via two mechanisms:

**Tool**: `jj_stack_pr_flow` — executes stack commands directly by default (set `queue: true` only when explicit follow-up queuing is desired). Actions: `status`, `checkpoints`, `init`, `plan`, `publish`, `sync`, `close`, `settings`, `settings-reload`. Publish defaults to `--dry-run` unless `dryRun: false` is explicitly passed.

**Skill**: `jj-stacked-pr` (invoke via `/skill:jj-stacked-pr`) — guides the model through the safe execution path:
1. Status → 2. Plan → 3. Dry-run publish → 4. User confirms → 5. Real publish → 6. Sync

### Commands reference

| Command | Description |
|---------|-------------|
| `/jj-init` | Initialize git repo for jj (`jj git init --colocate`) |
| `/jj-deinit [full]` | Remove jj metadata (optionally clean `refs/jj/*`) |
| `/jj-checkpoints [plain]` | Interactive checkpoint picker or plain text list |
| `/jj-stack-status` | Current revision/change/op + stack + PR state |
| `/jj-pr-plan [--remote]` | Preview stacked PR publish plan |
| `/jj-pr-publish [--dry-run] [--draft] [--remote]` | Publish/update stacked PRs |
| `/jj-pr-sync [--remote]` | Sync PR state from GitHub + retarget merged bases |
| `/jj-stack-close [--remote] [--dry-run] [--keep-bookmarks] [--no-new-change] [--force]` | Close completed stack and optionally clean push bookmarks |
| `/jj-settings [reload]` | Show or reload extension settings |

## Configuration

Add optional settings under `piJj` in `~/.pi/agent/settings.json`:

```json
{
  "piJj": {
    "silentCheckpoints": false,
    "maxCheckpoints": 200,
    "checkpointListLimit": 30,
    "promptForInit": true,
    "promptForPublishMode": true,
    "autoSyncOnPublish": true,
    "restoreMode": "file"
  }
}
```

- `silentCheckpoints` (default `false`): hide per-turn checkpoint notifications and show a compact status (`pi-jj: ready`).
- `maxCheckpoints` (default `200`, clamped `10..5000`): max in-memory/session-rebuilt checkpoints kept for rewind resolution.
- `checkpointListLimit` (default `30`, clamped `5..200`): number of checkpoints shown in `/jj-checkpoints` UI/plain list.
- `promptForInit` (default `true`): whether to ask to initialize jj on first submitted prompt in git repos.
- `promptForPublishMode` (default `true`): for `/jj-pr-publish` without `--dry-run`, show a mode picker (`Dry-run first`, `Publish now`, `Cancel`).
- `autoSyncOnPublish` (default `true`): refresh PR state from GitHub before publish/dry-run and after real publish.
- `restoreMode` (default `"file"`): checkpoint restore strategy. `"file"` uses `jj restore --from` (file contents only). `"operation"` uses `jj op restore` (full repo state, with auto `jj git fetch` to resync).

## Install

Recommended (loads extension + packaged skills):

```json
{
  "packages": [
    "/absolute/path/to/pi-jj"
  ]
}
```

Then restart Pi or run `/reload`.

Advanced/manual (extension path only):

```json
{
  "extensions": ["/absolute/path/to/pi-jj/index.ts"],
  "skills": ["/absolute/path/to/pi-jj/skills"]
}
```
