import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { checkpointLine, formatAge } from "./format";
import { createSettingsStore } from "./settings";
import { CHECKPOINT_ENTRY_TYPE, PR_STATE_ENTRY_TYPE, STATUS_KEY, type Checkpoint, type PendingCheckpoint } from "./types";

type TurnEventLike = { turnIndex: number; timestamp: number };
type TurnEndEventLike = { turnIndex: number };
type ForkEventLike = { entryId: string };
type TreeEventLike = { preparation: { targetId: string } };

type StackNode = {
  changeId: string;
  changeIdShort: string;
  revision: string;
  revisionShort: string;
  description: string;
  immutable: boolean;
};

type PrRecord = {
  changeId: string;
  changeIdShort: string;
  branch: string;
  base: string;
  number?: number;
  url?: string;
  state?: string;
  title: string;
};

type PrPublishOptions = {
  remote: string;
  dryRun: boolean;
  draft: boolean;
};

type StackCloseOptions = {
  remote: string;
  dryRun: boolean;
  keepBookmarks: boolean;
  noNewChange: boolean;
  force: boolean;
};

type GhPr = {
  number: number;
  url?: string;
  state?: string;
  title?: string;
  baseRefName?: string;
  headRefName?: string;
  mergedAt?: string | null;
};

type PrStateSnapshot = {
  remote?: string;
  action?: "publish" | "sync" | string;
  recordedAt: number;
  records: PrRecord[];
};

type StackStatusNodeView = {
  node: StackNode;
  prLabel: string;
  prRecord?: PrRecord;
};

type StackStatusSnapshot = {
  revision: string;
  change: { id: string; short: string };
  operation: { id: string; short: string };
  checkpoints: Checkpoint[];
  latestCheckpoint?: Checkpoint;
  prSnapshot: PrStateSnapshot | null;
  stackViews: StackStatusNodeView[];
  summary: string;
};

type PrPlanEntryView = {
  node: StackNode;
  branch: string;
  baseBranch: string;
  dryRunPushCommand: string;
  prIntent: string;
};

type PrPlanSnapshot = {
  remote: string;
  defaultBase: string;
  entries: PrPlanEntryView[];
  summary: string;
};

export class PiJjRuntime {
  private checkpoints = new Map<string, Checkpoint>();

  private isJjRepo = false;
  private isGitRepo = false;
  private sessionId: string | null = null;
  private pendingCheckpoint: PendingCheckpoint | null = null;
  private resumeCheckpointOperationId: string | null = null;
  private lastRestoreOperationId: string | null = null;
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
    this.resumeCheckpointOperationId = null;
    this.lastRestoreOperationId = null;
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

  private async getJjConfig(key: string): Promise<string | null> {
    const result = await this.pi.exec("jj", ["config", "list", key]);
    if (result.code !== 0) return null;
    const line = result.stdout.trim();
    if (!line) return null;
    const eqIdx = line.indexOf("=");
    if (eqIdx < 0) return null;
    return line.slice(eqIdx + 1).trim().replace(/^"|"$/g, "");
  }

  private async getGitConfig(key: string): Promise<string | null> {
    const result = await this.pi.exec("git", ["config", "--get", key]);
    if (result.code !== 0) return null;
    return result.stdout.trim() || null;
  }

  private async ensureJjUserConfig(ctx: ExtensionContext): Promise<void> {
    const jjName = await this.getJjConfig("user.name");
    const jjEmail = await this.getJjConfig("user.email");
    if (jjName && jjEmail) return;

    const gitName = await this.getGitConfig("user.name");
    const gitEmail = await this.getGitConfig("user.email");

    const missingFields: string[] = [];
    if (!jjName) missingFields.push("user.name");
    if (!jjEmail) missingFields.push("user.email");

    if (!ctx.hasUI) return;

    const defaultName = gitName || "";
    const defaultEmail = gitEmail || "";
    const defaults = [
      !jjName && defaultName ? `name: ${defaultName}` : null,
      !jjEmail && defaultEmail ? `email: ${defaultEmail}` : null,
    ]
      .filter(Boolean)
      .join(", ");

    const prompt = `jj ${missingFields.join(" and ")} not set.${defaults ? ` Use git defaults (${defaults})?` : ""}`;
    const choice = await ctx.ui.select(prompt, [
      ...(defaults ? [`Yes (use git: ${defaults})`] : []),
      "Skip (jj will warn on commit)",
    ]);

    if (!choice?.startsWith("Yes")) return;

    if (!jjName && defaultName) {
      await this.pi.exec("jj", ["config", "set", "--repo", "user.name", defaultName]);
    }
    if (!jjEmail && defaultEmail) {
      await this.pi.exec("jj", ["config", "set", "--repo", "user.email", defaultEmail]);
    }

    ctx.ui.notify("jj user config set from git defaults", "info");
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
    if (this.isJjRepo) {
      await this.ensureJjUserConfig(ctx);
      await this.promptRestoreMode(ctx);
      if (ctx.hasUI) {
        ctx.ui.notify("Initialized jj repo (colocated with git)", "info");
      }
    }
    return this.isJjRepo;
  }

  private async promptRestoreMode(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) return;

    const settings = this.loadSettings();
    const choice = await ctx.ui.select(
      "Checkpoint restore mode?",
      [
        "File restore (safer — restores file contents only via jj restore)",
        "Operation restore (full — restores entire repo state via jj op restore)",
      ],
    );

    if (!choice) return;

    const chosen = choice.startsWith("Operation") ? "operation" : "file";
    if (chosen === settings.restoreMode) return;

    this.settingsStore.updateSetting("restoreMode", chosen);
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

  private async currentRevision(options?: { ignoreWorkingCopy?: boolean }): Promise<string> {
    const args = [
      ...(options?.ignoreWorkingCopy ? ["--ignore-working-copy"] : []),
      "log",
      "-r",
      "@",
      "--no-graph",
      "-T",
      "commit_id",
    ];
    const result = await this.execJj(args);
    const revision = result.stdout.trim().split("\n").pop()?.trim();
    if (!revision) throw new Error("Could not determine current jj revision");
    return revision;
  }

  private async currentChangeInfo(options?: { ignoreWorkingCopy?: boolean }): Promise<{ id: string; short: string }> {
    const args = [
      ...(options?.ignoreWorkingCopy ? ["--ignore-working-copy"] : []),
      "log",
      "-r",
      "@",
      "--no-graph",
      "-T",
      "change_id ++ \"\\n\" ++ change_id.short()",
    ];
    const result = await this.execJj(args);
    const lines = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const id = lines[0];
    const short = lines[1] ?? (id ? id.slice(0, 12) : undefined);
    if (!id || !short) throw new Error("Could not determine current jj change id");
    return { id, short };
  }

  private async currentOperationInfo(options?: { ignoreWorkingCopy?: boolean }): Promise<{ id: string; short: string }> {
    const args = [
      ...(options?.ignoreWorkingCopy ? ["--ignore-working-copy"] : []),
      "op",
      "log",
      "-n",
      "1",
      "--no-graph",
      "-T",
      "id ++ \"\\n\" ++ id.short()",
    ];
    const result = await this.execJj(args);
    const lines = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const id = lines[0];
    const short = lines[1] ?? (id ? id.slice(0, 12) : undefined);
    if (!id || !short) throw new Error("Could not determine current jj operation id");
    return { id, short };
  }

