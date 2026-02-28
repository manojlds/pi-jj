import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { checkpointLine, formatAge } from "./format";
import { createSettingsStore } from "./settings";
import { CHECKPOINT_ENTRY_TYPE, STATUS_KEY, type Checkpoint, type PendingCheckpoint } from "./types";

type TurnEventLike = { turnIndex: number; timestamp: number };
type TurnEndEventLike = { turnIndex: number };
type ForkEventLike = { entryId: string };
type TreeEventLike = { preparation: { targetId: string } };

export class PiJjRuntime {
  private checkpoints = new Map<string, Checkpoint>();

  private isJjRepo = false;
  private isGitRepo = false;
  private sessionId: string | null = null;
  private pendingCheckpoint: PendingCheckpoint | null = null;
  private resumeCheckpointRevision: string | null = null;
  private lastRestoreRevision: string | null = null;
  private needsInitPrompt = false;
  private initPromptShown = false;
  private initInProgress = false;

  private readonly settingsStore = createSettingsStore();

  constructor(private readonly pi: ExtensionAPI) {}

  private loadSettings() {
    return this.settingsStore.getSettings();
  }

  private setStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;

    const settings = this.loadSettings();

    if (this.isJjRepo) {
      const status = settings.silentCheckpoints
        ? "pi-jj: ready"
        : `pi-jj: ${this.checkpoints.size} checkpoints`;
      ctx.ui.setStatus(STATUS_KEY, status);
      return;
    }

    if (!this.isGitRepo) {
      ctx.ui.setStatus(STATUS_KEY, "pi-jj: not a git repo");
      return;
    }

    if (!settings.promptForInit) {
      ctx.ui.setStatus(STATUS_KEY, "pi-jj: git repo (init prompt disabled, run /jj-init)");
      return;
    }

