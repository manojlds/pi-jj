import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { rm } from "node:fs/promises";
import { join } from "node:path";

const STATUS_KEY = "pi-jj";
const CHECKPOINT_ENTRY_TYPE = "jj-checkpoint";
const MAX_CHECKPOINTS = 200;

type Checkpoint = {
  entryId: string;
  revision: string;
  timestamp: number;
};

type PendingCheckpoint = {
  revision: string;
  timestamp: number;
};

export default function (pi: ExtensionAPI) {
  const checkpoints = new Map<string, Checkpoint>();

  let isJjRepo = false;
  let sessionId: string | null = null;
  let pendingCheckpoint: PendingCheckpoint | null = null;
  let resumeCheckpointRevision: string | null = null;
  let lastRestoreRevision: string | null = null;
  let needsInitPrompt = false;
  let initPromptShown = false;
  let initInProgress = false;

  function setStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;

    if (isJjRepo) {
      ctx.ui.setStatus(STATUS_KEY, `pi-jj: ${checkpoints.size} checkpoints`);
    } else {
      ctx.ui.setStatus(STATUS_KEY, "pi-jj: not initialized (run /jj-init)");
    }
  }

  function clearState() {
    checkpoints.clear();
    pendingCheckpoint = null;
    resumeCheckpointRevision = null;
    lastRestoreRevision = null;
    needsInitPrompt = false;
    initPromptShown = false;
    initInProgress = false;
  }

  async function execJj(args: string[]) {
    const result = await pi.exec("jj", args);
    if (result.code !== 0) {
      throw new Error(result.stderr?.trim() || `jj ${args.join(" ")} failed`);
    }
    return result;
  }

  async function detectJjRepo(): Promise<boolean> {
    const result = await pi.exec("jj", ["root"]);
    return result.code === 0;
  }

  async function detectGitRepo(): Promise<boolean> {
    const result = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"]);
    return result.code === 0 && result.stdout.trim() === "true";
  }

  async function gitRepoRoot(): Promise<string | null> {
    const result = await pi.exec("git", ["rev-parse", "--show-toplevel"]);
    if (result.code !== 0) return null;
    return result.stdout.trim() || null;
  }

  async function initJjInGitRepo(ctx: ExtensionContext): Promise<boolean> {
    const root = await gitRepoRoot();
    if (!root) {
      if (ctx.hasUI) ctx.ui.notify("Could not determine git repo root", "error");
      return false;
    }

    const result = await pi.exec("jj", ["git", "init", "--colocate", root]);
    if (result.code !== 0) {
      if (ctx.hasUI) {
        const msg = result.stderr?.trim() || "jj git init failed";
        ctx.ui.notify(`Failed to initialize jj: ${msg}`, "error");
      }
      return false;
    }

    isJjRepo = await detectJjRepo();
    if (isJjRepo && ctx.hasUI) {
      ctx.ui.notify("Initialized jj repo (colocated with git)", "info");
    }
    return isJjRepo;
  }

  async function listJjRefs(): Promise<string[]> {
    const result = await pi.exec("git", ["for-each-ref", "--format=%(refname)", "refs/jj/"]);
    if (result.code !== 0) return [];

    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async function deinitJjRepo(ctx: ExtensionContext, removeRefs: boolean): Promise<boolean> {
    const root = await gitRepoRoot();
    if (!root) {
      if (ctx.hasUI) ctx.ui.notify("Could not determine git repo root", "error");
      return false;
    }

    const jjDir = join(root, ".jj");
    await rm(jjDir, { recursive: true, force: true });

    let removedRefs = 0;
    if (removeRefs) {
      const refs = await listJjRefs();
      for (const ref of refs) {
        await pi.exec("git", ["update-ref", "-d", ref]);
        removedRefs++;
      }
    }

    clearState();
    isJjRepo = false;
    setStatus(ctx);

    if (ctx.hasUI) {
      if (removeRefs) {
        ctx.ui.notify(`jj deinitialized (removed .jj and ${removedRefs} refs/jj/* refs)`, "info");
      } else {
        ctx.ui.notify("jj deinitialized (removed .jj, kept refs/jj/*)", "info");
      }
    }

    return true;
  }

  async function ensureJjRepo(): Promise<boolean> {
    if (isJjRepo) return true;
    isJjRepo = await detectJjRepo();
    return isJjRepo;
  }

  async function currentRevision(): Promise<string> {
    const result = await execJj(["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    const revision = result.stdout.trim().split("\n").pop()?.trim();
    if (!revision) throw new Error("Could not determine current jj revision");
    return revision;
  }

  async function restoreFilesFromRevision(revision: string) {
    await execJj(["restore", "--from", revision]);
  }

  function findLatestUserEntry(sessionManager: any): { id: string } | null {
    const leafId = sessionManager.getLeafId?.();
    if (!leafId) return null;

    const branch = sessionManager.getBranch?.(leafId) ?? [];
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry?.type === "message" && entry.message?.role === "user") {
        return { id: entry.id };
      }
    }

    return null;
  }

  function rebuildCheckpointsFromSession(ctx: ExtensionContext) {
    checkpoints.clear();

    const entries = ctx.sessionManager.getEntries();
    for (const entry of entries) {
      if (entry.type !== "custom") continue;
      if (entry.customType !== CHECKPOINT_ENTRY_TYPE) continue;

      const data = entry.data as Partial<Checkpoint> & { sessionId?: string };
      if (!data?.entryId || !data?.revision || !data?.timestamp) continue;
      if (sessionId && data.sessionId && data.sessionId !== sessionId) continue;

      const existing = checkpoints.get(data.entryId);
      if (!existing || existing.timestamp < data.timestamp) {
        checkpoints.set(data.entryId, {
          entryId: data.entryId,
          revision: data.revision,
          timestamp: data.timestamp,
        });
      }
    }

    pruneCheckpoints();
  }

  function pruneCheckpoints() {
    if (checkpoints.size <= MAX_CHECKPOINTS) return;

    const ordered = [...checkpoints.values()].sort((a, b) => a.timestamp - b.timestamp);
    const toRemove = ordered.slice(0, ordered.length - MAX_CHECKPOINTS);
    for (const checkpoint of toRemove) {
      checkpoints.delete(checkpoint.entryId);
    }
  }

  function resolveCheckpointRevision(targetId: string, ctx: ExtensionContext): string | null {
    const direct = checkpoints.get(targetId)?.revision;
    if (direct) return direct;

    const pathToTarget = ctx.sessionManager.getBranch?.(targetId) ?? [];
    for (let i = pathToTarget.length - 1; i >= 0; i--) {
      const checkpoint = checkpoints.get(pathToTarget[i]?.id);
      if (checkpoint) return checkpoint.revision;
    }

    return resumeCheckpointRevision;
  }

  async function initialize(ctx: ExtensionContext) {
    clearState();
    sessionId = ctx.sessionManager.getSessionId();

    isJjRepo = await detectJjRepo();
    if (!isJjRepo) {
      needsInitPrompt = await detectGitRepo();
      setStatus(ctx);
      return;
    }

    rebuildCheckpointsFromSession(ctx);

    try {
      resumeCheckpointRevision = await currentRevision();
    } catch {
      resumeCheckpointRevision = null;
    }

    setStatus(ctx);
  }

  async function restoreWithUndo(revision: string, ctx: ExtensionContext): Promise<boolean> {
    try {
      const beforeRestore = await currentRevision();
      await restoreFilesFromRevision(revision);
      lastRestoreRevision = beforeRestore;
      return true;
    } catch (error) {
      ctx.ui.notify(`Failed to restore files: ${String(error)}`, "error");
      return false;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    await initialize(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    await initialize(ctx);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    if (isJjRepo) return;
    if (!needsInitPrompt) return;
    if (initPromptShown || initInProgress) return;

    initPromptShown = true;
    const choice = await ctx.ui.select("Initialize this git repo for jj?", [
      "Yes (jj git init --colocate)",
      "Not now",
    ]);

    if (!choice?.startsWith("Yes")) return;

    initInProgress = true;
    try {
      const ok = await initJjInGitRepo(ctx);
      if (!ok) {
        setStatus(ctx);
        return;
      }

      rebuildCheckpointsFromSession(ctx);
      try {
        resumeCheckpointRevision = await currentRevision();
      } catch {
        resumeCheckpointRevision = null;
      }

      needsInitPrompt = false;
      setStatus(ctx);
    } finally {
      initInProgress = false;
    }
  });

  pi.on("turn_start", async (event, _ctx) => {
    if (!(await ensureJjRepo())) return;
    if (event.turnIndex !== 0) return;

    try {
      pendingCheckpoint = {
        revision: await currentRevision(),
        timestamp: event.timestamp,
      };
    } catch {
      pendingCheckpoint = null;
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!(await ensureJjRepo())) return;
    if (event.turnIndex !== 0) return;
    if (!pendingCheckpoint) return;

    const userEntry = findLatestUserEntry(ctx.sessionManager);
    if (!userEntry) {
      pendingCheckpoint = null;
      return;
    }

    const checkpoint: Checkpoint = {
      entryId: userEntry.id,
      revision: pendingCheckpoint.revision,
      timestamp: pendingCheckpoint.timestamp,
    };

    checkpoints.set(userEntry.id, checkpoint);
    pruneCheckpoints();

    pi.appendEntry(CHECKPOINT_ENTRY_TYPE, {
      ...checkpoint,
      sessionId,
    });

    pendingCheckpoint = null;
    setStatus(ctx);

    if (ctx.hasUI) {
      ctx.ui.notify(`jj checkpoint saved (${checkpoints.size})`, "info");
    }
  });

  pi.on("session_before_fork", async (event, ctx) => {
    if (!ctx.hasUI) return;
    if (!(await ensureJjRepo())) return;

    const revision = resolveCheckpointRevision(event.entryId, ctx);
    const options = ["Conversation only (keep current files)"];

    if (revision) {
      options.push("Restore files + conversation");
      options.push("Restore files only (keep conversation)");
    }

    if (lastRestoreRevision) {
      options.push("Undo last file rewind");
    }

    const choice = await ctx.ui.select("jj rewind options", options);
    if (!choice) return { cancel: true };

    if (choice.startsWith("Conversation only")) {
      return;
    }

    if (choice === "Undo last file rewind") {
      const undoRevision = lastRestoreRevision;
      if (!undoRevision) return { cancel: true };

      const success = await restoreWithUndo(undoRevision, ctx);
      if (success) {
        ctx.ui.notify("Rewind undone", "info");
      }
      return { cancel: true };
    }

    if (!revision) {
      ctx.ui.notify("No jj checkpoint found for that point", "warning");
      return { cancel: true };
    }

    const success = await restoreWithUndo(revision, ctx);
    if (!success) {
      return { cancel: true };
    }

    ctx.ui.notify("Files restored from jj checkpoint", "info");

    if (choice === "Restore files only (keep conversation)") {
      return { skipConversationRestore: true };
    }
  });

  pi.on("session_before_tree", async (event, ctx) => {
    if (!ctx.hasUI) return;
    if (!(await ensureJjRepo())) return;

    const targetId = event.preparation.targetId;
    const revision = resolveCheckpointRevision(targetId, ctx);

    const options = ["Keep current files"];
    if (revision) options.push("Restore files to selected point");
    if (lastRestoreRevision) options.push("Undo last file rewind");
    options.push("Cancel navigation");

    const choice = await ctx.ui.select("jj rewind options", options);
    if (!choice || choice === "Cancel navigation") {
      return { cancel: true };
    }

    if (choice === "Keep current files") {
      return;
    }

    if (choice === "Undo last file rewind") {
      const undoRevision = lastRestoreRevision;
      if (!undoRevision) return { cancel: true };

      const success = await restoreWithUndo(undoRevision, ctx);
      if (success) {
        ctx.ui.notify("Rewind undone", "info");
      }
      return { cancel: true };
    }

    if (!revision) {
      ctx.ui.notify("No jj checkpoint found for that point", "warning");
      return { cancel: true };
    }

    const success = await restoreWithUndo(revision, ctx);
    if (!success) {
      return { cancel: true };
    }

    ctx.ui.notify("Files restored from jj checkpoint", "info");
  });

  pi.registerCommand("jj-init", {
    description: "Initialize current git repo as a colocated jj repo",
    handler: async (_args, ctx) => {
      if (await ensureJjRepo()) {
        ctx.ui.notify("This repo is already initialized for jj", "info");
        setStatus(ctx);
        return;
      }

      const isGit = await detectGitRepo();
      if (!isGit) {
        ctx.ui.notify("Current directory is not a git repo", "warning");
        return;
      }

      const ok = await initJjInGitRepo(ctx);
      if (!ok) return;

      rebuildCheckpointsFromSession(ctx);
      try {
        resumeCheckpointRevision = await currentRevision();
      } catch {
        resumeCheckpointRevision = null;
      }

      setStatus(ctx);
    },
  });

  pi.registerCommand("jj-deinit", {
    description: "Remove jj metadata from current repo (usage: /jj-deinit [full])",
    handler: async (args, ctx) => {
      const isGit = await detectGitRepo();
      if (!isGit) {
        ctx.ui.notify("Current directory is not a git repo", "warning");
        return;
      }

      const hasJj = await ensureJjRepo();
      if (!hasJj) {
        ctx.ui.notify("This repo is not initialized for jj", "info");
        setStatus(ctx);
        return;
      }

      let removeRefs = (args ?? "").trim().toLowerCase() === "full";

      if (!removeRefs && ctx.hasUI) {
        const choice = await ctx.ui.select("Deinitialize jj for this repo?", [
          "Remove .jj only (keep refs/jj/*)",
          "Full cleanup (.jj + refs/jj/*)",
          "Cancel",
        ]);

        if (!choice || choice === "Cancel") {
          ctx.ui.notify("jj deinit cancelled", "info");
          return;
        }

        removeRefs = choice.startsWith("Full cleanup");
      }

      if (ctx.hasUI) {
        const confirmed = await ctx.ui.confirm(
          "Confirm jj deinit",
          removeRefs
            ? "This will remove .jj and delete refs/jj/* in this git repo. Continue?"
            : "This will remove .jj in this git repo. Continue?"
        );

        if (!confirmed) {
          ctx.ui.notify("jj deinit cancelled", "info");
          return;
        }
      }

      await deinitJjRepo(ctx, removeRefs);
    },
  });

  pi.registerCommand("jj-checkpoints", {
    description: "Show in-memory jj checkpoint count and latest target",
    handler: async (_args, ctx) => {
      const ordered = [...checkpoints.values()].sort((a, b) => b.timestamp - a.timestamp);
      const latest = ordered[0];
      if (!latest) {
        ctx.ui.notify("No jj checkpoints yet", "info");
        return;
      }

      ctx.ui.notify(
        `jj checkpoints: ${ordered.length} (latest ${latest.entryId.slice(0, 8)} -> ${latest.revision.slice(0, 12)})`,
        "info"
      );
    },
  });
}
