import type { AgentRecord } from "./types.js";
import type { AgentActivity } from "./ui/agent-widget.js";

const REGISTRY = Symbol.for("pi-subagents:registry");

type Registry = {
  records: Map<string, AgentRecord>;
  activity: Map<string, AgentActivity>;
};

function registry(): Registry {
  const g = globalThis as any;
  const existing = g[REGISTRY] as Registry | undefined;
  if (existing) return existing;
  const created: Registry = {
    records: new Map(),
    activity: new Map(),
  };
  g[REGISTRY] = created;
  return created;
}

export function registerRecord(record: AgentRecord): void {
  registry().records.set(record.id, record);
}

export function unregisterRecord(id: string): void {
  const reg = registry();
  reg.records.delete(id);
  reg.activity.delete(id);
}

export function listGlobalRecords(): AgentRecord[] {
  return [...registry().records.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function setGlobalActivity(id: string, activity: AgentActivity): void {
  registry().activity.set(id, activity);
}

export function getGlobalActivity(id: string): AgentActivity | undefined {
  return registry().activity.get(id);
}

export function deleteGlobalActivity(id: string): void {
  registry().activity.delete(id);
}
