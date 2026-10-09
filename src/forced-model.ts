/**
 * Machine/project policy that forces every fresh subagent spawn onto one model.
 *
 * Kept outside model-scope.ts because this is coercion, not validation against
 * an allowlist. AgentManager reads it at the universal spawn funnel; index.ts
 * owns settings/display wiring.
 */
let forcedSubagentModel: string | undefined;

export function getForcedSubagentModel(): string | undefined { return forcedSubagentModel; }

export function setForcedSubagentModel(model: string | undefined): void {
  const trimmed = model?.trim();
  forcedSubagentModel = trimmed || undefined;
}
