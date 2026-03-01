import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { PiJjRuntime } from "./runtime";

type JjToolInput = {
  action: string;
  remote?: string;
  dryRun?: boolean;
  draft?: boolean;
  queue?: boolean;
  args?: string;
};

function safeTrim(value?: string): string {
  return (value ?? "").trim();
}

function buildArgs(parts: Array<string | undefined>): string {
  return parts
    .map((part) => safeTrim(part))
    .filter(Boolean)
    .join(" ");
}

function formatCommand(name: string, args: string): string {
  return args ? `${name} ${args}` : name;
}

async function executeAction(runtime: PiJjRuntime, action: string, args: string, ctx: ExtensionContext): Promise<string> {
  if (action === "status") {
    await runtime.commandJjStackStatus(args, ctx);
    return formatCommand("/jj-stack-status", args);
  }
  if (action === "checkpoints") {
    const commandArgs = args || "plain";
    await runtime.commandJjCheckpoints(commandArgs, ctx);
    return formatCommand("/jj-checkpoints", commandArgs);
  }
  if (action === "init") {
    await runtime.commandJjInit(args, ctx);
    return formatCommand("/jj-init", args);
  }
  if (action === "plan") {
    await runtime.commandJjPrPlan(args, ctx);
    return formatCommand("/jj-pr-plan", args);
  }
  if (action === "publish") {
    await runtime.commandJjPrPublish(args, ctx);
    return formatCommand("/jj-pr-publish", args);
  }
  if (action === "sync") {
    await runtime.commandJjPrSync(args, ctx);
    return formatCommand("/jj-pr-sync", args);
  }
  if (action === "settings") {
    await runtime.commandJjSettings(args, ctx);
    return formatCommand("/jj-settings", args);
  }
  if (action === "settings-reload") {
    const commandArgs = args || "reload";
    await runtime.commandJjSettings(commandArgs, ctx);
    return formatCommand("/jj-settings", commandArgs);
  }

  throw new Error(`Unsupported action: ${action}`);
}

export function registerTools(pi: ExtensionAPI, runtime: PiJjRuntime) {
  const supportedActions = ["status", "checkpoints", "init", "plan", "publish", "sync", "settings", "settings-reload"];

  pi.registerTool({
    name: "jj_stack_pr_flow",
    label: "JJ Stack PR Flow",
    description:
      "Run pi-jj stack commands directly for status, planning, publish (dry-run by default), and sync. Set queue=true only if you explicitly want follow-up command queuing.",
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
        queue: {
          type: "boolean",
          description: "If true, queue a slash command follow-up instead of executing now (default false)",
        },
        args: { type: "string", description: "Additional raw args appended to the command" },
      },
      required: ["action"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = (params ?? {}) as JjToolInput;
      const action = safeTrim(input.action).toLowerCase();
      const remote = safeTrim(input.remote);
      const extraArgs = safeTrim(input.args);

      const detailsBase = {
        supportedActions,
        action,
        command: "",
        note: "",
        mode: input.queue ? "queue" : "execute",
        ok: false,
      };

      if (!supportedActions.includes(action)) {
        return {
          content: [
            {
              type: "text",
              text: `Unsupported action. Use one of: ${supportedActions.join(", ")}.`,
            },
          ],
          details: {
            ...detailsBase,
            note: "unsupported action",
          },
        };
      }

      let args = "";
      let note = "";

      if (action === "publish") {
        const dryRun = input.dryRun ?? true;
        const draft = input.draft ?? false;
        args = buildArgs([
          dryRun ? "--dry-run" : "",
          draft ? "--draft" : "",
          remote ? `--remote ${remote}` : "",
          extraArgs,
        ]);
        if (input.dryRun === undefined) {
          note = "safe default applied: --dry-run";
        }
      } else if (action === "plan" || action === "sync") {
        args = buildArgs([remote ? `--remote ${remote}` : "", extraArgs]);
      } else if (action === "status" || action === "init") {
        args = buildArgs([extraArgs]);
      } else if (action === "checkpoints") {
        args = buildArgs([extraArgs || "plain"]);
      } else if (action === "settings") {
        args = buildArgs([extraArgs]);
      } else if (action === "settings-reload") {
        args = buildArgs([extraArgs || "reload"]);
      }

      const commandName =
        action === "status"
          ? "/jj-stack-status"
          : action === "checkpoints"
            ? "/jj-checkpoints"
            : action === "init"
              ? "/jj-init"
              : action === "plan"
                ? "/jj-pr-plan"
                : action === "publish"
                  ? "/jj-pr-publish"
                  : action === "sync"
                    ? "/jj-pr-sync"
                    : "/jj-settings";
      const command = formatCommand(commandName, args);

      if (input.queue) {
        pi.sendUserMessage(command, { deliverAs: "followUp" });
        return {
          content: [{ type: "text", text: `Queued ${command} as follow-up.` }],
          details: {
            ...detailsBase,
            command,
            note,
            ok: true,
          },
        };
      }

      try {
        const executedCommand = await executeAction(runtime, action, args, ctx);
        return {
          content: [{ type: "text", text: `Executed ${executedCommand}${note ? ` (${note})` : ""}.` }],
          details: {
            ...detailsBase,
            command: executedCommand,
            note,
            ok: true,
          },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to execute ${command}: ${String(error)}` }],
          details: {
            ...detailsBase,
            command,
            note: String(error),
            ok: false,
          },
        };
      }
    },
  });
}
