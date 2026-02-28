# pi-jj Agent Guidance

When working in this repository (or when this package is installed), prefer jj-native workflows.

## Stacked PR workflow

For stacked PR tasks, use this sequence:

1. Check current state
   - Tool: `jj_stack_pr_flow` with `action: "status"`
   - Command fallback: `/jj-stack-status`
2. Build publish plan
   - Tool: `jj_stack_pr_flow` with `action: "plan"`
   - Command fallback: `/jj-pr-plan [--remote origin]`
3. Validate with dry-run
   - Tool: `jj_stack_pr_flow` with `action: "publish", dryRun: true`
   - Command fallback: `/jj-pr-publish --dry-run [--remote origin]`
4. Only after explicit user confirmation, do real publish
   - Tool: `jj_stack_pr_flow` with `action: "publish", dryRun: false`
   - Command fallback: `/jj-pr-publish [--draft] [--remote origin]`

## Safety

- Default to dry-run for publish actions.
- Never do non-dry-run publish without explicit user consent.
- If not in jj repo, initialize with `/jj-init` (or tool action `init`) after user confirmation.
- If GitHub auth is missing, prompt the user to run `gh auth login`.

## Skills

- Use `/skill:jj-stacked-pr` for stack PR operations.
