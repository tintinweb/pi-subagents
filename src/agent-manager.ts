/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * Background agents are subject to a configurable concurrency limit (default: 4).
 * Excess agents are queued and auto-started as running agents complete.
 * Foreground agents bypass the queue (they block the parent anyway).
 */

import { randomUUID } from "node:crypto";
import type { Model } from "@mariozechner/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { resumeAgent, runAgent, type ToolActivity } from "./agent-runner.js";
import type { AgentRecord, IsolationMode, SubagentType, ThinkingLevel } from "./types.js";
import { cleanupWorktree, createWorktree, pruneWorktrees, } from "./worktree.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;

/** Default max concurrent background agents. */
const DEFAULT_MAX_CONCURRENT = 4;

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

interface SpawnOptions {
  description: string;
  model?: Model<any>;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  /** Isolation mode — "worktree" creates a temp git worktree for the agent. */
  isolation?: IsolationMode;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Called when the agent session is created (for accessing session stats). */
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /** Human-readable model identifier for diagnostics. */
  modelName?: string;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private maxConcurrent: number;
  private cleanupRetentionMs = 10 * 60_000;

  /** Queue of background agents waiting to start. */
  private queue: { id: string; args: SpawnArgs }[] = [];
  /** Number of currently running background agents. */
  private runningBackground = 0;

