/**
 * Model resolution: exact match ("provider/modelId") with fuzzy fallback.
 */

export interface ModelEntry {
  id: string;
  name: string;
  provider: string;
}

export interface ModelRegistry {
  find(provider: string, modelId: string): any;
  getAll(): any[];
  getAvailable?(): any[];
}

/**
 * Both display forms of a model. The short one goes on tight rows (the widget,
 * the Agent tool result), the canonical one where there is room to disambiguate
 * two providers serving a similarly-named model (the conversation viewer).
 *
 * One function, because `index.ts` labels the model it resolved before the run
 * and `agent-manager.ts` relabels it from the live session afterwards — the two
 * must agree or the label would visibly change the moment the session starts.
 */
export function describeModel(
  model: { provider: string; id: string; name?: string },
): { modelName: string; modelId: string } {
  return {
    modelName: (model.name ?? model.id).replace(/^Claude\s+/i, "").toLowerCase(),
    modelId: `${model.provider}/${model.id}`,
  };
}

/**
 * True when two model ids name the same model: case-insensitive, `.`/`-`
 * interchangeable, a trailing `-YYYYMMDD` date stamp ignored, and a vendor
 * namespace tolerated on either side. Gateway catalogs carry the vendor inside
 * the id (OpenRouter serves Claude as "anthropic/claude-sonnet-4"), so one model
 * can reach this check as "claude-sonnet-4" on one side and
 * "anthropic/claude-sonnet-4" on the other. A version suffix is not a namespace:
 * "glm-5.3" and "glm-5.3-flash" stay distinct, and so do `:cloud`-style tags.
 *
 * Narrower than the fuzzy tiers on purpose — those also match on display name
 * and on their all-parts rule. This answers only "is this the same model?", never
 * "is this a close enough name?".
 *
 * One function, because both the provider-fallback acceptance check and the
 * not-found reason must agree on what "the same model" means, or the reason
 * would name a substitution the check had just accepted.
 */
function sameModelId(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\./g, "-").replace(/-\d{8}$/, "");
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  // Last path segment, so a vendor-qualified catalog id matches the bare id the
  // same model carries on its own provider.
  return na.slice(na.lastIndexOf("/") + 1) === nb.slice(nb.lastIndexOf("/") + 1);
}

/**
 * Resolve a model string to a Model instance.
 * Tries exact match first ("provider/modelId"), then fuzzy match against all available models.
 * Returns the Model on success, or an error message string on failure.
 */