  private async restoreToOperation(operationId: string) {
    await this.execJj(["op", "restore", operationId]);
    await this.pi.exec("jj", ["git", "fetch", "--all-remotes"]);
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
          changeId: data.changeId,
          changeIdShort: data.changeIdShort,
          operationId: data.operationId,
          operationIdShort: data.operationIdShort,
          postOperationId: data.postOperationId,
          postOperationIdShort: data.postOperationIdShort,
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
      if (checkpoint?.revision) return checkpoint.revision;
    }

    return null;
  }

  private resolveCheckpointOperationId(targetId: string, ctx: ExtensionContext): string | null {
    const directCheckpoint = this.checkpoints.get(targetId);
    if (directCheckpoint?.operationId) return directCheckpoint.operationId;

    const pathToTarget = ctx.sessionManager.getBranch?.(targetId) ?? [];
    for (let i = pathToTarget.length - 1; i >= 0; i--) {
      const checkpoint = this.checkpoints.get(pathToTarget[i]?.id);
      if (!checkpoint) continue;
      return checkpoint.postOperationId ?? checkpoint.operationId ?? null;
    }

    return this.resumeCheckpointOperationId;
  }

  private resolveRestoreTarget(targetId: string, ctx: ExtensionContext): { mode: "file"; revision: string } | { mode: "operation"; operationId: string } | null {
    const settings = this.loadSettings();
    if (settings.restoreMode === "operation") {
      const opId = this.resolveCheckpointOperationId(targetId, ctx);
      if (opId) return { mode: "operation", operationId: opId };
      return null;
    }
    const rev = this.resolveCheckpointRevision(targetId, ctx);
    if (rev) return { mode: "file", revision: rev };
    return null;
  }

  private getOrderedCheckpoints(): Checkpoint[] {
    return [...this.checkpoints.values()].sort((a, b) => b.timestamp - a.timestamp);
  }

  private async getStackNodes(): Promise<StackNode[]> {
    const result = await this.execJj([
      "--ignore-working-copy",
      "log",
      "--reversed",
      "-r",
      "(ancestors(@) | descendants(@)) & mutable()",
      "--no-graph",
      "-T",
      "change_id ++ \"\\t\" ++ change_id.short() ++ \"\\t\" ++ commit_id ++ \"\\t\" ++ commit_id.short() ++ \"\\t\" ++ if(immutable, \"1\", \"0\") ++ \"\\t\" ++ if(empty, \"1\", \"0\") ++ \"\\t\" ++ description.first_line() ++ \"\\n\"",
    ]);

    const nodes: StackNode[] = [];
    for (const line of result.stdout.split("\n")) {
      const trimmed = line.trimEnd();
      if (!trimmed) continue;
      const parts = trimmed.split("\t");
      if (parts.length < 6) continue;

      const [changeId, changeIdShort, revision, revisionShort, immutableFlag, emptyFlag, ...descParts] = parts;
      const description = descParts.join("\t") || "";
      if (!changeId || !changeIdShort || !revision || !revisionShort || !immutableFlag || !emptyFlag) continue;

      const isEmpty = emptyFlag === "1";
      const hasDescription = description.trim().length > 0;

      if (isEmpty && !hasDescription) continue;

      nodes.push({
        changeId,
        changeIdShort,
        revision,
        revisionShort,
        immutable: immutableFlag === "1",
        description: description || "(no description)",
      });
    }

    return nodes;
  }

  private async defaultGitRemote(): Promise<string | null> {
    const result = await this.pi.exec("git", ["remote"]);
    if (result.code !== 0) return null;

    const remotes = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (remotes.includes("origin")) return "origin";
    return remotes[0] ?? null;
  }

  private async execGh(args: string[]) {
    const result = await this.pi.exec("gh", args);
    if (result.code !== 0) {
      throw new Error(result.stderr?.trim() || `gh ${args.join(" ")} failed`);
    }
    return result;
  }

  private parsePrPublishOptions(args: string): PrPublishOptions {
    const tokens = (args ?? "")
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);

    let dryRun = false;
    let draft = false;
    let remote = "";

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token === "--dry-run" || token === "-n") {
        dryRun = true;
        continue;
      }
      if (token === "--draft") {
        draft = true;
        continue;
      }
      if (token.startsWith("--remote=")) {
        remote = token.slice("--remote=".length);
        continue;
      }
      if (token === "--remote" && tokens[i + 1]) {
        remote = tokens[i + 1]!;
        i++;
        continue;
      }
      if (!token.startsWith("-") && !remote) {
        remote = token;
      }
    }

    return {
      remote,
      dryRun,
      draft,
    };
  }

  private parseStackCloseOptions(args: string): StackCloseOptions {
    const tokens = (args ?? "")
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);

    let remote = "";
    let dryRun = false;
    let keepBookmarks = false;
    let noNewChange = false;
    let force = false;

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token === "--dry-run" || token === "-n") {
        dryRun = true;
        continue;
      }
      if (token === "--keep-bookmarks") {
        keepBookmarks = true;
        continue;
      }
      if (token === "--no-new-change") {
        noNewChange = true;
        continue;
      }
      if (token === "--force") {
        force = true;
        continue;
      }
      if (token.startsWith("--remote=")) {
        remote = token.slice("--remote=".length);
        continue;
      }
      if (token === "--remote" && tokens[i + 1]) {
        remote = tokens[i + 1]!;
        i++;
        continue;
      }
      if (!token.startsWith("-") && !remote) {
        remote = token;
      }
    }

    return {
      remote,
      dryRun,
      keepBookmarks,
      noNewChange,
      force,
    };
  }

  private hasDryRunFlag(args: string): boolean {
    return (args ?? "")
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .some((token) => token === "--dry-run" || token === "-n");
  }

  private async maybePromptPublishMode(options: PrPublishOptions, args: string, ctx: ExtensionContext): Promise<PrPublishOptions | null> {
    if (!ctx.hasUI) return options;

    const settings = this.loadSettings();
    if (!settings.promptForPublishMode) return options;
    if (this.hasDryRunFlag(args)) return options;

    const choice = await ctx.ui.select("Publish mode", [
      "Dry-run first (safe)",
      "Publish now",
      "Cancel",
    ]);

    if (!choice || choice === "Cancel") {
      ctx.ui.notify("Stacked PR publish cancelled", "info");
      return null;
    }

    if (choice.startsWith("Dry-run")) {
      return { ...options, dryRun: true };
    }

    return { ...options, dryRun: false };
  }

  private parseArgsWithPlainMode(args: string): { plain: boolean; normalizedArgs: string } {
    const tokens = (args ?? "")
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);

    const filtered: string[] = [];
    let plain = false;

    for (const token of tokens) {
      if (token.toLowerCase() === "plain") {
        plain = true;
        continue;
      }
      filtered.push(token);
    }

    return {
      plain,
      normalizedArgs: filtered.join(" "),
    };
  }

  private async defaultBaseBranch(): Promise<string> {
    try {
      const gh = await this.execGh(["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"]);
      const branch = gh.stdout.trim();
      if (branch) return branch;
    } catch {
      // Fall through
    }

    try {
      const git = await this.pi.exec("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
      if (git.code === 0) {
        const branch = git.stdout.trim().split("/").pop()?.trim();
        if (branch) return branch;
      }
    } catch {
      // Fall through
    }

    return "main";
  }

  private branchForChange(node: StackNode): string {
    return `push-${node.changeIdShort}`;
  }

  private titleForChange(node: StackNode): string {
    const title = node.description.trim();
    if (title) return title;
    return `Change ${node.changeIdShort}`;
  }

  private bodyForChange(node: StackNode, base: string): string {
    return [
      `Stacked PR for jj change ${node.changeId}.`,
      "",
      `- change: ${node.changeId}`,
      `- revision: ${node.revision}`,
      `- base: ${base}`,
    ].join("\n");
  }

  private async getExistingPr(headBranch: string): Promise<GhPr | null> {
    const result = await this.execGh([
      "pr",
      "list",
      "--head",
      headBranch,
      "--state",
      "all",
      "--json",
      "number,url,state,title,baseRefName,headRefName,mergedAt",
      "--limit",
      "1",
    ]);

    const items = JSON.parse(result.stdout) as GhPr[];
    const pr = items[0] ?? null;
    if (!pr) return null;

    if (pr.state === "CLOSED" && pr.mergedAt) {
      return { ...pr, state: "MERGED" };
    }

    return pr;
  }

  private latestCheckpointEntryIdForChange(changeIdShort: string): string | null {
    const ordered = this.getOrderedCheckpoints();
    const match = ordered.find((cp) => cp.changeIdShort === changeIdShort);
    return match?.entryId ?? null;
  }

  private maybeLabelPrOnEntry(ctx: ExtensionContext, changeIdShort: string, prNumber?: number, prState?: string) {
    if (!prNumber) return;
    const entryId = this.latestCheckpointEntryIdForChange(changeIdShort);
    if (!entryId) return;

    const existing = ctx.sessionManager.getLabel?.(entryId);
    if (existing && !existing.startsWith("jj:")) return;

    const state = prState ? ` ${prState.toLowerCase()}` : "";
    const label = `jj:${changeIdShort} pr:#${prNumber}${state}`;
    this.pi.setLabel(entryId, label);
  }

  private appendPrStateEntry(data: {
    remote: string;
    dryRun?: boolean;
    draft?: boolean;
    records: PrRecord[];
    action: "publish" | "sync";
  }) {
    const now = Date.now();
    this.pi.appendEntry(PR_STATE_ENTRY_TYPE, {
      sessionId: this.sessionId,
      remote: data.remote,
      draft: data.draft ?? false,
      dryRun: data.dryRun ?? false,
      action: data.action,
      recordedAt: now,
      publishedAt: data.action === "publish" ? now : undefined,
      syncedAt: data.action === "sync" ? now : undefined,
      records: data.records,
    });
  }

  private latestPrStateSnapshot(ctx: ExtensionContext): PrStateSnapshot | null {
    const entries = ctx.sessionManager.getEntries();
    let latest: PrStateSnapshot | null = null;

    for (const entry of entries) {
      if (entry.type !== "custom") continue;
      if (entry.customType !== PR_STATE_ENTRY_TYPE) continue;

      const data = entry.data as {
        sessionId?: string;
        remote?: string;
        action?: "publish" | "sync" | string;
        recordedAt?: number;
        publishedAt?: number;
        syncedAt?: number;
        records?: PrRecord[];
      };

      if (this.sessionId && data.sessionId && data.sessionId !== this.sessionId) continue;
      if (!Array.isArray(data.records)) continue;

      const recordedAt = Number(data.recordedAt ?? data.syncedAt ?? data.publishedAt ?? 0);
      if (!recordedAt) continue;

      const snapshot: PrStateSnapshot = {
        remote: data.remote,
        action: data.action,
        recordedAt,
        records: data.records,
      };

      if (!latest || snapshot.recordedAt > latest.recordedAt) {
        latest = snapshot;
      }
    }

    return latest;
  }

  private prStateSummary(records: PrRecord[]): string {
    const counts = records.reduce(
      (acc, record) => {
        const key = (record.state || "MISSING").toUpperCase();
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    return `open=${counts.OPEN ?? 0} merged=${counts.MERGED ?? 0} closed=${counts.CLOSED ?? 0} missing=${counts.MISSING ?? 0}`;
  }

  private stackPrLabel(record?: PrRecord): string {
    if (!record) return "pr:-";
    if (!record.number) return `pr:${(record.state ?? "MISSING").toLowerCase()}`;
    return `pr:#${record.number} ${(record.state ?? "UNKNOWN").toLowerCase()}`;
  }

  private stackStatusNodeLine(view: StackStatusNodeView, index: number): string {
    return `${index + 1}. ${view.node.changeIdShort} rev:${view.node.revisionShort} ${view.node.description} (${view.prLabel})`;
  }

  private async collectStackStatusSnapshot(ctx: ExtensionContext): Promise<StackStatusSnapshot> {
    const checkpoints = this.getOrderedCheckpoints();
    const latestCheckpoint = checkpoints[0];

    const revision = await this.currentRevision({ ignoreWorkingCopy: true }).catch(() => "-");
    const change = await this.currentChangeInfo({ ignoreWorkingCopy: true }).catch(() => ({ id: "-", short: "-" }));
    const operation = await this.currentOperationInfo({ ignoreWorkingCopy: true }).catch(() => ({ id: "-", short: "-" }));
    const stack = await this.getStackNodes().catch(() => [] as StackNode[]);
    const prSnapshot = this.latestPrStateSnapshot(ctx);
    const prByChange = new Map((prSnapshot?.records ?? []).map((record) => [record.changeIdShort, record]));

    const stackViews: StackStatusNodeView[] = stack.map((node) => {
      const prRecord = prByChange.get(node.changeIdShort);
      return {
        node,
        prRecord,
        prLabel: this.stackPrLabel(prRecord),
      };
    });

    const stackLines = stackViews.length
      ? stackViews.map((view, i) => this.stackStatusNodeLine(view, i)).join("\n")
      : "(no mutable stack entries found)";

    const prSnapshotLine = prSnapshot
      ? `${prSnapshot.action ?? "unknown"} ${formatAge(prSnapshot.recordedAt)} remote:${prSnapshot.remote ?? "-"} ${this.prStateSummary(prSnapshot.records)}`
      : "-";

    const summary = [
      `current revision: ${revision}`,
      `current change: ${change.id} (${change.short})`,
      `current operation: ${operation.id} (${operation.short})`,
      `checkpoints: ${checkpoints.length}`,
      `latest checkpoint: ${latestCheckpoint ? checkpointLine(latestCheckpoint) : "-"}`,
      `latest PR snapshot: ${prSnapshotLine}`,
      `stack entries: ${stackViews.length}`,
      "stack:",
      stackLines,
    ].join("\n");

    return {
      revision,
      change,
      operation,
      checkpoints,
      latestCheckpoint,
      prSnapshot,
      stackViews,
      summary,
    };
  }

  private stackNodeDetailsLines(snapshot: StackStatusSnapshot, nodeIndex: number): string[] {
    const view = snapshot.stackViews[nodeIndex]!;
    const node = view.node;
    const expectedBase = nodeIndex === 0 ? "(default branch)" : this.branchForChange(snapshot.stackViews[nodeIndex - 1]!.node);
    const bookmark = this.branchForChange(node);

    const lines = [
      `change: ${node.changeId} (${node.changeIdShort})`,
      `revision: ${node.revision} (${node.revisionShort})`,
      `description: ${node.description}`,
      `bookmark: ${bookmark}`,
      `expected base: ${expectedBase}`,
      `PR state: ${view.prLabel}`,
    ];

    if (view.prRecord?.number) lines.push(`PR #: ${view.prRecord.number}`);
    if (view.prRecord?.url) lines.push(`PR URL: ${view.prRecord.url}`);
    if (view.prRecord?.base) lines.push(`Recorded base: ${view.prRecord.base}`);

    return lines;
  }

  private async showStackSummaryUi(snapshot: StackStatusSnapshot, ctx: ExtensionContext): Promise<void> {
    while (true) {
      const action = await ctx.ui.select(snapshot.summary, [
        "Copy current revision",
        "Copy current change ID",
        "Copy current operation ID",
        "Back",
      ]);

      if (!action || action === "Back") return;

      if (action === "Copy current revision") {
        ctx.ui.setEditorText(snapshot.revision);
        ctx.ui.notify("Revision copied to editor", "info");
        continue;
      }

      if (action === "Copy current change ID") {
        ctx.ui.setEditorText(snapshot.change.id);
        ctx.ui.notify("Change ID copied to editor", "info");
        continue;
      }

      if (action === "Copy current operation ID") {
        ctx.ui.setEditorText(snapshot.operation.id);
        ctx.ui.notify("Operation ID copied to editor", "info");
      }
    }
  }

  private async showStackNodeUi(snapshot: StackStatusSnapshot, nodeIndex: number, ctx: ExtensionContext): Promise<void> {
    while (true) {
      const view = snapshot.stackViews[nodeIndex]!;
      const node = view.node;
      const bookmark = this.branchForChange(node);

      const action = await ctx.ui.select(`Stack entry ${nodeIndex + 1}: ${node.changeIdShort}`, [
        "Show details",
        "Copy change ID",
        "Copy revision",
        "Copy bookmark name",
        "Back",
      ]);

      if (!action || action === "Back") return;

      let finalAction = action;

      if (action === "Show details") {
        const details = this.stackNodeDetailsLines(snapshot, nodeIndex).join("\n");
        const detailsAction = await ctx.ui.select(details, [
          "Copy change ID",
          "Copy revision",
          "Copy bookmark name",
          "Back",
        ]);

        if (!detailsAction || detailsAction === "Back") {
          return;
        }

        finalAction = detailsAction;
      }

      if (finalAction === "Copy change ID") {
        ctx.ui.setEditorText(node.changeId);
        ctx.ui.notify("Change ID copied to editor", "info");
        continue;
      }

      if (finalAction === "Copy revision") {
        ctx.ui.setEditorText(node.revision);
        ctx.ui.notify("Revision copied to editor", "info");
        continue;
      }

      if (finalAction === "Copy bookmark name") {
        ctx.ui.setEditorText(bookmark);
        ctx.ui.notify("Bookmark name copied to editor", "info");
      }
    }
  }

  private async showStackStatusUi(initialSnapshot: StackStatusSnapshot, args: string, ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify(initialSnapshot.summary, "info");
      return;
    }

    const parsed = this.parsePrPublishOptions(args);
    const remote = parsed.remote || (await this.defaultGitRemote()) || "origin";

    const summaryOption = "Show full summary";
    const planOption = `Run plan (remote: ${remote})`;
    const dryRunOption = `Run publish dry-run (remote: ${remote})`;
    const syncOption = `Run sync (remote: ${remote})`;
    const backOption = "Back";

    let snapshot = initialSnapshot;

    while (true) {
      const nodeOptions = snapshot.stackViews.map((view, i) => this.stackStatusNodeLine(view, i));

      const selected = await ctx.ui.select(`jj stack status (${snapshot.stackViews.length} entries)`, [
        summaryOption,
        ...nodeOptions,
        planOption,
        dryRunOption,
        syncOption,
        backOption,
      ]);

      if (!selected || selected === backOption) return;

      if (selected === summaryOption) {
        await this.showStackSummaryUi(snapshot, ctx);
        continue;
      }

      if (selected === planOption) {
        await this.commandJjPrPlan(`--remote ${remote}`, ctx);
        snapshot = await this.collectStackStatusSnapshot(ctx);
        continue;
      }

      if (selected === dryRunOption) {
        await this.commandJjPrPublish(`--dry-run --remote ${remote}`, ctx);
        snapshot = await this.collectStackStatusSnapshot(ctx);
        continue;
      }

      if (selected === syncOption) {
        await this.commandJjPrSync(`--remote ${remote}`, ctx);
        snapshot = await this.collectStackStatusSnapshot(ctx);
        continue;
      }

      const nodeIndex = nodeOptions.indexOf(selected);
      if (nodeIndex < 0) continue;

      await this.showStackNodeUi(snapshot, nodeIndex, ctx);
    }
  }

  private prPlanEntryLine(view: PrPlanEntryView, index: number): string {
    return `${index + 1}. ${view.node.changeIdShort} rev:${view.node.revisionShort} ${view.node.description}`;
  }

  private prPlanEntryDetailsLines(view: PrPlanEntryView): string[] {
    return [
      `change: ${view.node.changeId} (${view.node.changeIdShort})`,
      `revision: ${view.node.revision} (${view.node.revisionShort})`,
      `description: ${view.node.description}`,
      `branch: ${view.branch}`,
      `base target: ${view.baseBranch}`,
      `dry-run push: ${view.dryRunPushCommand}`,
      `PR intent: ${view.prIntent}`,
    ];
  }

  private async collectPrPlanSnapshot(args: string): Promise<PrPlanSnapshot> {
    const stack = await this.getStackNodes();
    const options = this.parsePrPublishOptions(args);
    const remote = options.remote || (await this.defaultGitRemote()) || "origin";
    const defaultBase = await this.defaultBaseBranch();

    const entries: PrPlanEntryView[] = stack.map((node, i) => {
      const branch = this.branchForChange(node);
      const baseBranch = i === 0 ? defaultBase : this.branchForChange(stack[i - 1]!);
      const dryRunPushCommand = `jj bookmark set ${branch} -r ${node.changeIdShort} && jj git push --bookmark ${branch} --remote ${remote} --dry-run`;
      const prIntent = `head=${branch} base=${baseBranch}`;

      return {
        node,
        branch,
        baseBranch,
        dryRunPushCommand,
        prIntent,
      };
    });

    const lines: string[] = [];
    lines.push(`remote: ${remote}`);
    lines.push(`default base: ${defaultBase}`);
    lines.push(`stack entries: ${entries.length}`);
    lines.push("");

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      lines.push(this.prPlanEntryLine(entry, i));
      lines.push(`   branch: ${entry.branch}`);
      lines.push(`   base target: ${entry.baseBranch}`);
      lines.push(`   dry-run push: ${entry.dryRunPushCommand}`);
      lines.push(`   PR intent: ${entry.prIntent}`);
      lines.push("");
    }

    lines.push("next step: run /jj-pr-publish --dry-run, then /jj-pr-publish when ready.");

    return {
      remote,
      defaultBase,
      entries,
      summary: lines.join("\n"),
    };
  }

  private async showPrPlanSummaryUi(snapshot: PrPlanSnapshot, ctx: ExtensionContext): Promise<void> {
    while (true) {
      const action = await ctx.ui.select(snapshot.summary, [
        "Copy remote",
        "Copy default base",
        "Back",
      ]);

      if (!action || action === "Back") return;

      if (action === "Copy remote") {
        ctx.ui.setEditorText(snapshot.remote);
        ctx.ui.notify("Remote copied to editor", "info");
        continue;
      }

      if (action === "Copy default base") {
        ctx.ui.setEditorText(snapshot.defaultBase);
        ctx.ui.notify("Default base copied to editor", "info");
      }
    }
  }

  private async showPrPlanEntryUi(snapshot: PrPlanSnapshot, index: number, ctx: ExtensionContext): Promise<void> {
    const entry = snapshot.entries[index]!;

    while (true) {
      const details = this.prPlanEntryDetailsLines(entry).join("\n");
      const action = await ctx.ui.select(details, [
        "Copy change ID",
        "Copy revision",
        "Copy branch",
        "Copy base target",
        "Copy dry-run push command",
        "Copy PR intent",
        "Back",
      ]);

      if (!action || action === "Back") return;

      if (action === "Copy change ID") {
        ctx.ui.setEditorText(entry.node.changeId);
        ctx.ui.notify("Change ID copied to editor", "info");
        continue;
      }

      if (action === "Copy revision") {
        ctx.ui.setEditorText(entry.node.revision);
        ctx.ui.notify("Revision copied to editor", "info");
        continue;
      }

      if (action === "Copy branch") {
        ctx.ui.setEditorText(entry.branch);
        ctx.ui.notify("Branch copied to editor", "info");
        continue;
      }

      if (action === "Copy base target") {
        ctx.ui.setEditorText(entry.baseBranch);
        ctx.ui.notify("Base target copied to editor", "info");
        continue;
      }

      if (action === "Copy dry-run push command") {
        ctx.ui.setEditorText(entry.dryRunPushCommand);
        ctx.ui.notify("Dry-run push command copied to editor", "info");
        continue;
      }

      if (action === "Copy PR intent") {
        ctx.ui.setEditorText(entry.prIntent);
        ctx.ui.notify("PR intent copied to editor", "info");
      }
    }
  }

  private async showPrPlanUi(initialSnapshot: PrPlanSnapshot, ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify(initialSnapshot.summary, "info");
      return;
    }

    let snapshot = initialSnapshot;

    while (true) {
      const summaryOption = "Show full plan";
      const dryRunOption = `Run publish dry-run (remote: ${snapshot.remote})`;
      const backOption = "Back";
      const entryOptions = snapshot.entries.map((entry, i) => this.prPlanEntryLine(entry, i));

      const selected = await ctx.ui.select(`jj pr plan (${snapshot.entries.length} entries, remote ${snapshot.remote})`, [
        summaryOption,
        ...entryOptions,
        dryRunOption,
        backOption,
      ]);

      if (!selected || selected === backOption) return;

      if (selected === summaryOption) {
        await this.showPrPlanSummaryUi(snapshot, ctx);
        continue;
      }

      if (selected === dryRunOption) {
        await this.commandJjPrPublish(`--dry-run --remote ${snapshot.remote}`, ctx);
        snapshot = await this.collectPrPlanSnapshot(`--remote ${snapshot.remote}`);
        continue;
      }

      const entryIndex = entryOptions.indexOf(selected);
      if (entryIndex < 0) continue;

      await this.showPrPlanEntryUi(snapshot, entryIndex, ctx);
    }
  }

  private maybeLabelEntry(ctx: ExtensionContext, entryId: string, checkpoint: Checkpoint) {
    const label = `jj:${checkpoint.changeIdShort ?? checkpoint.revision.slice(0, 8)}`;

    const existing = ctx.sessionManager.getLabel?.(entryId);
    if (existing && !existing.startsWith("jj:")) return;

    this.pi.setLabel(entryId, label);
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

      const settings = this.loadSettings();
      let target: { mode: "file"; revision: string } | { mode: "operation"; operationId: string };
      if (settings.restoreMode === "operation") {
        if (!checkpoint.operationId) {
          ctx.ui.notify("Checkpoint has no operation ID (created before op tracking)", "warning");
          return;
        }
        target = { mode: "operation", operationId: checkpoint.operationId };
      } else {
        target = { mode: "file", revision: checkpoint.revision };
      }

      const success = await this.restoreWithUndo(target, ctx);
      if (success) {
        const label = target.mode === "operation"
          ? `op ${checkpoint.operationIdShort ?? checkpoint.operationId!.slice(0, 12)}`
          : `rev ${checkpoint.revision.slice(0, 12)}`;
        ctx.ui.notify(`Restored from checkpoint (${label})`, "info");
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
      `change: ${checkpoint.changeId ?? "-"}`,
      `changeShort: ${checkpoint.changeIdShort ?? "-"}`,
      `pre-turn op: ${checkpoint.operationId ?? "-"} (${checkpoint.operationIdShort ?? "-"})`,
      `post-turn op: ${checkpoint.postOperationId ?? "-"} (${checkpoint.postOperationIdShort ?? "-"})`,
      `timestamp: ${new Date(checkpoint.timestamp).toISOString()}`,
      `age: ${formatAge(checkpoint.timestamp)}`,
    ].join("\n");

    ctx.ui.notify(details, "info");
  }

  private async restoreWithUndo(target: { mode: "file"; revision: string } | { mode: "operation"; operationId: string }, ctx: ExtensionContext): Promise<boolean> {
    try {
      const beforeOp = await this.currentOperationInfo();
      if (target.mode === "operation") {
        await this.restoreToOperation(target.operationId);
      } else {
        await this.restoreFilesFromRevision(target.revision);
      }
      this.lastRestoreOperationId = beforeOp.id;
      return true;
    } catch (error) {
      ctx.ui.notify(`Failed to restore: ${String(error)}`, "error");
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
        const op = await this.currentOperationInfo();
        this.resumeCheckpointOperationId = op.id;
      } catch {
        this.resumeCheckpointOperationId = null;
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
      const revision = await this.currentRevision();
      const change = await this.currentChangeInfo();
      const operation = await this.currentOperationInfo();

      this.pendingCheckpoint = {
        revision,
        timestamp: event.timestamp,
        changeId: change.id,
        changeIdShort: change.short,
        operationId: operation.id,
        operationIdShort: operation.short,
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

    let postOpId: string | undefined;
    let postOpShort: string | undefined;
    try {
      const postOp = await this.currentOperationInfo();
      postOpId = postOp.id;
      postOpShort = postOp.short;
    } catch {
      // pre-turn op will be used as fallback
    }

    const checkpoint: Checkpoint = {
      entryId: userEntry.id,
      revision: this.pendingCheckpoint.revision,
      timestamp: this.pendingCheckpoint.timestamp,
      changeId: this.pendingCheckpoint.changeId,
      changeIdShort: this.pendingCheckpoint.changeIdShort,
      operationId: this.pendingCheckpoint.operationId,
      operationIdShort: this.pendingCheckpoint.operationIdShort,
      postOperationId: postOpId,
      postOperationIdShort: postOpShort,
    };

    this.checkpoints.set(userEntry.id, checkpoint);
    this.pruneCheckpoints();

    this.pi.appendEntry(CHECKPOINT_ENTRY_TYPE, {
      ...checkpoint,
      sessionId: this.sessionId,
    });

    this.maybeLabelEntry(ctx, userEntry.id, checkpoint);

    this.pendingCheckpoint = null;
    this.setStatus(ctx);

    if (ctx.hasUI && !this.loadSettings().silentCheckpoints) {
      ctx.ui.notify(`jj checkpoint saved (${this.checkpoints.size})`, "info");
    }
  }

  async handleSessionBeforeFork(event: ForkEventLike, ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (!(await this.ensureJjRepo())) return;

    const restoreTarget = this.resolveRestoreTarget(event.entryId, ctx);
    const options = ["Conversation only (keep current files)"];

    if (restoreTarget) {
      options.push("Restore + conversation");
      options.push("Restore only (keep conversation)");
    }

    if (this.lastRestoreOperationId) {
      options.push("Undo last rewind");
    }

    const choice = await ctx.ui.select("jj rewind options", options);
    if (!choice) return { cancel: true };

    if (choice.startsWith("Conversation only")) {
      return;
    }

    if (choice === "Undo last rewind") {
      const undoOpId = this.lastRestoreOperationId;
      if (!undoOpId) return { cancel: true };

      const success = await this.restoreWithUndo({ mode: "operation", operationId: undoOpId }, ctx);
      if (success) {
        ctx.ui.notify("Rewind undone", "info");
      }
      return { cancel: true };
    }

    if (!restoreTarget) {
      ctx.ui.notify("No jj checkpoint found for that point", "warning");
      return { cancel: true };
    }

    const success = await this.restoreWithUndo(restoreTarget, ctx);
    if (!success) {
      return { cancel: true };
    }

    ctx.ui.notify("Restored to checkpoint", "info");

    if (choice === "Restore only (keep conversation)") {
      return { skipConversationRestore: true };
    }
  }

  async handleSessionBeforeTree(event: TreeEventLike, ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (!(await this.ensureJjRepo())) return;

    const targetId = event.preparation.targetId;
    const restoreTarget = this.resolveRestoreTarget(targetId, ctx);

    const options = ["Keep current files"];
    if (restoreTarget) options.push("Restore to selected point");
    if (this.lastRestoreOperationId) options.push("Undo last rewind");
    options.push("Cancel navigation");

    const choice = await ctx.ui.select("jj rewind options", options);
    if (!choice || choice === "Cancel navigation") {
      return { cancel: true };
    }

    if (choice === "Keep current files") {
      return;
    }

    if (choice === "Undo last rewind") {
      const undoOpId = this.lastRestoreOperationId;
      if (!undoOpId) return { cancel: true };

      const success = await this.restoreWithUndo({ mode: "operation", operationId: undoOpId }, ctx);
      if (success) {
        ctx.ui.notify("Rewind undone", "info");
      }
      return { cancel: true };
    }

    if (!restoreTarget) {
      ctx.ui.notify("No jj checkpoint found for that point", "warning");
      return { cancel: true };
    }

    const success = await this.restoreWithUndo(restoreTarget, ctx);
    if (!success) {
      return { cancel: true };
    }

    ctx.ui.notify("Restored to checkpoint", "info");
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
      const op = await this.currentOperationInfo();
      this.resumeCheckpointOperationId = op.id;
    } catch {
      this.resumeCheckpointOperationId = null;
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

  async commandJjStackStatus(args: string, ctx: ExtensionContext) {
    if (!(await this.ensureJjRepo())) {
      ctx.ui.notify("Not a jj repo", "warning");
      return;
    }

    const mode = (args ?? "").trim().toLowerCase();
    const snapshot = await this.collectStackStatusSnapshot(ctx);

    if (!ctx.hasUI || mode === "plain") {
      ctx.ui.notify(snapshot.summary, "info");
      return;
    }

    await this.showStackStatusUi(snapshot, args, ctx);
  }

  async commandJjPrPlan(args: string, ctx: ExtensionContext) {
    if (!(await this.ensureJjRepo())) {
      ctx.ui.notify("Not a jj repo", "warning");
      return;
    }

    const parsed = this.parseArgsWithPlainMode(args);
    const snapshot = await this.collectPrPlanSnapshot(parsed.normalizedArgs);

    if (snapshot.entries.length === 0) {
      ctx.ui.notify("No mutable stack entries found", "info");
      return;
    }

    if (!ctx.hasUI || parsed.plain) {
      ctx.ui.notify(snapshot.summary, "info");
      return;
    }

    await this.showPrPlanUi(snapshot, ctx);
  }

  async commandJjPrPublish(args: string, ctx: ExtensionContext) {
    if (!(await this.ensureJjRepo())) {
      ctx.ui.notify("Not a jj repo", "warning");
      return;
    }

    const stack = await this.getStackNodes();
    if (stack.length === 0) {
      ctx.ui.notify("No mutable stack entries found", "info");
      return;
    }

    const parsedOptions = this.parsePrPublishOptions(args);
    const maybeSelectedOptions = await this.maybePromptPublishMode(parsedOptions, args, ctx);
    if (!maybeSelectedOptions) return;

    const options = maybeSelectedOptions;
    const remote = options.remote || (await this.defaultGitRemote()) || "origin";
    const defaultBase = await this.defaultBaseBranch();
    const autoSyncOnPublish = this.loadSettings().autoSyncOnPublish;

    try {
      await this.execGh(["auth", "status"]);
    } catch (error) {
      ctx.ui.notify(`GitHub auth required for PR publish: ${String(error)}`, "error");
      return;
    }

    const header = `Publish stacked PRs to ${remote}?\nentries=${stack.length}\ndefault base=${defaultBase}\ndraft=${options.draft}\ndry-run=${options.dryRun}`;
    if (ctx.hasUI && !options.dryRun) {
      const confirmed = await ctx.ui.confirm("Confirm stacked PR publish", header);
      if (!confirmed) {
        ctx.ui.notify("Stacked PR publish cancelled", "info");
        return;
      }
    }

    const progressKey = `${STATUS_KEY}:publish`;

    if (autoSyncOnPublish) {
      if (ctx.hasUI) {
        ctx.ui.setStatus(progressKey, `pi-jj publish: refreshing PR state before ${options.dryRun ? "dry-run" : "publish"}`);
      }
      try {
        await this.refreshPrSnapshot(remote, stack, ctx, {
          retargetBases: false,
          persist: true,
          notify: false,
        });
      } catch (error) {
        ctx.ui.notify(`Auto-refresh before publish failed: ${String(error)}`, "warning");
      }
    }

    const records: PrRecord[] = [];

    if (ctx.hasUI) {
      ctx.ui.setStatus(progressKey, `pi-jj publish: preparing ${options.dryRun ? "dry-run" : "publish"} (${stack.length} entries)`);
    }

    try {
      for (let i = 0; i < stack.length; i++) {
        const node = stack[i]!;
        const branch = this.branchForChange(node);
        const baseBranch = this.computeExpectedBase(stack, i, records, defaultBase) ?? defaultBase;
        const title = this.titleForChange(node);
        const body = this.bodyForChange(node, baseBranch);

        if (ctx.hasUI) {
          ctx.ui.setStatus(
            progressKey,
            `pi-jj publish: ${options.dryRun ? "dry-run" : "publish"} ${i + 1}/${stack.length} ${node.changeIdShort}`,
          );
        }

        if (options.dryRun) {
          const existing = await this.getExistingPr(branch).catch(() => null);
          records.push({
            changeId: node.changeId,
            changeIdShort: node.changeIdShort,
            branch,
            base: baseBranch,
            title,
            number: existing?.number,
            url: existing?.url,
            state: existing?.state || "MISSING",
          });
          continue;
        }

        if (ctx.hasUI) ctx.ui.setStatus(progressKey, `pi-jj publish: setting bookmark ${i + 1}/${stack.length} ${branch}`);
        await this.execJj(["bookmark", "set", branch, "-r", node.changeId]);

        if (ctx.hasUI) ctx.ui.setStatus(progressKey, `pi-jj publish: pushing ${i + 1}/${stack.length} ${branch}`);
        await this.execJj(["git", "push", "--bookmark", branch, "--remote", remote]);

        if (ctx.hasUI) ctx.ui.setStatus(progressKey, `pi-jj publish: syncing PR ${i + 1}/${stack.length} ${branch}`);
        const existing = await this.getExistingPr(branch);
        let number: number | undefined;
        let url: string | undefined;
        let state: string | undefined;

        if (!existing) {
          const createArgs = [
            "pr",
            "create",
            "--head",
            branch,
            "--base",
            baseBranch,
            "--title",
            title,
            "--body",
            body,
          ];
          if (options.draft) createArgs.push("--draft");

          const created = await this.execGh(createArgs);
          url = created.stdout.trim().split("\n").find((line) => line.includes("http"))?.trim();

          const createdInfo = await this.getExistingPr(branch);
          number = createdInfo?.number;
          state = createdInfo?.state;
          url = createdInfo?.url || url;
        } else if (existing.state === "OPEN") {
          await this.execGh(["pr", "edit", String(existing.number), "--base", baseBranch, "--title", title, "--body", body]);
          number = existing.number;
          url = existing.url;
          state = existing.state;
        } else {
          number = existing.number;
          url = existing.url;
          state = existing.state;
        }

        const record: PrRecord = {
          changeId: node.changeId,
          changeIdShort: node.changeIdShort,
          branch,
          base: baseBranch,
          number,
          url,
          state,
          title,
        };
        records.push(record);

        this.maybeLabelPrOnEntry(ctx, node.changeIdShort, number, state);
      }

      if (!options.dryRun) {
        this.appendPrStateEntry({
          remote,
          draft: options.draft,
          dryRun: options.dryRun,
          records,
          action: "publish",
        });
      }

      if (autoSyncOnPublish && !options.dryRun) {
        if (ctx.hasUI) {
          ctx.ui.setStatus(progressKey, "pi-jj publish: refreshing PR state after publish");
        }
        try {
          await this.refreshPrSnapshot(remote, stack, ctx, {
            retargetBases: true,
            persist: true,
            notify: false,
          });
        } catch (error) {
          ctx.ui.notify(`Auto-refresh after publish failed: ${String(error)}`, "warning");
        }
      }

      const lines: string[] = [];
      lines.push(`remote: ${remote}`);
      lines.push(`mode: ${options.dryRun ? "dry-run" : "publish"}`);
      lines.push(`entries: ${records.length}`);
      lines.push("");

      for (const [i, record] of records.entries()) {
        lines.push(`${i + 1}. ${record.changeIdShort} -> ${record.branch} (base ${record.base})`);
        if (record.number) lines.push(`   PR #${record.number}`);
        if (record.url) lines.push(`   ${record.url}`);
        if (record.state) lines.push(`   state: ${record.state}`);
      }

      ctx.ui.notify(lines.join("\n"), "info");
    } catch (error) {
      ctx.ui.notify(`Stacked PR publish failed: ${String(error)}`, "error");
    } finally {
      if (ctx.hasUI) {
        ctx.ui.setStatus(progressKey, undefined);
      }
    }
  }

  private async refreshPrSnapshot(
    remote: string,
    stack: StackNode[],
    ctx: ExtensionContext,
    options: { retargetBases: boolean; persist: boolean; notify: boolean },
  ): Promise<{ records: PrRecord[]; retargeted: string[]; defaultBase: string }> {
    const defaultBase = await this.defaultBaseBranch();
    const records: PrRecord[] = [];
    const retargeted: string[] = [];

    for (let i = 0; i < stack.length; i++) {
      const node = stack[i]!;
      const branch = this.branchForChange(node);
      const pr = await this.getExistingPr(branch);
      const title = pr?.title?.trim() || this.titleForChange(node);
      let base = pr?.baseRefName || "-";

      if (options.retargetBases && pr?.state === "OPEN" && pr.number) {
        const expectedBase = this.computeExpectedBase(stack, i, records, defaultBase);
        if (expectedBase && pr.baseRefName !== expectedBase) {
          try {
            await this.execGh(["pr", "edit", String(pr.number), "--base", expectedBase]);
            retargeted.push(`PR #${pr.number}: ${pr.baseRefName} → ${expectedBase}`);
            base = expectedBase;
          } catch {
            // retarget failed, continue with current base
          }
        }
      }

      const record: PrRecord = {
        changeId: node.changeId,
        changeIdShort: node.changeIdShort,
        branch,
        base,
        number: pr?.number,
        url: pr?.url,
        state: pr?.state || "MISSING",
        title,
      };
      records.push(record);

      this.maybeLabelPrOnEntry(ctx, node.changeIdShort, pr?.number, pr?.state);
    }

    if (options.persist) {
      this.appendPrStateEntry({
        remote,
        records,
        action: "sync",
      });
    }

    if (options.notify) {
      const counts = records.reduce(
        (acc, record) => {
          const key = (record.state || "MISSING").toUpperCase();
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );

      const lines: string[] = [];
      lines.push(`remote: ${remote}`);
      lines.push(`mode: sync`);
      lines.push(`entries: ${records.length}`);
      lines.push(`open=${counts.OPEN ?? 0} merged=${counts.MERGED ?? 0} closed=${counts.CLOSED ?? 0} missing=${counts.MISSING ?? 0}`);

      if (retargeted.length > 0) {
        lines.push(`retargeted: ${retargeted.length}`);
        for (const msg of retargeted) {
          lines.push(`   ${msg}`);
        }
      }

      lines.push("");

      for (const [i, record] of records.entries()) {
        lines.push(`${i + 1}. ${record.changeIdShort} -> ${record.branch}`);
        lines.push(`   state: ${record.state}`);
        if (record.base && record.base !== "-") lines.push(`   base: ${record.base}`);
        if (record.number) lines.push(`   PR #${record.number}`);
        if (record.url) lines.push(`   ${record.url}`);
      }

      ctx.ui.notify(lines.join("\n"), "info");
    }

    return { records, retargeted, defaultBase };
  }

  async commandJjPrSync(args: string, ctx: ExtensionContext) {
    if (!(await this.ensureJjRepo())) {
      ctx.ui.notify("Not a jj repo", "warning");
      return;
    }

    const stack = await this.getStackNodes();
    if (stack.length === 0) {
      ctx.ui.notify("No mutable stack entries found", "info");
      return;
    }

    const options = this.parsePrPublishOptions(args);
    const remote = options.remote || (await this.defaultGitRemote()) || "origin";

    try {
      await this.execGh(["auth", "status"]);
    } catch (error) {
      ctx.ui.notify(`GitHub auth required for PR sync: ${String(error)}`, "error");
      return;
    }

    await this.refreshPrSnapshot(remote, stack, ctx, {
      retargetBases: true,
      persist: true,
      notify: true,
    });
  }

  async commandJjStackClose(args: string, ctx: ExtensionContext) {
    if (!(await this.ensureJjRepo())) {
      ctx.ui.notify("Not a jj repo", "warning");
      return;
    }

    const stack = await this.getStackNodes();
    if (stack.length === 0) {
      ctx.ui.notify("No mutable stack entries found", "info");
      return;
    }

    const options = this.parseStackCloseOptions(args);
    const remote = options.remote || (await this.defaultGitRemote()) || "origin";
    const branches = [...new Set(stack.map((node) => this.branchForChange(node)))];

    let openRecords: PrRecord[] = [];
    try {
      await this.execGh(["auth", "status"]);
      const refreshed = await this.refreshPrSnapshot(remote, stack, ctx, {
        retargetBases: false,
        persist: true,
        notify: false,
      });
      openRecords = refreshed.records.filter((record) => (record.state ?? "").toUpperCase() === "OPEN");
    } catch (error) {
      if (!options.force) {
        ctx.ui.notify(`Could not refresh PR state before stack close: ${String(error)}. Re-run with --force to continue.`, "warning");
        return;
      }
      ctx.ui.notify(`Proceeding without PR refresh (--force): ${String(error)}`, "warning");
    }

    if (openRecords.length > 0 && !options.force) {
      const lines = openRecords
        .slice(0, 10)
        .map((record) => `- ${record.changeIdShort} pr:#${record.number ?? "?"} ${record.url ?? ""}`.trim());
      const suffix = openRecords.length > lines.length ? `\n...and ${openRecords.length - lines.length} more` : "";
      ctx.ui.notify(
        `Cannot close stack: ${openRecords.length} open PR(s) remain. Merge/close them first, or run /jj-stack-close --force.\n${lines.join("\n")}${suffix}`,
        "warning",
      );
      return;
    }

    const summary = [
      `remote: ${remote}`,
      `stack entries: ${stack.length}`,
      `bookmarks in stack: ${branches.length}`,
      `open PRs detected: ${openRecords.length}`,
      `delete bookmarks: ${options.keepBookmarks ? "no (--keep-bookmarks)" : "yes"}`,
      `create new change from main: ${options.noNewChange ? "no (--no-new-change)" : "yes"}`,
      `mode: ${options.dryRun ? "dry-run" : "execute"}`,
    ].join("\n");

    if (options.dryRun) {
      const lines = [
        "jj-stack-close dry-run",
        summary,
        "",
        "bookmarks:",
        ...branches.map((branch) => `- ${branch}`),
      ];
      ctx.ui.notify(lines.join("\n"), "info");
      return;
    }

    if (ctx.hasUI) {
      const confirmed = await ctx.ui.confirm("Close current stack", summary);
      if (!confirmed) {
        ctx.ui.notify("Stack close cancelled", "info");
        return;
      }
    }

    const errors: string[] = [];
    const deleted: string[] = [];

    if (!options.keepBookmarks) {
      for (const branch of branches) {
        const result = await this.pi.exec("jj", ["bookmark", "delete", branch]);
        if (result.code === 0) {
          deleted.push(branch);
          continue;
        }
        const stderr = (result.stderr ?? "").trim();
        if (stderr.includes("No such bookmark")) continue;
        errors.push(`delete ${branch}: ${stderr || "failed"}`);
      }

      if (deleted.length > 0) {
        const pushArgs = ["git", "push", "--remote", remote] as string[];
        for (const branch of deleted) {
          pushArgs.push("--bookmark", branch);
        }

        const pushDeleted = await this.pi.exec("jj", pushArgs);
        if (pushDeleted.code !== 0) {
          errors.push(`push bookmark deletions: ${(pushDeleted.stderr ?? "").trim() || "failed"}`);
        }
      }
    }

    let newChangeCreated = false;
    let newChangeBase = "";

    if (!options.noNewChange) {
      const defaultBase = await this.defaultBaseBranch();
      const preferredBase = `${defaultBase}@origin`;
      let create = await this.pi.exec("jj", ["new", preferredBase, "-m", "chore: start next stack"]);
      if (create.code === 0) {
        newChangeCreated = true;
        newChangeBase = preferredBase;
      } else {
        create = await this.pi.exec("jj", ["new", defaultBase, "-m", "chore: start next stack"]);
        if (create.code === 0) {
          newChangeCreated = true;
          newChangeBase = defaultBase;
        } else {
          errors.push(`create new change: ${(create.stderr ?? "").trim() || "failed"}`);
        }
      }
    }

    const resultLines = [
      "jj stack close complete",
      `remote: ${remote}`,
      `bookmarks deleted: ${deleted.length}`,
      `new change created: ${newChangeCreated ? `yes (${newChangeBase})` : options.noNewChange ? "skipped" : "no"}`,
    ];

    if (errors.length > 0) {
      resultLines.push("errors:");
      resultLines.push(...errors.map((error) => `- ${error}`));
      ctx.ui.notify(resultLines.join("\n"), "warning");
      return;
    }

    ctx.ui.notify(resultLines.join("\n"), "info");
  }

  private computeExpectedBase(stack: StackNode[], index: number, records: PrRecord[], defaultBase: string): string | null {
    if (index === 0) return defaultBase;

    for (let i = index - 1; i >= 0; i--) {
      const prevRecord = records[i];
      if (!prevRecord) continue;

      if (prevRecord.state === "MERGED" || prevRecord.state === "CLOSED") {
        continue;
      }

      return prevRecord.branch;
    }

    return defaultBase;
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
        `Reloaded piJj settings: silent=${reloaded.silentCheckpoints}, max=${reloaded.maxCheckpoints}, list=${reloaded.checkpointListLimit}, promptInit=${reloaded.promptForInit}, promptPublishMode=${reloaded.promptForPublishMode}, autoSyncOnPublish=${reloaded.autoSyncOnPublish}, restore=${reloaded.restoreMode}`,
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
        `promptForPublishMode: ${settings.promptForPublishMode}\n` +
        `autoSyncOnPublish: ${settings.autoSyncOnPublish}\n` +
        `restoreMode: ${settings.restoreMode}\n` +
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
      const op = await this.currentOperationInfo();
      this.resumeCheckpointOperationId = op.id;
    } catch {
      this.resumeCheckpointOperationId = null;
    }

    this.setStatus(ctx);
  }
}
