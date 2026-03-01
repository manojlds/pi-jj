import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type JjToolInput = {
  action: string;
  remote?: string;
  dryRun?: boolean;
  draft?: boolean;
  args?: string;
};

function safeTrim(value?: string): string {
  return (value ?? "").trim();
}

export function registerTools(pi: ExtensionAPI) {
  const supportedActions = ["status", "checkpoints", "init", "plan", "publish", "sync", "settings", "settings-reload"];

  pi.registerTool({
    name: "jj_stack_pr_flow",
    label: "JJ Stack PR Flow",
    description:
      "Queue pi-jj slash commands as follow-ups for stack status, planning, publishing, and PR sync. For publish, defaults to --dry-run unless dryRun is explicitly set to false.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "One of: status, checkpoints, init, plan, publish, sync, settings, settings-reload",
        },
        remote: { type: "string", description: "Git remote name (e.g. origin)" },
        dryRun: { type: "boolean", description: "For action=publish; default true if omitted" },
        draft: { type: "boolean", description: "For action=publish; create draft PRs" },
        args: { type: "string", description: "Additional raw args appended to the slash command" },
      },
      required: ["action"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params) {
      const input = (params ?? {}) as JjToolInput;
      const action = safeTrim(input.action).toLowerCase();
      const remote = safeTrim(input.remote);
      const extraArgs = safeTrim(input.args);

      let command = "";
      let note = "";

      if (action === "status") {
        command = "/jj-stack-status";
      } else if (action === "checkpoints") {
        command = "/jj-checkpoints plain";
      } else if (action === "init") {
        command = "/jj-init";
      } else if (action === "plan") {
        command = `/jj-pr-plan${remote ? ` --remote ${remote}` : ""}${extraArgs ? ` ${extraArgs}` : ""}`;
      } else if (action === "publish") {
        const dryRun = input.dryRun ?? true;
        const draft = input.draft ?? false;
        command = `/jj-pr-publish${dryRun ? " --dry-run" : ""}${draft ? " --draft" : ""}${remote ? ` --remote ${remote}` : ""}${extraArgs ? ` ${extraArgs}` : ""}`;
        if (input.dryRun === undefined) {
          note = "(safe default applied: --dry-run)";
        }
      } else if (action === "sync") {
        command = `/jj-pr-sync${remote ? ` --remote ${remote}` : ""}${extraArgs ? ` ${extraArgs}` : ""}`;
      } else if (action === "settings") {
        command = "/jj-settings";
      } else if (action === "settings-reload") {
        command = "/jj-settings reload";
      } else {
        return {
          content: [
            {
              type: "text",
              text: `Unsupported action. Use one of: ${supportedActions.join(", ")}.`,
            },
          ],
          details: {
            supportedActions,
            action,
            command: "",
            note: "unsupported action",
          },
        };
      }

      pi.sendUserMessage(command, { deliverAs: "followUp" });

      return {
        content: [{ type: "text", text: `Queued ${command} as follow-up ${note}`.trim() }],
        details: {
          supportedActions,
          action,
          command,
          note,
        },
      };
    },
  });
}