export function resolveModel(
  input: string,
  registry: ModelRegistry,
): any | string {
  // Available models (those with auth configured)
  const all = (registry.getAvailable?.() ?? registry.getAll()) as ModelEntry[];
  const availableSet = new Set(all.map(m => `${m.provider}/${m.id}`.toLowerCase()));

  // 1. Exact match: "provider/modelId" — only if available (has auth)
  const slashIdx = input.indexOf("/");
  if (slashIdx !== -1) {
    const provider = input.slice(0, slashIdx);
    const modelId = input.slice(slashIdx + 1);
    if (availableSet.has(input.toLowerCase())) {
      const found = registry.find(provider, modelId);
      if (found) return found;
    }
  }

  // 2. Fuzzy match against available models. Normalize separators so cosmetic
  // punctuation differences still match — e.g. "claude-haiku-4.5" and
  // "claude-haiku-4-5" (dot vs dash in the version) resolve to the same model.
  const normalize = (s: string) => s.toLowerCase().replace(/\./g, "-");
  const query = normalize(input);

  // Score each model: prefer exact id match > id contains > name contains > provider+id contains
  let bestMatch: ModelEntry | undefined;
  let bestScore = 0;

  for (const m of all) {
    const id = normalize(m.id);
    const name = normalize(m.name);
    const full = normalize(`${m.provider}/${m.id}`);

    let score = 0;
    if (id === query || full === query) {
      score = 100; // exact
    } else if (id.includes(query) || full.includes(query)) {
      score = 60 + (query.length / id.length) * 30; // substring, prefer tighter matches
    } else if (name.includes(query)) {
      score = 40 + (query.length / name.length) * 20;
    } else if (
      // A trailing date-stamp token (e.g. "20251001") is optional, so a
      // date-pinned config like "claude-haiku-4-5-20251001" still matches an
      // undated registry id like "claude-haiku-4-5".
      query
        .split(/[\s\-/]+/)
        .every(part => /^\d{8}$/.test(part) || id.includes(part) || name.includes(part) || m.provider.toLowerCase().includes(part))
    ) {
      score = 20; // all parts present somewhere
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = m;
    }
  }

  if (bestMatch && bestScore >= 20) {
    const found = registry.find(bestMatch.provider, bestMatch.id);
    if (found) return found;
  }

  // Registered-model reads, both tolerant of a registry that implements only
  // `find` and `getAvailable`. `namedProviderCarries` answers the qualified
  // question — does the provider the pin names carry this id, auth or not — via
  // `find`, which reads the full catalog rather than the availability snapshot.
  // `namesRegisteredId` answers the unqualified one — is this bare part an exact
  // model id anywhere, or a fuzzy name like "haiku" — and that needs the catalog
  // itself, so a registry without `getAll` keeps the qualified answer and
  // degrades to the previous behavior instead of throwing at the caller.
  const catalog = (typeof registry.getAll === "function" ? registry.getAll() : []) as ModelEntry[];
  const namedProvider = slashIdx === -1 ? "" : input.slice(0, slashIdx);
  const namedId = slashIdx === -1 ? "" : input.slice(slashIdx + 1);
  const namedProviderCarries = (provider: string, id: string): boolean =>
    catalog.some(m => m.provider.toLowerCase() === provider.toLowerCase() && sameModelId(id, m.id)) ||
    (typeof registry.find === "function" && registry.find(provider, id) !== undefined);
  const namesRegisteredId = (id: string): boolean =>
    catalog.some(m => sameModelId(id, m.id)) || namedProviderCarries(namedProvider, id);

  // 3. Provider fallback: a "provider/modelId" query that didn't match under the
  // named provider (exact or fuzzy above) retries against all providers. The
  // named provider is preferred when present; this only kicks in when it isn't,
  // so the same model from another provider beats falling back to "inherit" —
  // but only the *same* model. A bare part that names a registered model id must
  // never resolve to a different one: "pinned/glm-5.3" with that provider out of
  // auth used to land on "other/glm-5.3-flash" and report it as a success, which
  // reads as a run on the pinned model rather than a failed one. A bare part that
  // is not itself a registered id ("haiku") is a fuzzy name, and keeps the loose
  // cross-provider lookup the fuzzy tier promises.
  let refused: { provider: string; id: string } | undefined; // different model the retry found and this check rejected
  if (slashIdx !== -1) {
    const bare = resolveModel(namedId, registry);
    if (typeof bare !== "string") {
      if (sameModelId(namedId, bare.id) || !namesRegisteredId(namedId)) return bare;
      refused = { provider: bare.provider, id: bare.id };
    }
  }

  // 4. No match — say why, then list available models. A pin the registry knows
  // but this session cannot run, and a model no registry has, were otherwise the
  // same message. The check is a catalog read, so it cannot tell missing auth
  // apart from auth configured after the session's availability snapshot was
  // taken, and the reason names both. The prefix is load-bearing: RPC consumers
  // match on 'Model not found: "<input>".' (docs/rpc.md), so the reason is
  // appended and never restructured.
  const reasons: string[] = [];
  if (slashIdx !== -1 && namedProviderCarries(namedProvider, namedId)) {
    reasons.push(
      `"${input}" is registered but not available: no provider with auth configured serves it, or auth was configured after this session started.`,
    );
  }
  if (refused) {
    reasons.push(`A different model, "${refused.provider}/${refused.id}", is available and is not a substitute.`);
  }
  const reason = reasons.length ? `\n\n${reasons.join(" ")}` : "";
  const modelList = all
    .map(m => `  ${m.provider}/${m.id}`)
    .sort()
    .join("\n");
  return `Model not found: "${input}".${reason}\n\nAvailable models:\n${modelList}`;
}
