import { describe, expect, it } from "vitest";
import { describeModel, type ModelRegistry, resolveModel } from "../src/model-resolver.js";

// Mock model entries matching typical pi model registry shape
const MODELS = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "gpt-4o", name: "GPT-4o", provider: "openai" },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
];

function makeRegistry(models = MODELS, available?: typeof MODELS): ModelRegistry {
  return {
    find(provider: string, modelId: string) {
      return models.find(m => m.provider === provider && m.id === modelId);
    },
    getAll() {
      return models;
    },
    getAvailable: available ? () => available : undefined,
  };
}

describe("resolveModel", () => {
  describe("exact match (provider/modelId)", () => {
    it("resolves exact provider/modelId", () => {
      const result = resolveModel("anthropic/claude-opus-4-6", makeRegistry());
      expect(result).toEqual(MODELS[0]);
    });

    it("resolves another exact provider/modelId", () => {
      const result = resolveModel("openai/gpt-4o", makeRegistry());
      expect(result).toEqual(MODELS[3]);
    });

    it("falls through to fuzzy when exact provider/modelId not found", () => {
      // "anthropic/haiku" is not an exact match, but fuzzy should find it
      const result = resolveModel("anthropic/haiku", makeRegistry());
      expect(result).toEqual(MODELS[2]); // haiku
    });
  });

  describe("fuzzy match — exact id", () => {
    it("matches exact model id without provider", () => {
      const result = resolveModel("claude-opus-4-6", makeRegistry());
      expect(result).toEqual(MODELS[0]);
    });

    it("is case-insensitive", () => {
      const result = resolveModel("Claude-Opus-4-6", makeRegistry());
      expect(result).toEqual(MODELS[0]);
    });

    it("matches exact id for non-anthropic models", () => {
      const result = resolveModel("gpt-4o", makeRegistry());
      expect(result).toEqual(MODELS[3]);
    });
  });

  describe("fuzzy match — substring", () => {
    it("matches 'haiku' to claude-haiku model", () => {
      const result = resolveModel("haiku", makeRegistry());
      expect(result).toEqual(MODELS[2]);
    });

    it("matches 'sonnet' to claude-sonnet model", () => {
      const result = resolveModel("sonnet", makeRegistry());
      expect(result).toEqual(MODELS[1]);
    });

    it("matches 'opus' to claude-opus model", () => {
      const result = resolveModel("opus", makeRegistry());
      expect(result).toEqual(MODELS[0]);
    });

    it("matches 'gemini' to gemini model", () => {
      const result = resolveModel("gemini", makeRegistry());
      expect(result).toEqual(MODELS[4]);
    });

    it("is case-insensitive for substring", () => {
      const result = resolveModel("HAIKU", makeRegistry());
      expect(result).toEqual(MODELS[2]);
    });
  });

  describe("fuzzy match — separator equivalence (dash vs dot)", () => {
    // id uses dashes and the name carries no version number — the case that
    // failed before separators were normalized (the "4.5" token couldn't be
    // found anywhere, so the dotted query matched nothing).
    const HAIKU = { id: "claude-haiku-4-5", name: "Claude Haiku", provider: "anthropic" };
    const dashReg = makeRegistry([HAIKU]);

    it("matches a dotted query to a dashed id", () => {
      expect(resolveModel("claude-haiku-4.5", dashReg)).toEqual(HAIKU);
    });

    it("matches a dotted provider/id query to a dashed id", () => {
      expect(resolveModel("anthropic/claude-haiku-4.5", dashReg)).toEqual(HAIKU);
    });

    it("matches a dashed query to a dotted id", () => {
      expect(resolveModel("gemini-2-5-pro", makeRegistry())).toEqual(MODELS[4]);
    });
  });

  describe("fuzzy match — trailing date-stamp is optional", () => {
    // A date-pinned config (e.g. an agent's frontmatter, or a shipped default)
    // should still resolve when the registry lists the model without the stamp.
    const HAIKU_DASH = { id: "claude-haiku-4-5", name: "Claude Haiku", provider: "anthropic" };
    const HAIKU_DOT = { id: "claude-haiku-4.5", name: "Claude Haiku", provider: "anthropic" };

    it("matches a dated provider/id config to an undated registry id", () => {
      expect(resolveModel("anthropic/claude-haiku-4-5-20251001", makeRegistry([HAIKU_DASH]))).toEqual(HAIKU_DASH);
    });

    it("matches a dated config to an undated *dotted* registry id (date + separator)", () => {
      expect(resolveModel("anthropic/claude-haiku-4-5-20251001", makeRegistry([HAIKU_DOT]))).toEqual(HAIKU_DOT);
    });

    it("still prefers an exact dated id when the registry has it", () => {
      const dated = { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic" };
      expect(resolveModel("anthropic/claude-haiku-4-5-20251001", makeRegistry([dated]))).toEqual(dated);
    });
  });

  describe("provider fallback (prefer named provider, else any)", () => {
    const gatewayHaiku = { id: "claude-haiku-4-5", name: "Claude Haiku", provider: "openrouter" };
    const anthropicHaiku = { id: "claude-haiku-4-5", name: "Claude Haiku", provider: "anthropic" };

    it("falls back to another provider when the named one lacks the model", () => {
      expect(resolveModel("anthropic/claude-haiku-4-5", makeRegistry([gatewayHaiku]))).toEqual(gatewayHaiku);
    });

    it("prefers the named provider when it has the model", () => {
      expect(resolveModel("anthropic/claude-haiku-4-5", makeRegistry([gatewayHaiku, anthropicHaiku]))).toEqual(anthropicHaiku);
    });

    it("still errors when no provider has the model", () => {
      expect(typeof resolveModel("anthropic/nonexistent-xyz", makeRegistry([gatewayHaiku]))).toBe("string");
    });
  });

  describe("fuzzy match — name contains", () => {
    it("matches 'Opus 4.6' via model name", () => {
      const result = resolveModel("Opus 4.6", makeRegistry());
      expect(result).toEqual(MODELS[0]);
    });

    it("matches 'Haiku 4.5' via model name", () => {
      const result = resolveModel("Haiku 4.5", makeRegistry());
      expect(result).toEqual(MODELS[2]);
    });
  });

  describe("fuzzy match — multi-part", () => {
    it("matches 'anthropic opus' across provider and id", () => {
      const result = resolveModel("anthropic opus", makeRegistry());
      expect(result).toEqual(MODELS[0]);
    });

    it("matches 'google pro' across provider and id", () => {
      const result = resolveModel("google pro", makeRegistry());
      expect(result).toEqual(MODELS[4]);
    });
  });

  describe("fuzzy match — prefers tighter matches", () => {
    it("prefers exact id over substring", () => {
      const result = resolveModel("gpt-4o", makeRegistry());
      expect(result).toEqual(MODELS[3]);
    });

    it("substring match prefers shorter model id (tighter fit)", () => {
      // Both opus and sonnet contain their query as substring, but "opus" is a tighter match
      // for "opus" than "sonnet" is for "sonnet" — each should resolve to itself
      expect(resolveModel("opus", makeRegistry())).toEqual(MODELS[0]);
      expect(resolveModel("sonnet", makeRegistry())).toEqual(MODELS[1]);
    });
  });

  describe("no match", () => {
    it("returns error string for unknown model", () => {
      const result = resolveModel("nonexistent-model", makeRegistry());
      expect(typeof result).toBe("string");
      expect(result).toContain('Model not found: "nonexistent-model"');
      expect(result).toContain("Available models:");
    });

    it("error lists available models", () => {
      const result = resolveModel("xyz", makeRegistry());
      expect(result).toContain("anthropic/claude-opus-4-6");
      expect(result).toContain("openai/gpt-4o");
    });

    it("empty string matches a model (multi-part vacuous truth)", () => {
      // Empty string splits to empty parts; every() on empty array is true
      // This is fine — callers guard against empty input
      const result = resolveModel("", makeRegistry());
      expect(typeof result).toBe("object");
    });
  });

  describe("getAvailable filtering", () => {
    it("uses getAvailable when present (filters to configured models)", () => {
      const available = [MODELS[0], MODELS[2]]; // only opus and haiku
      const result = resolveModel("sonnet", makeRegistry(MODELS, available));
      // sonnet is in getAll but not in getAvailable — should not fuzzy match
      expect(typeof result).toBe("string");
      expect(result).toContain("Model not found");
    });

    it("exact match fails when model is not in getAvailable (no auth)", () => {
      const available = [MODELS[0]]; // only opus available
      const result = resolveModel("anthropic/claude-sonnet-4-6", makeRegistry(MODELS, available));
      expect(typeof result).toBe("string");
      expect(result).toContain("Model not found");
    });

    it("fuzzy matches against available models only", () => {
      const available = [MODELS[2]]; // only haiku available
      const result = resolveModel("haiku", makeRegistry(MODELS, available));
      expect(result).toEqual(MODELS[2]);
    });
  });

  describe("ambiguous matches", () => {
    const SIMILAR_MODELS = [
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
      { id: "claude-sonnet-4-5-20241022", name: "Claude Sonnet 4.5", provider: "anthropic" },
      { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic" },
    ];

    it("'sonnet' prefers tighter id match (shorter id)", () => {
      const result = resolveModel("sonnet", makeRegistry(SIMILAR_MODELS));
      // "sonnet" is a larger fraction of "claude-sonnet-4-6" than "claude-sonnet-4-5-20241022"
      expect(result).toEqual(SIMILAR_MODELS[0]);
    });

    it("'sonnet 4.5' resolves to the 4.5 model via name", () => {
      const result = resolveModel("sonnet 4.5", makeRegistry(SIMILAR_MODELS));
      expect(result).toEqual(SIMILAR_MODELS[1]);
    });

    it("'4-6' picks the 4.6 model", () => {
      const result = resolveModel("4-6", makeRegistry(SIMILAR_MODELS));
      expect(result).toEqual(SIMILAR_MODELS[0]);
    });
  });

  describe("empty registry", () => {
    it("returns error with empty available list", () => {
      const result = resolveModel("haiku", makeRegistry([]));
      expect(typeof result).toBe("string");
      expect(result).toContain("Model not found");
    });
  });
});

describe("describeModel", () => {
  it("gives a short label and a canonical id", () => {
    expect(describeModel({ provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }))
      .toEqual({ modelName: "sonnet 4.6", modelId: "anthropic/claude-sonnet-4-6" });
  });

  it("falls back to the id when the model has no display name", () => {
    expect(describeModel({ provider: "openai-codex", id: "gpt-5.6-sol" }))
      .toEqual({ modelName: "gpt-5.6-sol", modelId: "openai-codex/gpt-5.6-sol" });
  });
});
