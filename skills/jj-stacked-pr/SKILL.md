---
name: jj-stacked-pr
description: Manage pi-jj stacked PR workflows safely. Use when the user wants jj stack status, PR planning, or publishing/updating stacked PRs with GitHub.
---

# JJ Stacked PR Flow

Use this skill for stack-aware PR workflows in repos using the `pi-jj` extension.

## Goals

- Inspect stack state before publishing.
- Prefer safe dry-run behavior first.
- Publish/update stacked PRs only after explicit user confirmation.

## Preferred execution path

Use the `jj_stack_pr_flow` tool first (it queues the right slash command):

1. `action: "status"` → `/jj-stack-status`
2. `action: "plan"` (optional `remote`) → `/jj-pr-plan ...`
3. `action: "publish", dryRun: true` → `/jj-pr-publish --dry-run ...`
4. Ask user to confirm real publish
5. `action: "publish", dryRun: false` (optional `draft`) → `/jj-pr-publish ...`

## Safety rules

- Do **not** publish non-dry-run unless user explicitly asks.
- If repo is not initialized for jj, run `action: "init"` (or ask user first if uncertain).
- If publish fails due to auth, instruct user to run `gh auth login`.
- After publish, summarize PR numbers/URLs and next actions.

## Fallback (if tool unavailable)

Run slash commands directly in this order:

```text
/jj-stack-status
/jj-pr-plan [--remote origin]
/jj-pr-publish --dry-run [--remote origin]
# after explicit approval
/jj-pr-publish [--draft] [--remote origin]
```