    ctx.ui.setStatus(STATUS_KEY, "pi-jj: not initialized (run /jj-init)");
  }

  private clearState() {
    this.checkpoints.clear();
    this.isGitRepo = false;
    this.pendingCheckpoint = null;
    this.resumeCheckpointRevision = null;
    this.lastRestoreRevision = null;
    this.needsInitPrompt = false;
    this.initPromptShown = false;
    this.initInProgress = false;
    this.settingsStore.clearCache();
  }

  private async execJj(args: string[]) {
    const result = await this.pi.exec("jj", args);
    if (result.code !== 0) {
      throw new Error(result.stderr?.trim() || `jj ${args.join(" ")} failed`);
    }
    return result;
  }

  private async detectJjRepo(): Promise<boolean> {
    const result = await this.pi.exec("jj", ["root"]);
    return result.code === 0;
  }

  private async detectGitRepo(): Promise<boolean> {
    const result = await this.pi.exec("git", ["rev-parse", "--is-inside-work-tree"]);
    return result.code === 0 && result.stdout.trim() === "true";
  }

  private async gitRepoRoot(): Promise<string | null> {
    const result = await this.pi.exec("git", ["rev-parse", "--show-toplevel"]);
    if (result.code !== 0) return null;
    return result.stdout.trim() || null;
  }

  private async initJjInGitRepo(ctx: ExtensionContext): Promise<boolean> {
    const root = await this.gitRepoRoot();
    if (!root) {
      if (ctx.hasUI) ctx.ui.notify("Could not determine git repo root", "error");
      return false;
    }

    const result = await this.pi.exec("jj", ["git", "init", "--colocate", root]);
    if (result.code !== 0) {
      if (ctx.hasUI) {
        const msg = result.stderr?.trim() || "jj git init failed";
        ctx.ui.notify(`Failed to initialize jj: ${msg}`, "error");
      }
      return false;
    }

    this.isGitRepo = true;
    this.isJjRepo = await this.detectJjRepo();
    if (this.isJjRepo && ctx.hasUI) {
      ctx.ui.notify("Initialized jj repo (colocated with git)", "info");
    }
    return this.isJjRepo;
  }

  private async listJjRefs(): Promise<string[]> {
    const result = await this.pi.exec("git", ["for-each-ref", "--format=%(refname)", "refs/jj/"]);
    if (result.code !== 0) return [];

    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private async deinitJjRepo(ctx: ExtensionContext, removeRefs: boolean): Promise<boolean> {
    const root = await this.gitRepoRoot();
    if (!root) {
      if (ctx.hasUI) ctx.ui.notify("Could not determine git repo root", "error");
      return false;
    }

    const jjDir = join(root, ".jj");
    await rm(jjDir, { recursive: true, force: true });

    let removedRefs = 0;
    if (removeRefs) {
      const refs = await this.listJjRefs();
      for (const ref of refs) {
        await this.pi.exec("git", ["update-ref", "-d", ref]);
        removedRefs++;
      }
    }

    this.clearState();
    this.isGitRepo = true;
    this.isJjRepo = false;
    this.setStatus(ctx);

    if (ctx.hasUI) {
      if (removeRefs) {
        ctx.ui.notify(`jj deinitialized (removed .jj and ${removedRefs} refs/jj/* refs)`, "info");
      } else {
        ctx.ui.notify("jj deinitialized (removed .jj, kept refs/jj/*)", "info");
      }
    }

    return true;
  }

  private async ensureJjRepo(): Promise<boolean> {
    if (this.isJjRepo) {
      this.isGitRepo = true;
      return true;
    }
    this.isJjRepo = await this.detectJjRepo();
    if (this.isJjRepo) this.isGitRepo = true;
    return this.isJjRepo;
  }

  private async currentRevision(): Promise<string> {
    const result = await this.execJj(["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    const revision = result.stdout.trim().split("\n").pop()?.trim();
    if (!revision) throw new Error("Could not determine current jj revision");
    return revision;
  }

  private async restoreFilesFromRevision(revision: string) {
    await this.execJj(["restore", "--from", revision]);
  }

  private findLatestUserEntry(sessionManager: any): { id: string } | null {
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

  private rebuildCheckpointsFromSession(ctx: ExtensionContext) {
    this.checkpoints.clear();

    const entries = ctx.sessionManager.getEntries();
    for (const entry of entries) {
      if (entry.type !== "custom") continue;
      if (entry.customType !== CHECKPOINT_ENTRY_TYPE) continue;

      const data = entry.data as Partial<Checkpoint> & { sessionId?: string };
      if (!data?.entryId || !data?.revision || !data?.timestamp) continue;
      if (this.sessionId && data.sessionId && data.sessionId !== this.sessionId) continue;

      const existing = this.checkpoints.get(data.entryId);
      if (!existing || existing.timestamp < data.timestamp) {
        this.checkpoints.set(data.entryId, {
          entryId: data.entryId,
          revision: data.revision,
          timestamp: data.timestamp,
        });
      }
    }

    this.pruneCheckpoints();
  }

  private pruneCheckpoints() {
    const maxCheckpoints = this.loadSettings().maxCheckpoints;
    if (this.checkpoints.size <= maxCheckpoints) return;

    const ordered = [...this.checkpoints.values()].sort((a, b) => a.timestamp - b.timestamp);
    const toRemove = ordered.slice(0, ordered.length - maxCheckpoints);
    for (const checkpoint of toRemove) {
      this.checkpoints.delete(checkpoint.entryId);
    }
  }

  private resolveCheckpointRevision(targetId: string, ctx: ExtensionContext): string | null {
    const direct = this.checkpoints.get(targetId)?.revision;
    if (direct) return direct;

    const pathToTarget = ctx.sessionManager.getBranch?.(targetId) ?? [];
    for (let i = pathToTarget.length - 1; i >= 0; i--) {
      const checkpoint = this.checkpoints.get(pathToTarget[i]?.id);
      if (checkpoint) return checkpoint.revision;
    }

    return this.resumeCheckpointRevision;
  }

  private getOrderedCheckpoints(): Checkpoint[] {
    return [...this.checkpoints.values()].sort((a, b) => b.timestamp - a.timestamp);
  }

  private async showCheckpointUi(ctx: ExtensionContext): Promise<void> {
    const ordered = this.getOrderedCheckpoints();
    if (ordered.length === 0) {
      ctx.ui.notify("No jj checkpoints yet", "info");
      return;
    }

    const settings = this.loadSettings();
    const visible = ordered.slice(0, settings.checkpointListLimit);
    const labels = visible.map(checkpointLine);

    const selected = await ctx.ui.select(`jj checkpoints (${ordered.length})`, labels);
    if (!selected) return;

    const index = labels.indexOf(selected);
    if (index < 0) return;
    const checkpoint = visible[index];

    const action = await ctx.ui.select("Checkpoint action", [
      "Restore files now",
      "Copy revision to editor",
      "Show details",
      "Cancel",
    ]);

    if (!action || action === "Cancel") return;

    if (action === "Restore files now") {
      if (!(await this.ensureJjRepo())) {
        ctx.ui.notify("Not a jj repo", "warning");
        return;
      }

      const success = await this.restoreWithUndo(checkpoint.revision, ctx);
      if (success) {
        ctx.ui.notify(`Files restored from ${checkpoint.revision.slice(0, 12)}`, "info");
      }
      return;
    }

    if (action === "Copy revision to editor") {
      ctx.ui.setEditorText(checkpoint.revision);
      ctx.ui.notify("Revision copied to editor", "info");
      return;
    }

    const details = [
      `entry: ${checkpoint.entryId}`,
      `revision: ${checkpoint.revision}`,
      `timestamp: ${new Date(checkpoint.timestamp).toISOString()}`,
      `age: ${formatAge(checkpoint.timestamp)}`,
    ].join("\n");

    ctx.ui.notify(details, "info");
  }

  private async restoreWithUndo(revision: string, ctx: ExtensionContext): Promise<boolean> {
    try {
      const beforeRestore = await this.currentRevision();
      await this.restoreFilesFromRevision(revision);
      this.lastRestoreRevision = beforeRestore;
      return true;
    } catch (error) {
      ctx.ui.notify(`Failed to restore files: ${String(error)}`, "error");
      return false;
    }
  }

  async handleSessionStart(ctx: ExtensionContext) {
    await this.initialize(ctx);
  }

  async handleSessionSwitch(ctx: ExtensionContext) {
    await this.initialize(ctx);
  }

  async handleBeforeAgentStart(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (this.isJjRepo) return;
    if (!this.needsInitPrompt) return;
    if (this.initPromptShown || this.initInProgress) return;

    this.initPromptShown = true;
    const choice = await ctx.ui.select("Initialize this git repo for jj?", [
      "Yes (jj git init --colocate)",
      "Not now",
    ]);

    if (!choice?.startsWith("Yes")) return;

    this.initInProgress = true;
    try {
      const ok = await this.initJjInGitRepo(ctx);
      if (!ok) {
        this.setStatus(ctx);
        return;
      }

      this.rebuildCheckpointsFromSession(ctx);
      try {
        this.resumeCheckpointRevision = await this.currentRevision();
      } catch {
        this.resumeCheckpointRevision = null;
      }

      this.needsInitPrompt = false;
      this.setStatus(ctx);
    } finally {
      this.initInProgress = false;
    }
  }

  async handleTurnStart(event: TurnEventLike) {
    if (!(await this.ensureJjRepo())) return;
    if (event.turnIndex !== 0) return;

    try {
      this.pendingCheckpoint = {
        revision: await this.currentRevision(),
        timestamp: event.timestamp,
      };
    } catch {
      this.pendingCheckpoint = null;
    }
  }

  async handleTurnEnd(event: TurnEndEventLike, ctx: ExtensionContext) {
    if (!(await this.ensureJjRepo())) return;
    if (event.turnIndex !== 0) return;
    if (!this.pendingCheckpoint) return;

    const userEntry = this.findLatestUserEntry(ctx.sessionManager);
    if (!userEntry) {
      this.pendingCheckpoint = null;
      return;
    }

    const checkpoint: Checkpoint = {
      entryId: userEntry.id,
      revision: this.pendingCheckpoint.revision,
      timestamp: this.pendingCheckpoint.timestamp,
    };

    this.checkpoints.set(userEntry.id, checkpoint);
    this.pruneCheckpoints();

    this.pi.appendEntry(CHECKPOINT_ENTRY_TYPE, {
      ...checkpoint,
      sessionId: this.sessionId,
    });

    this.pendingCheckpoint = null;
    this.setStatus(ctx);

    if (ctx.hasUI && !this.loadSettings().silentCheckpoints) {
      ctx.ui.notify(`jj checkpoint saved (${this.checkpoints.size})`, "info");
    }
  }

  async handleSessionBeforeFork(event: ForkEventLike, ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (!(await this.ensureJjRepo())) return;

    const revision = this.resolveCheckpointRevision(event.entryId, ctx);
    const options = ["Conversation only (keep current files)"];

    if (revision) {
      options.push("Restore files + conversation");
      options.push("Restore files only (keep conversation)");
    }

    if (this.lastRestoreRevision) {
      options.push("Undo last file rewind");
    }

    const choice = await ctx.ui.select("jj rewind options", options);
    if (!choice) return { cancel: true };

    if (choice.startsWith("Conversation only")) {
      return;
    }

    if (choice === "Undo last file rewind") {
      const undoRevision = this.lastRestoreRevision;
      if (!undoRevision) return { cancel: true };

      const success = await this.restoreWithUndo(undoRevision, ctx);
      if (success) {
        ctx.ui.notify("Rewind undone", "info");
      }
      return { cancel: true };
    }

    if (!revision) {
      ctx.ui.notify("No jj checkpoint found for that point", "warning");
      return { cancel: true };
    }

    const success = await this.restoreWithUndo(revision, ctx);
    if (!success) {
      return { cancel: true };
    }

    ctx.ui.notify("Files restored from jj checkpoint", "info");

    if (choice === "Restore files only (keep conversation)") {
      return { skipConversationRestore: true };
    }
  }

  async handleSessionBeforeTree(event: TreeEventLike, ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (!(await this.ensureJjRepo())) return;

    const targetId = event.preparation.targetId;
    const revision = this.resolveCheckpointRevision(targetId, ctx);

    const options = ["Keep current files"];
    if (revision) options.push("Restore files to selected point");
    if (this.lastRestoreRevision) options.push("Undo last file rewind");
    options.push("Cancel navigation");

    const choice = await ctx.ui.select("jj rewind options", options);
    if (!choice || choice === "Cancel navigation") {
      return { cancel: true };
    }

    if (choice === "Keep current files") {
      return;
    }

    if (choice === "Undo last file rewind") {
      const undoRevision = this.lastRestoreRevision;
      if (!undoRevision) return { cancel: true };

      const success = await this.restoreWithUndo(undoRevision, ctx);
      if (success) {
        ctx.ui.notify("Rewind undone", "info");
      }
      return { cancel: true };
    }

    if (!revision) {
      ctx.ui.notify("No jj checkpoint found for that point", "warning");
      return { cancel: true };
    }

    const success = await this.restoreWithUndo(revision, ctx);
    if (!success) {
      return { cancel: true };
    }

    ctx.ui.notify("Files restored from jj checkpoint", "info");
  }

  async commandJjInit(_args: string, ctx: ExtensionContext) {
    if (await this.ensureJjRepo()) {
      ctx.ui.notify("This repo is already initialized for jj", "info");
      this.setStatus(ctx);
      return;
    }

    const isGit = await this.detectGitRepo();
    this.isGitRepo = isGit;
    if (!isGit) {
      ctx.ui.notify("Current directory is not a git repo", "warning");
      return;
    }

    const ok = await this.initJjInGitRepo(ctx);
    if (!ok) return;

    this.needsInitPrompt = false;
    this.rebuildCheckpointsFromSession(ctx);
    try {
      this.resumeCheckpointRevision = await this.currentRevision();
    } catch {
      this.resumeCheckpointRevision = null;
    }

    this.setStatus(ctx);
  }

  async commandJjDeinit(args: string, ctx: ExtensionContext) {
    const isGit = await this.detectGitRepo();
    this.isGitRepo = isGit;
    if (!isGit) {
      ctx.ui.notify("Current directory is not a git repo", "warning");
      return;
    }

    const hasJj = await this.ensureJjRepo();
    if (!hasJj) {
      ctx.ui.notify("This repo is not initialized for jj", "info");
      this.setStatus(ctx);
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
          : "This will remove .jj in this git repo. Continue?",
      );

      if (!confirmed) {
        ctx.ui.notify("jj deinit cancelled", "info");
        return;
      }
    }

    await this.deinitJjRepo(ctx, removeRefs);
  }

  async commandJjCheckpoints(args: string, ctx: ExtensionContext) {
    const mode = (args ?? "").trim().toLowerCase();
    const ordered = this.getOrderedCheckpoints();
    if (ordered.length === 0) {
      ctx.ui.notify("No jj checkpoints yet", "info");
      return;
    }

    const settings = this.loadSettings();
    const visible = ordered.slice(0, settings.checkpointListLimit);

    if (mode === "plain" || !ctx.hasUI) {
      const lines = visible.map((checkpoint) => checkpointLine(checkpoint));
      ctx.ui.notify(`jj checkpoints (${ordered.length})\n${lines.join("\n")}`, "info");
      return;
    }

    await this.showCheckpointUi(ctx);
  }

  async commandJjSettings(args: string, ctx: ExtensionContext) {
    const mode = (args ?? "").trim().toLowerCase();
    if (mode === "reload") {
      this.settingsStore.clearCache();
      const reloaded = this.loadSettings();

      if (!this.isJjRepo) {
        this.needsInitPrompt = reloaded.promptForInit && (await this.detectGitRepo());
      }

      this.setStatus(ctx);
      ctx.ui.notify(
        `Reloaded piJj settings: silent=${reloaded.silentCheckpoints}, max=${reloaded.maxCheckpoints}, list=${reloaded.checkpointListLimit}, prompt=${reloaded.promptForInit}`,
        "info",
      );
      return;
    }

    const settings = this.loadSettings();
    ctx.ui.notify(
      `piJj settings\n` +
        `silentCheckpoints: ${settings.silentCheckpoints}\n` +
        `maxCheckpoints: ${settings.maxCheckpoints}\n` +
        `checkpointListLimit: ${settings.checkpointListLimit}\n` +
        `promptForInit: ${settings.promptForInit}\n` +
        `file: ${this.settingsStore.settingsFile}`,
      "info",
    );
  }

  private async initialize(ctx: ExtensionContext) {
    this.clearState();
    this.sessionId = ctx.sessionManager.getSessionId();

    this.isJjRepo = await this.detectJjRepo();
    if (!this.isJjRepo) {
      this.isGitRepo = await this.detectGitRepo();
      const settings = this.loadSettings();
      this.needsInitPrompt = settings.promptForInit && this.isGitRepo;
      this.setStatus(ctx);
      return;
    }

    this.isGitRepo = true;

    this.rebuildCheckpointsFromSession(ctx);

    try {
      this.resumeCheckpointRevision = await this.currentRevision();
    } catch {
      this.resumeCheckpointRevision = null;
    }

    this.setStatus(ctx);
  }
}
