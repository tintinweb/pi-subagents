/**
 * model-scope.ts — the two model policies (`scopeModels`, `providerModels`),
 * shared by the top-level Agent tool, the nested delegation tools, the workflow
 * host, and the cross-extension RPC path, so no spawn path can escape a policy
 * another path enforces.
 *
 * State lives here (rather than an index.ts closure) for the same reason
 * `disableDefaults` lives in agent-types.ts: every entry point needs it.
 *
 * The policies are independent switches that compose as an AND — `scopeModels`
 * is an explicit allowlist read from pi's `enabledModels`, `providerModels` is a
 * structural constraint derived from the spawning session — and one function
 * evaluates both, so a call site keeps a single verdict to handle.
 */

import { isModelInScope, type ModelRegistryRef, readEnabledModels, resolveEnabledModels } from "./enabled-models.js";

/**
 * When enabled, subagent model choices are validated against `enabledModels`
 * from pi's settings — both global `<agentDir>/settings.json` and project-local
 * `<cwd>/.pi/settings.json` (project overrides global). Off by default; opt-in
 * via `/agents → Settings`. See the SubagentsSettings.scopeModels docstring for
 * the hard-error vs warn-and-proceed policy and its rationale.
 */
let scopeModelsEnabled = false;

export function isScopeModelsEnabled(): boolean { return scopeModelsEnabled; }
export function setScopeModelsEnabled(enabled: boolean): void { scopeModelsEnabled = enabled; }

/**
 * When enabled, a subagent's effective model must sit on the same provider as
 * the session spawning it. Off by default; opt-in via `/agents → Settings`.
 * See the SubagentsSettings.providerModels docstring for the rationale, and
 * checkModelProvider below for why an inherited model never draws a warning.
 */
let providerModelsEnabled = false;

export function isProviderModelsEnabled(): boolean { return providerModelsEnabled; }
export function setProviderModelsEnabled(enabled: boolean): void { providerModelsEnabled = enabled; }

export type ModelScopeVerdict =
  /** In policy, or nothing to validate against (feature off / no allowlist). */
  | { kind: "ok" }
  /** Caller-supplied out-of-policy choice — refuse the spawn with this message. */
  | { kind: "error"; message: string }
  /** Frontmatter-pinned or parent-inherited — proceed, but tell the user. */
  | { kind: "warn"; message: string };

/**
 * Provider half of the policy: the model must sit on the same provider as the
 * session that is spawning it.
 *
 * `sessionProvider` is the SPAWNING session's provider, not the root main
 * session's. The two are equivalent in effect, which is what lets this stay a
 * parameter instead of threaded state: a top-level spawn's parent IS the main
 * session, and every nested child was itself validated against its own parent,
 * so enforcing at each level keeps a whole tree on one provider.
 *
 * An inherited model is therefore trivially legal — it came from the spawner —
 * so this policy has no warn-on-inherit case, unlike the allowlist one. That is
 * the point of the split: a setting that fires a toast on the default behaviour
 * teaches users to ignore it.
 *
 * Returns `ok` when there is nothing to compare: feature off, no resolved
 * model, or no known session provider. Same stance an empty `enabledModels`
 * list takes — an unknown reference disables the check rather than refusing
 * every spawn.
 *
 * A resumed agent never reaches this function (it reuses an existing session),
 * so a session created before the setting was enabled keeps its own provider —
 * and its children, validated against it, keep it too.
 */
function checkModelProvider(args: {
  model: { provider: string; id: string } | undefined;
  sessionProvider: string | undefined;
  callerSupplied: boolean;
  agentLabel: string;
  modelInput?: string;
}): ModelScopeVerdict {
  const { model, sessionProvider, callerSupplied, agentLabel, modelInput } = args;
  if (!providerModelsEnabled || !model || !sessionProvider) return { kind: "ok" };
  // Case-insensitive, matching the key normalization in enabled-models.ts.
  if (model.provider.toLowerCase() === sessionProvider.toLowerCase()) return { kind: "ok" };

  const modelLabel = modelInput ?? `${model.provider}/${model.id}`;
  if (callerSupplied) {
    return {
      kind: "error",
      message:
        `Model not on this session's provider: "${modelLabel}". `
        + `This session runs on provider "${sessionProvider}".`,
    };
  }
  return {
    kind: "warn",
    message:
      `Agent "${agentLabel}" using out-of-provider model "${modelLabel}"`
      + ` (session provider: ${sessionProvider})`,
  };
}

/**
 * Check the effective resolved model against both model policies.
 *
 * scopeModels guards against *runtime* LLM choices, not user-level config:
 *   - Caller-supplied out-of-scope → hard error (the orchestrator made an explicit
 *     out-of-scope choice; surface it so it picks differently).
 *   - Frontmatter-pinned or parent-inherited out-of-scope → warn but proceed (the
 *     user authored/installed this agent or chose the parent's model; trust it).
 *
 * providerModels applies the same split to a different reference — the spawning
 * session's provider instead of an allowlist.
 */
export function checkModelScope(args: {
  model: { provider: string; id: string } | undefined;
  cwd: string;
  modelRegistry: ModelRegistryRef;
  /** True when the model came from the tool call rather than frontmatter. */
  callerSupplied: boolean;
  /** Display name used in the warning toast. */
  agentLabel: string;
  /** The raw `model:` input, when there was one. */
  modelInput?: string;
  /** The spawning session's provider — see checkModelProvider. */
  sessionProvider?: string;
}): ModelScopeVerdict {
  const { model, cwd, modelRegistry, callerSupplied, agentLabel, modelInput, sessionProvider } = args;

  // Provider policy first: it compares two strings, while the allowlist policy
  // stats and parses two settings.json files. A refusal on this path then costs
  // no disk I/O.
  const providerVerdict = checkModelProvider({
    model,
    sessionProvider,
    callerSupplied,
    agentLabel,
    modelInput,
  });
  // Short-circuit: a provider refusal is the more specific complaint, and it
  // needs no allowlist to justify itself.
  if (providerVerdict.kind === "error") return providerVerdict;
  if (!scopeModelsEnabled || !model) return providerVerdict;

  const allowed = resolveEnabledModels(readEnabledModels(cwd), modelRegistry, cwd);
  if (!allowed || isModelInScope(model, allowed)) return providerVerdict;

  if (callerSupplied) {
    const list = [...allowed].sort().map(m => `  ${m}`).join("\n");
    return {
      kind: "error",
      message: `Model not in scope: "${modelInput}".\n\nAllowed models (from enabledModels):\n${list}`,
    };
  }
  const modelLabel = modelInput ?? `${model.provider}/${model.id}`;
  const outOfScopeMessage = `Agent "${agentLabel}" using out-of-scope model "${modelLabel}"`;
  // Both policies can warn about the same spawn (a frontmatter pin that is
  // neither the session's provider nor on the allowlist). Join rather than pick,
  // so one toast doesn't hide half the problem — the workflow host dedups
  // warnings by message string, which a stable join keeps working.
  return providerVerdict.kind === "warn"
    ? { kind: "warn", message: `${providerVerdict.message}\n${outOfScopeMessage}` }
    : { kind: "warn", message: outOfScopeMessage };
}
