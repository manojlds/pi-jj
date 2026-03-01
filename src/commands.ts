import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { PiJjRuntime } from "./runtime";

export function registerCommands(pi: ExtensionAPI, runtime: PiJjRuntime) {
  pi.registerCommand("jj-init", {
    description: "Initialize current git repo as a colocated jj repo",
    handler: async (args, ctx) => {
      await runtime.commandJjInit(args, ctx);
    },
  });

  pi.registerCommand("jj-deinit", {
    description: "Remove jj metadata from current repo (usage: /jj-deinit [full])",
    handler: async (args, ctx) => {
      await runtime.commandJjDeinit(args, ctx);
    },
  });

  pi.registerCommand("jj-checkpoints", {
    description: "Checkpoint UI (usage: /jj-checkpoints [plain])",
    handler: async (args, ctx) => {
      await runtime.commandJjCheckpoints(args, ctx);
    },
  });

  pi.registerCommand("jj-stack-status", {
    description: "Show stack status (interactive UI; usage: /jj-stack-status [plain])",
    handler: async (args, ctx) => {
      await runtime.commandJjStackStatus(args, ctx);
    },
  });

  pi.registerCommand("jj-pr-plan", {
    description: "Preview stacked PR publish plan (interactive UI; usage: /jj-pr-plan [--remote origin] [plain])",
    handler: async (args, ctx) => {
      await runtime.commandJjPrPlan(args, ctx);
    },
  });

  pi.registerCommand("jj-pr-publish", {
    description: "Publish/update stacked PRs (usage: /jj-pr-publish [--dry-run] [--draft] [--remote origin])",
    handler: async (args, ctx) => {
      await runtime.commandJjPrPublish(args, ctx);
    },
  });

  pi.registerCommand("jj-pr-sync", {
    description: "Sync stacked PR metadata/labels from GitHub (usage: /jj-pr-sync [--remote origin])",
    handler: async (args, ctx) => {
      await runtime.commandJjPrSync(args, ctx);
    },
  });

  pi.registerCommand("jj-stack-close", {
    description:
      "Close a completed stack (usage: /jj-stack-close [--remote origin] [--dry-run] [--keep-bookmarks] [--no-new-change] [--force])",
    handler: async (args, ctx) => {
      await runtime.commandJjStackClose(args, ctx);
    },
  });

  pi.registerCommand("jj-settings", {
    description: "Show or reload pi-jj settings (usage: /jj-settings [reload])",
    handler: async (args, ctx) => {
      await runtime.commandJjSettings(args, ctx);
    },
  });
}
