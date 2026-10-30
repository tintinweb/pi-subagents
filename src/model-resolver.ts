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

  // 3. Provider fallback: a "provider/modelId" query that didn't match under the
  // named provider (exact or fuzzy above) retries against all providers. The
  // named provider is preferred when present; this only kicks in when it isn't,
  // so the same model from another provider beats falling back to "inherit".
  if (slashIdx !== -1) {
    const bare = resolveModel(input.slice(slashIdx + 1), registry);
    if (typeof bare !== "string") return bare;
  }

  // 4. No match — list available models
  const modelList = all
    .map(m => `  ${m.provider}/${m.id}`)
    .sort()
    .join("\n");
  return `Model not found: "${input}".\n\nAvailable models:\n${modelList}`;
}

/** Claude Code's family ranking (`$hr`): the cap applies above Opus. */
const CLAUDE_FAMILY_RANK: Record<string, number> = { haiku: 0, sonnet: 1, opus: 2, fable: 3, mythos: 3 };
const CLAUDE_ID = /claude-([a-z]+)-(\d{1,2})(?!\d)(?:-(\d{1,2})(?!\d))?/;

interface PricedModel extends ModelEntry {
  cost?: { input?: number; output?: number };
}

const price = (m: PricedModel) => (m.cost?.input ?? 0) + (m.cost?.output ?? 0);

/** The newest Opus `models` offer, undated id preferred, as Claude Code's `"opus"` alias resolves. */
function newestOpus(models: PricedModel[]): PricedModel | undefined {
  let best: { model: PricedModel; rank: number } | undefined;
  for (const model of models) {
    const match = CLAUDE_ID.exec(model.id.toLowerCase());
    if (match?.[1] !== "opus") continue;
    const dated = /-\d{8}$/.test(model.id);
    const rank = Number(match[2]) * 10_000 + Number(match[3] ?? 0) * 10 + (dated ? 0 : 1);
    if (!best || rank > best.rank) best = { model, rank };
  }
  return best?.model;
}

/**
 * The model the built-in Explore should drop to instead of inheriting `parent`,
 * or undefined to inherit. Entries are tried in order, always on the parent's
 * own provider: `"auto"` is Claude Code's rule (a Claude family above Opus runs
 * on the newest Opus); any other entry names a cheap worker, used only when it
 * is cheaper than the parent. The first entry that yields a model decides.
 */
export function resolveExploreCap(
  parent: PricedModel | undefined,
  registry: ModelRegistry,
  entries: readonly string[],
): any | undefined {
  if (!parent) return undefined;
  const sameProvider = ((registry.getAvailable?.() ?? registry.getAll()) as PricedModel[])
    .filter(m => m.provider === parent.provider);
  for (const entry of entries) {
    if (entry === "auto") {
      const family = CLAUDE_ID.exec(parent.id.toLowerCase())?.[1];
      if (family === undefined || (CLAUDE_FAMILY_RANK[family] ?? -1) <= CLAUDE_FAMILY_RANK.opus) continue;
      const opus = newestOpus(sameProvider);
      if (opus) return registry.find(opus.provider, opus.id);
      continue;
    }
    // A provider-scoped view, so neither the fuzzy pass nor the provider
    // fallback in resolveModel can reach another provider's key.
    const found = resolveModel(entry, { ...registry, getAll: () => sameProvider, getAvailable: () => sameProvider });
    if (typeof found === "string") continue;
    return price(found) > 0 && price(found) < price(parent) ? found : undefined;
  }
  return undefined;
}
