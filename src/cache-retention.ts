import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { loadSettings } from "./settings.js";

export function installSubagentCacheRetention(session: AgentSession, cwd: string, agentDir?: string): void {
  const cacheRetention = loadSettings(cwd, agentDir).cacheRetention;
  if (cacheRetention === undefined || cacheRetention === "inherit") return;
  const streamFunction = session.agent.streamFunction;
  session.agent.streamFunction = (model, context, options) =>
    streamFunction(model, context, { ...options, cacheRetention: options?.cacheRetention ?? cacheRetention });
}
