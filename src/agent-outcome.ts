import type { AgentOutcome, AgentRecord } from "./types.js";

const MAX_CAUSE_CODE_POINTS = 512;
const TRUNCATION_MARKER = "… [truncated]";
const UNKNOWN_CAUSE = "Unknown agent error.";

const SECRET_SUFFIX =
  "(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|passwd|secret|token)";
const SECRET_NAME = `(?:[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*[_-])?${SECRET_SUFFIX}`;

/** Sanitize an error before it crosses an agent lifecycle boundary. */
export function sanitizeAgentCause(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  let message = raw
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!message) return UNKNOWN_CAUSE;

  message = message
    .replace(/\b(Bearer|Basic)\s+[^\s,;?&]+/giu, "$1 [REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@")
    .replace(
      new RegExp(`([?&]\\s*${SECRET_NAME}\\s*=)[^&#\\s]*`, "giu"),
      "$1[REDACTED]",
    )
    .replace(
      new RegExp(`(["']?${SECRET_NAME}["']?)\\s*[:=]\\s*(?:"[^"]*"|'[^']*'|[^\\s,;&]+)`, "giu"),
      "$1=[REDACTED]",
    );

  const codePoints = [...message];
  if (codePoints.length <= MAX_CAUSE_CODE_POINTS) return message;
  const marker = [...TRUNCATION_MARKER];
  return codePoints.slice(0, MAX_CAUSE_CODE_POINTS - marker.length).join("") + TRUNCATION_MARKER;
}

function recoveryFor(
  record: Pick<AgentRecord, "status" | "session">,
  category: AgentOutcome["category"],
): Pick<AgentOutcome, "retryable" | "recovery" | "freshSpawn"> {
  if (category === "startup") {
    return {
      retryable: false,
      recovery: "start_fresh_after_correction",
      freshSpawn: "allowed_after_correction",
    };
  }
  if (record.status === "stopped") {
    return record.session
      ? { retryable: false, recovery: "resume_same_agent", freshSpawn: "forbidden" }
      : { retryable: false, recovery: "none", freshSpawn: "forbidden" };
  }
  if (record.status === "error" || record.status === "steered" || record.status === "aborted") {
    return record.session
      ? { retryable: false, recovery: "resume_same_agent", freshSpawn: "forbidden" }
      : { retryable: false, recovery: "none", freshSpawn: "forbidden" };
  }
  if (record.status === "queued" || record.status === "running") {
    return { retryable: false, recovery: "wait_for_agent", freshSpawn: "forbidden" };
  }
  return { retryable: false, recovery: "none", freshSpawn: "not_needed" };
}

export function buildAgentOutcome(
  record: Pick<AgentRecord, "id" | "status" | "error" | "result" | "session" | "stopOrigin">,
  phase: AgentOutcome["phase"],
  category?: AgentOutcome["category"],
): AgentOutcome {
  const resolvedCategory = category ?? (
    record.status === "error"
      ? record.session
        ? "provider"
        : "startup"
      : record.status === "steered" || record.status === "aborted"
        ? "max_turns"
        : record.status === "stopped"
          ? record.stopOrigin === "caller" ? "caller_stop" : "user_stop"
          : record.status === "completed"
            ? "completed"
            : "execution"
  );
  return {
    agentId: record.id,
    status: record.status,
    phase,
    category: resolvedCategory,
    ...recoveryFor(record, resolvedCategory),
    message: record.error,
    hasOutput: Boolean(record.result?.trim()),
  };
}

export function formatAgentOutcome(outcome: AgentOutcome): string {
  const lines = [
    "Agent outcome:",
    `  status: ${outcome.status}`,
    `  phase: ${outcome.phase}`,
    `  category: ${outcome.category}`,
    `  retryable: ${outcome.retryable}`,
    `  recovery: ${outcome.recovery}`,
    `  fresh_spawn: ${outcome.freshSpawn}`,
    `  agent_id: ${outcome.agentId}`,
  ];
  if (outcome.message) lines.push(`  message: ${outcome.message}`);
  lines.push(`  output_present: ${outcome.hasOutput}`);
  return lines.join("\n");
}

export function outcomeForRecord(
  record: AgentRecord,
  phase: AgentOutcome["phase"] = "run",
): AgentOutcome {
  return record.outcome ?? buildAgentOutcome(record, phase);
}