  constructor(onComplete?: OnAgentComplete, maxConcurrent = DEFAULT_MAX_CONCURRENT, onStart?: OnAgentStart) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.maxConcurrent = maxConcurrent;
    // Cleanup completed agents after 10 minutes (but keep sessions for resume)
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
  }

  /** Update the max concurrent background agents limit. */
  setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, n);
    // Start queued agents if the new limit allows
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /** Update the cleanup retention period (how long completed records survive before session disposal). */
  setCleanupRetention(ms: number) {
    this.cleanupRetentionMs = Math.max(60_000, ms);
  }

  getCleanupRetention(): number {
    return this.cleanupRetentionMs;
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the concurrency limit is reached, the agent is queued.
   */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    const id = randomUUID().slice(0, 17);
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      type,
      description: options.description,
      status: options.isBackground ? "queued" : "running",
      toolUses: 0,
      startedAt: Date.now(),
      abortController,
    };
    this.agents.set(id, record);

    const args: SpawnArgs = { pi, ctx, type, prompt, options };

    if (options.isBackground && this.runningBackground >= this.maxConcurrent) {
      // Queue it — will be started when a running agent completes
      this.queue.push({ id, args });
      return id;
    }

    this.startAgent(id, record, args);
    return id;
  }

  /** Actually start an agent (called immediately or from queue drain). */
  private startAgent(id: string, record: AgentRecord, { pi, ctx, type, prompt, options }: SpawnArgs) {
    record.status = "running";
    record.startedAt = Date.now();
    if (options.modelName) record.modelName = options.modelName;
    if (options.isBackground) this.runningBackground++;
    this.onStart?.(record);

    // Worktree isolation: create a temporary git worktree if requested
    let worktreeCwd: string | undefined;
    let worktreeWarning = "";
    if (options.isolation === "worktree") {
      const wt = createWorktree(ctx.cwd, id);
      if (wt) {
        record.worktree = wt;
        worktreeCwd = wt.path;
      } else {
        worktreeWarning = "\n\n[WARNING: Worktree isolation was requested but failed (not a git repo, or no commits yet). Running in the main working directory instead.]";
      }
    }

    // Prepend worktree warning to prompt if isolation failed
    const effectivePrompt = worktreeWarning ? worktreeWarning + "\n\n" + prompt : prompt;

    const promise = runAgent(ctx, type, effectivePrompt, {
      pi,
      model: options.model,
      maxTurns: options.maxTurns,
      isolated: options.isolated,
      inheritContext: options.inheritContext,
      thinkingLevel: options.thinkingLevel,
      cwd: worktreeCwd,
      signal: record.abortController!.signal,
      onToolActivity: (activity) => {
        if (activity.type === "end") record.toolUses++;
        options.onToolActivity?.(activity);
      },
      onTurnEnd: options.onTurnEnd,
      onTextDelta: options.onTextDelta,
      onSessionCreated: (session) => {
        record.session = session;
        // Flush any steers that arrived before the session was ready
        if (record.pendingSteers?.length) {
          for (const msg of record.pendingSteers) {
            session.steer(msg).catch(() => {});
          }
          record.pendingSteers = undefined;
        }
        options.onSessionCreated?.(session);
      },
    })
      .then(({ responseText, session, aborted, steered }) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          record.status = aborted ? "aborted" : steered ? "steered" : "completed";
        }
        record.result = responseText;
        record.session = session;
        record.completedAt ??= Date.now();
        this.captureStats(record);
        this.releaseRecordResources(record);

        // Clean up worktree if used
        if (record.worktree) {
          const wtResult = cleanupWorktree(ctx.cwd, record.worktree, options.description);
          record.worktreeResult = wtResult;
          if (wtResult.hasChanges && wtResult.branch) {
            record.result = (record.result ?? "") +
              `\n\n---\nChanges saved to branch \`${wtResult.branch}\`. Merge with: \`git merge ${wtResult.branch}\``;
          }
        }

        if (options.isBackground) {
          this.runningBackground--;
          this.onComplete?.(record);
          this.drainQueue();
        }
        return responseText;
      })
      .catch((err) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          record.status = "error";
        }
        record.error = (err instanceof Error ? err.message : String(err));
        record.completedAt ??= Date.now();
        this.captureStats(record);
        this.releaseRecordResources(record);

        // Best-effort worktree cleanup on error
        if (record.worktree) {
          try {
            const wtResult = cleanupWorktree(ctx.cwd, record.worktree, options.description);
            record.worktreeResult = wtResult;
          } catch { /* ignore cleanup errors */ }
        }

        if (options.isBackground) {
          this.runningBackground--;
          this.onComplete?.(record);
          this.drainQueue();
        }
        return "";
      });

    record.promise = promise;
  }

  /** Start queued agents up to the concurrency limit. */
  private drainQueue() {
    while (this.queue.length > 0 && this.runningBackground < this.maxConcurrent) {
      const next = this.queue.shift()!;
      const record = this.agents.get(next.id);
      if (!record || record.status !== "queued") continue;
      this.startAgent(next.id, record, next.args);
    }
  }

  /**
   * Spawn an agent and wait for completion (foreground use).
   * Foreground agents bypass the concurrency queue.
   */
  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
  ): Promise<AgentRecord> {
    const id = this.spawn(pi, ctx, type, prompt, { ...options, isBackground: false });
    const record = this.agents.get(id)!;
    await record.promise;
    return record;
  }

  /**
   * Resume an existing agent session with a new prompt.
   */
  async resume(
    id: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<AgentRecord | undefined> {
    const record = this.agents.get(id);
    if (!record?.session) return undefined;

    record.status = "running";
    record.startedAt = Date.now();
    record.completedAt = undefined;
    record.result = undefined;
    record.error = undefined;

    try {
      const responseText = await resumeAgent(record.session, prompt, {
        onToolActivity: (activity) => {
          if (activity.type === "end") record.toolUses++;
        },
        signal,
      });
      record.status = "completed";
      record.result = responseText;
      record.completedAt = Date.now();
    } catch (err) {
      record.status = "error";
      record.error = err instanceof Error ? err.message : String(err);
      record.completedAt = Date.now();
    }

    return record;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    // Remove from queue if queued
    if (record.status === "queued") {
      this.queue = this.queue.filter(q => q.id !== id);
      record.status = "stopped";
      record.completedAt = Date.now();
      return true;
    }

    if (record.status !== "running") return false;
    record.abortController?.abort();
    record.status = "stopped";
    record.completedAt = Date.now();
    return true;
  }

  /** Capture session token stats onto the record (idempotent). */
  private captureStats(record: AgentRecord): void {
    if (!record.session || record.stats) return;
    try {
      const s = record.session.getSessionStats();
      record.stats = {
        inputTokens: s.tokens?.input ?? 0,
        outputTokens: s.tokens?.output ?? 0,
        totalTokens: s.tokens?.total ?? 0,
      };
    } catch (err) {
      if (process.env.DEBUG) console.debug("[pi-subagents] captureStats failed:", err);
    }
  }

  /** Flush output subscription and release held resources from a record. */
  private releaseRecordResources(record: AgentRecord): void {
    if (record.outputCleanup) {
      try { record.outputCleanup(); } catch { /* ignore */ }
      record.outputCleanup = undefined;
    }
    record.abortController = undefined;
  }

  /** Tier 1 cleanup: dispose session resources but keep the record in the Map. */
  private disposeRecordSession(record: AgentRecord): void {
    this.captureStats(record);
    this.releaseRecordResources(record);
    record.session?.dispose?.();
    record.session = undefined;
    record.promise = undefined;
  }

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: AgentRecord): void {
    this.disposeRecordSession(record);
    this.agents.delete(id);
  }

  private cleanup() {
    const tier1Cutoff = Date.now() - this.cleanupRetentionMs;
    const tier2Cutoff = Date.now() - this.cleanupRetentionMs * 3;
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      const completed = record.completedAt ?? 0;
      if (completed >= tier1Cutoff) continue;
      if (completed < tier2Cutoff) {
        this.removeRecord(id, record); // Tier 2: full removal
      } else if (record.session) {
        this.disposeRecordSession(record); // Tier 1: session only
      }
    }
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   */
  clearCompleted(): void {
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      this.removeRecord(id, record);
    }
  }

  /** Whether any agents are still running or queued. */
  hasRunning(): boolean {
    return [...this.agents.values()].some(
      r => r.status === "running" || r.status === "queued",
    );
  }

  /** Abort all running and queued agents immediately. */
  abortAll(): number {
    let count = 0;
    // Clear queued agents first
    for (const queued of this.queue) {
      const record = this.agents.get(queued.id);
      if (record) {
        record.status = "stopped";
        record.completedAt = Date.now();
        count++;
      }
    }
    this.queue = [];
    // Abort running agents
    for (const record of this.agents.values()) {
      if (record.status === "running") {
        record.abortController?.abort();
        record.status = "stopped";
        record.completedAt = Date.now();
        count++;
      }
    }
    return count;
  }

  /** Wait for all running and queued agents to complete (including queued ones).
   *  @param timeoutMs Maximum wait time (default 5 minutes). Rejects with an error on timeout.
   */
  async waitForAll(timeoutMs = 5 * 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    // Loop because drainQueue respects the concurrency limit — as running
    // agents finish they start queued ones, which need awaiting too.
    while (true) {
      this.drainQueue();
      const pending = [...this.agents.values()]
        .filter(r => r.status === "running" || r.status === "queued")
        .map(r => r.promise)
        .filter(Boolean);
      if (pending.length === 0) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`waitForAll timed out after ${timeoutMs}ms with ${pending.length} agent(s) still running`);
      }
      let timer: ReturnType<typeof setTimeout>;
      await Promise.race([
        Promise.allSettled(pending).finally(() => clearTimeout(timer)),
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new Error("waitForAll timed out")), remaining);
        }),
      ]);
    }
  }

  dispose() {
    clearInterval(this.cleanupInterval);
    // Clear queue
    this.queue = [];
    for (const record of this.agents.values()) {
      this.releaseRecordResources(record);
      record.session?.dispose();
    }
    this.agents.clear();
    // Prune any orphaned git worktrees (crash recovery)
    try { pruneWorktrees(process.cwd()); } catch { /* ignore */ }
  }
}
