/**
 * journal.ts — cached workflow answers, not a checkpoint of their effects.
 *
 * Calls are identified by structural position, not arrival order: the root,
 * each parallel thunk, each pipeline item's stage chain, and each nested
 * workflow body number their own slots. Unchanged pipelines can then replay
 * even when their items finish in a different order.
 *
 * At the first missing, changed, failed, or invalid answer, the whole run stops
 * replaying. Structural branches can share files and other effects; a static
 * prompt does not prove independence from changed sibling or child work.
 *
 * Replay does not rerun tools or restore files. Use a fresh run after changing
 * external inputs, agent definitions, models, or the workspace. A run that used
 * agent({ resume }) cannot replay: cached text leaves no live child to resume.
 *
 * The JSON Lines file is appended as calls settle, preserving finished answers
 * if the run is interrupted. Old journals without structural paths are ignored.
 */

import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

/** One settled agent call, as replayed. */
export interface WorkflowJournalEntry {
  /** Structural identity: root #k, parallel /k:p:i, pipeline /k:l:i, child /k:w. */
  path: string;
  /** Arrival order, retained for displaying the journal, not for matching calls. */
  index: number;
  /** Hash of the call's payload; a mismatch stops further replay. */
  key: string;
  /** A failure stops further replay and is retried live. */
  ok: boolean;
  text?: string;
  /** A replayed answer leaves no conversation for a later agent({ resume }). */
  resumed?: true;
}

/** Fields affecting a call; progress phase grouping does not affect its answer. */
export interface JournalKeyInput {
  prompt: string;
  label?: string;
  model?: string;
  agentType?: string;
  effort?: string;
  isolation?: string;
  gate?: string;
  resume?: string;
  schema?: string;
}

/** Stable hash of a call's payload. Field order is fixed here, not by the caller. */
export function journalKey(input: JournalKeyInput): string {
  const canonical = JSON.stringify([
    input.prompt,
    input.label ?? null,
    input.model ?? null,
    input.agentType ?? null,
    input.effort ?? null,
    input.isolation ?? null,
    input.gate ?? null,
    input.resume ?? null,
    ...(input.schema !== undefined ? [input.schema] : []),
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/**
 * Read valid entries in arrival order. A missing or malformed record is a cache
 * miss, never a reason to refuse a new run. Truncated final lines are expected
 * after interruption; completed entries before them remain usable.
 */
export function readJournal(path: string): WorkflowJournalEntry[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }

  const entries: WorkflowJournalEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isEntry(parsed)) entries.push(parsed);
    } catch {
      // A torn line loses a cache hit, not the rest of the journal.
    }
  }
  entries.sort((a, b) => a.index - b.index);
  return entries;
}

/** Append one settled call. Failure to write is not failure to run. */
export function appendJournal(path: string, entry: WorkflowJournalEntry): void {
  try {
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf-8");
  } catch {
    // A journal that cannot be written costs a future resume, nothing more.
  }
}

function isEntry(value: unknown): value is WorkflowJournalEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.path === "string" &&
    /^(?:\/\d+:(?:p:\d+|l:\d+|w))*#\d+$/.test(entry.path) &&
    Number.isSafeInteger(entry.index) &&
    (entry.index as number) >= 0 &&
    typeof entry.key === "string" &&
    typeof entry.ok === "boolean" &&
    (entry.ok ? typeof entry.text === "string" : entry.text === undefined || typeof entry.text === "string") &&
    (entry.resumed === undefined || entry.resumed === true)
  );
}
