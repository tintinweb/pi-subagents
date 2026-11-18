import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { installCacheRetention } from "../src/cache-retention.js";

/** A session whose stream function records the options of each call. */
function fakeSession() {
  const inner = vi.fn((_model: unknown, _context: unknown, _options?: { cacheRetention?: string; sessionId?: string }) => "stream");
  const session = { agent: { streamFunction: inner } } as unknown as AgentSession;
  const call = (options?: { cacheRetention?: string; sessionId?: string }) =>
    (session.agent.streamFunction as unknown as typeof inner)("model", "context", options);
  return { session, inner, call };
}

describe("installCacheRetention", () => {
  it("supplies the retention on a call that sets none, keeping the other options", () => {
    const { session, inner, call } = fakeSession();
    installCacheRetention(session, "short");

    expect(call({ sessionId: "s1" })).toBe("stream");
    expect(inner).toHaveBeenCalledWith("model", "context", { sessionId: "s1", cacheRetention: "short" });
  });

  it("supplies it when the call passes no options at all", () => {
    const { session, inner, call } = fakeSession();
    installCacheRetention(session, "long");

    call(undefined);
    expect(inner).toHaveBeenCalledWith("model", "context", { cacheRetention: "long" });
  });

  it("keeps a retention the call sets itself — compaction's none included", () => {
    const { session, inner, call } = fakeSession();
    installCacheRetention(session, "long");

    call({ cacheRetention: "none" });
    expect(inner).toHaveBeenCalledWith("model", "context", { cacheRetention: "none" });
  });

  it("inherit installs nothing", () => {
    const { session, inner } = fakeSession();
    installCacheRetention(session, "inherit");

    expect(session.agent.streamFunction).toBe(inner);
  });
});
