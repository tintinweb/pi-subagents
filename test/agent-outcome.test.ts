import { describe, expect, it } from "vitest";
import { buildAgentOutcome, sanitizeAgentCause } from "../src/agent-outcome.js";
import type { AgentRecord } from "../src/types.js";

function outcomeRecord(overrides: Partial<AgentRecord>): AgentRecord {
  return {
    id: "agent-1",
    type: "general-purpose",
    description: "test",
    status: "error",
    toolUses: 0,
    startedAt: 0,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...overrides,
  };
}

describe("buildAgentOutcome recovery invariants", () => {
  it("advertises resume_same_agent only when a session exists", () => {
    const resumable = buildAgentOutcome(outcomeRecord({
      session: {} as AgentRecord["session"],
    }), "run", "provider");
    const noSession = buildAgentOutcome(outcomeRecord({}), "startup", "startup");

    expect(resumable.recovery).toBe("resume_same_agent");
    expect(noSession.recovery).not.toBe("resume_same_agent");
  });

  it.each([
    { stopOrigin: "user" as const, category: "user_stop" as const },
    { stopOrigin: "caller" as const, category: "caller_stop" as const },
  ])("gives a stopped no-session record no recovery for $category", ({ stopOrigin, category }) => {
    const outcome = buildAgentOutcome(outcomeRecord({ status: "stopped", stopOrigin }), "run", category);

    expect(outcome.recovery).toBe("none");
    expect(outcome.freshSpawn).toBe("forbidden");
  });
});

describe("sanitizeAgentCause", () => {
  it("exposes only a bounded redacted Error.message", () => {
    const source = new Error(
      "\u001b[31mprovider failed\u001b[0m\n" +
        "Authorization: Bearer secret-token https://alice:hunter2@example.test/run?api_key=key-123 " +
        "password = swordfish " +
        "x".repeat(700),
      { cause: { env: { API_KEY: "must-not-leak" } } },
    );
    source.stack = "STACK-MUST-NOT-LEAK";

    const sanitized = sanitizeAgentCause(source);

    expect(sanitized).toContain("provider failed");
    expect(sanitized).toContain("Bearer [REDACTED]");
    expect(sanitized).toContain("https://[REDACTED]@example.test");
    expect(sanitized).toContain("api_key=[REDACTED]");
    expect(sanitized).toContain("password=[REDACTED]");
    expect(sanitized).toContain("[truncated]");
    expect([...sanitized]).toHaveLength(512);
    expect(sanitized).not.toMatch(/secret-token|alice|hunter2|key-123|swordfish|STACK|must-not-leak/);
    expect(sanitized).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
  });

  it("redacts sensitive values in quoted JSON-style properties", () => {
    const sanitized = sanitizeAgentCause(
      'provider payload: {"apiKey":"key-json","password": "pass-json", "refresh_token" : "refresh-json"}',
    );

    expect(sanitized).toContain('"apiKey"=[REDACTED]');
    expect(sanitized).toContain('"password"=[REDACTED]');
    expect(sanitized).toContain('"refresh_token"=[REDACTED]');
    expect(sanitized).not.toMatch(/key-json|pass-json|refresh-json/);
  });

  it("redacts prefixed sensitive identifier suffixes without redacting neighboring keys", () => {
    const sanitized = sanitizeAgentCause(
      "OPENAI_API_KEY=key-123 ANTHROPIC_AUTH_TOKEN: token-456 DB_PASSWORD = secret-789 " +
        "openai_api_key=key-abc anthropic_auth_token: token-def db_password=secret-ghi " +
        "api_keyring=ordinary auth_tokenizer=ordinary password_hint=ordinary database_password_policy=ordinary",
    );

    expect(sanitized).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(sanitized).toContain("ANTHROPIC_AUTH_TOKEN=[REDACTED]");
    expect(sanitized).toContain("DB_PASSWORD=[REDACTED]");
    expect(sanitized).toContain("openai_api_key=[REDACTED]");
    expect(sanitized).toContain("anthropic_auth_token=[REDACTED]");
    expect(sanitized).toContain("db_password=[REDACTED]");
    expect(sanitized).toContain("api_keyring=ordinary");
    expect(sanitized).toContain("auth_tokenizer=ordinary");
    expect(sanitized).toContain("password_hint=ordinary");
    expect(sanitized).toContain("database_password_policy=ordinary");
    expect(sanitized).not.toMatch(/key-123|token-456|secret-789|key-abc|token-def|secret-ghi/);
  });

  it("uses a stable fallback without stringifying arbitrary values", () => {
    expect(sanitizeAgentCause({ password: "do-not-stringify" })).toBe("Unknown agent error.");
    expect(sanitizeAgentCause(new Error("   \n\t"))).toBe("Unknown agent error.");
  });

  it("preserves curated static messages", () => {
    expect(sanitizeAgentCause("Scheduler is not active in this session yet.")).toBe(
      "Scheduler is not active in this session yet.",
    );
  });
});
