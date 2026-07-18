# Target pi-subagents Agent Tool Schema

Forward-looking target for reducing the Pi `Agent` / `get_subagent_result` / `steer_subagent` tool-schema token overhead. This is a design document, not an implementation plan. It describes what a compact schema could look like and how to validate savings — it does not prescribe immediate code changes.

---

## 1. Objective and Non-Goals

**Objective:** Reduce the serialized tool-schema token count contributed by pi-subagents to Pi's global system prompt by at least 40–60 %, without removing load-bearing parameter semantics or sacrificing correctness.

**Non-goals:**
- Do not change Agent tool behavior or the chain execution engine.
- Do not remove parameters or features (scheduling, chain orchestration, recovery).
- Do not claim specific savings until a serializer/token benchmark proves them against the current schema.
- Do not claim that TypeBox `$ref` or object reuse automatically reduces the downstream serialized JSON Schema — the cut happens at the serialization layer, not at the TypeBox type-graph layer.

---

## 2. Current Schema Inventory

This section is grounded in `src/index.ts` (the tool-registration site), `src/agent-types.ts`, `src/types.ts`, and `src/chain-io.ts`.

### 2.1 Registered tools

| Tool                  | Location (in `src/index.ts`)                | Shape                                                   |
| --------------------- | ------------------------------------------- | ------------------------------------------------------- |
| `Agent`               | `pi.registerTool(defineTool({…}))`          | Single call; schema is the dominant contributor.        |
| `get_subagent_result` | `pi.registerTool(defineTool({…}))`          | 3 params (agent_id, wait, verbose). Small.              |
| `steer_subagent`      | `pi.registerTool(defineTool({…}))`          | 2 params (agent_id, message). Small.                    |
| `write_output`        | Per-chain-step injection (`chain-io.ts`)    | 2 params (content, append). Injected only during chains. |

The `Agent` tool dominates. Its raw TypeBox schema includes:

### 2.2 Agent tool parameter tree

```
Agent
├── prompt (String)
├── description (String)
├── subagent_type (String, description includes live type list)
├── model (Optional String)
├── thinking (Optional String)
├── max_turns (Optional Number)
├── run_in_background (Optional Boolean)
├── resume (Optional String)
├── chain (Optional Array of chainElementUnion, minItems: 2)
│   ├── [sequential step]
│   │   ├── subagent_type (String)
│   │   ├── prompt (String)
│   │   ├── description (Optional String)
│   │   ├── model (Optional String)
│   │   ├── thinking (Optional String)
│   │   ├── max_turns (Optional Number)
│   │   ├── output (Optional String)
│   │   ├── output_mode (Optional "inline" | "file-only")
│   │   ├── reads (Optional Array of String)
│   │   ├── isolated (Optional Boolean)
│   │   ├── inherit_context (Optional Boolean)
│   │   ├── isolation (Optional "worktree")
│   │   ├── files (Optional Array of String)
│   │   └── pause_after (Optional Boolean)   ← sequential-step only
│   └── [parallel stage]
│       ├── parallel (Array, minItems: 1)
│       │   └── [member] — repeats subagent_type, prompt, description,
│       │       model, thinking, max_turns, output, output_mode, reads,
│       │       isolated, inherit_context, isolation, files
│       │       (NO pause_after — see §4.2)
│       ├── continue_on_error (Optional Boolean)
│       ├── description (Optional String)
│       ├── output (Optional String)
│       └── output_mode (Optional "inline" | "file-only")
├── chain_run_id (Optional String)
├── remaining (Optional Array of chainElementUnion, minItems: 1)
│   └── (same union shape as chain)
├── isolated (Optional Boolean)
├── inherit_context (Optional Boolean)
├── isolation (Optional Literal "worktree")
└── schedule (Optional String, gated by schedulingEnabled)
```

### 2.3 Observed redundancy sources

1. **Sequential step and parallel member share 13 identical fields** (subagent_type through files) but are declared as separate TypeBox objects. The TypeBox type-graph duplicates them; the serialized JSON Schema may or may not duplicate them depending on the serializer — this is the benchmark question.

2. **`remaining` re-uses `chainElementUnion`** directly (a single TypeBox reference), but the JSON Schema serialization may inline the full union a second time. Again, serializer-dependent.

3. **Dynamic description strings** are evaluated once at tool-registration time and baked into the schema as plain strings (see `agentToolDescription`, `fullAgentToolDescription`). They grow with every custom agent type registered — each adds a `- name: description` line.

4. **Field-level descriptions are verbose.** Many `description` strings in the TypeBox schema are multi-sentence prose targeting the LLM's comprehension, not token economy. Example: the `pause_after` description alone is ~350 characters.

5. **`schedule` param shape** is conditionally included via spread but does not meaningfully reduce schema size — it just omits one optional string field.

### 2.4 Live-size contributors

The description string (not the parameter schema) varies by mode:

| Mode            | Description size driver                                         |
| --------------- | --------------------------------------------------------------- |
| `full`          | Type list (all enabled agents) + routing guidelines + prose     |
| `compact`       | Compact type list (one line per agent) + prose (repository claims ~75 % smaller — unverified, requires §7 benchmark) |
| `custom`        | User-authored template with `{{typeList}}` / `{{guidelines}}`   |

The `compact` mode already exists; the repository claims it is the single biggest reduction for description strings — unverified, requires §7 benchmark — but it only affects the description prose, not the parameter schema tree.

---

## 3. Token-Pressure Hypotheses

These are hypotheses. Every one requires a benchmark (§7) before calling it a saving.

### H1: Serialized schema duplicates the parallel member block inline

If the JSON Schema serializer inlines the parallel member type definition rather than referencing a shared definition, changing the TypeBox source to use a shared definition object could save tokens — **if and only if** the serializer picks it up. The current source declares a separate `Type.Object` for sequential steps and another inside the `parallel` array; these two objects are independent in TypeBox's type-graph even if they have identical shapes.

**Test:** Serialize the current schema. Serialize a variant where both use a single shared definition. Compare token counts.

### H2: `remaining` re-use of `chainElementUnion` may be inlined

Although TypeBox re-uses the same union type object, the JSON Schema serializer may emit it twice (once under `chain`, once under `remaining`). If so, a post-processing deduplication pass on the serialized schema could help.

**Test:** Compare token count of serialized schema with one vs two references to `chainElementUnion`.

### H3: Description strings dominate, not parameter structure

The `agentToolDescription` alone is ~4000+ characters in `full` mode with 6 default agents. The parameter schema tree adds more, but descriptions might be the larger fraction.

**Test:** Measure tokens of (description-only) vs (parameter-schema-only) vs (both).

### H4: `compact` mode + shared field definitions is the sweet spot

Combining the existing `toolDescriptionMode: "compact"` with schema-level deduplication (if H1/H2 prove real) could cut Agent tool tokens by 40–60 % relative to current `full` mode.

---

## 4. Target Compact-Schema Principles

### 4.1 Shared step-member base

Extract the 13 shared fields (subagent_type through files) into a single TypeBox object that both the sequential step and the parallel member reference:

```
// Conceptual — not an implementation prescription.
const sharedStepFields = Type.Object({
  subagent_type: Type.String({ description: "…" }),
  prompt: Type.String({ description: "…" }),
  // … 11 more fields …
});

const sequentialStep = Type.Composite([
  sharedStepFields,
  Type.Object({
    pause_after: Type.Optional(Type.Boolean({ … })),
  }),
]);

const parallelMember = sharedStepFields; // No pause_after

const parallelStage = Type.Object({
  parallel: Type.Array(parallelMember, { minItems: 1 }),
  continue_on_error: Type.Optional(Type.Boolean({ … })),
  description: Type.Optional(Type.String({ … })),
  output: Type.Optional(Type.String({ … })),
  output_mode: Type.Optional(…),
});
```

**Caveat:** TypeBox `Type.Composite` merges schemas; whether the serializer emits a single `properties` block or two depends on the serialization layer. This is precisely the benchmark question.

### 4.2 Explicit sequential vs parallel distinction

The current schema correctly places `pause_after` only on sequential steps, not on parallel members (verified against `src/index.ts` lines ~850–900, the `chainElementUnion` definition). Any compact schema must preserve this distinction.

Sequential step = shared fields + `pause_after`.  
Parallel member = shared fields only.  
Parallel stage = array of parallel member + `continue_on_error` + stage-level `description`/`output`/`output_mode`.

### 4.3 Avoid `$ref`-only claims

JSON Schema `$ref` is a structural tool, not a token-saving tool. Some serializers emit `$ref` pointing to a definitions section; others inline everything. A TypeBox `$ref()` call does not guarantee the downstream JSON Schema uses `$ref`. The only reliable optimization is:

1. Restructure the TypeBox source so duplication is minimized.
2. Serialize to JSON Schema.
3. Apply a post-processing pass that replaces identical inlined sub-schemas with `$defs` + `$ref`.
4. Benchmark the token count of the post-processed schema.

### 4.4 Description brevity

Field-level descriptions should be one sentence, not paragraphs. The prose that teaches the LLM how to use the tool belongs in the tool-level `description` string (which is already mode-switchable via `full`/`compact`/`custom`), not repeated on every parameter.

Before:
> `"If true, the chain stops after this step instead of continuing. Returns the step output plus a chain_run_id. If the step's output contains a fenced ... (300+ chars)"`

After:
> `"If true, pause the chain after this step. Resume later with chain_run_id + remaining."`

### 4.5 Keep the compact mode

The existing `toolDescriptionMode: "compact"` already exists in `settings.ts` and `index.ts`. It is an existing mechanism whose token savings are unverified — requires §7 benchmark. The schema target should keep it and ensure the parameter tree is also compact when this mode is active — not just the description prose.

---

## 5. Proposed API Shapes

These shapes describe the *logical* structure, not the TypeBox source. They are the target for the serialized schema, not the TypeBox type-graph.

### 5.1 Agent (top-level)

```
Agent {
  prompt: string           // required
  description: string      // required
  subagent_type: string    // required, live type list in description
  model?: string
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
  max_turns?: number (≥1)
  run_in_background?: boolean
  resume?: string           // agent ID
  chain?: ChainElement[]    // min 2 items
  chain_run_id?: string
  remaining?: ChainElement[] // min 1 item
  isolated?: boolean
  inherit_context?: boolean
  isolation?: "worktree"
  schedule?: string         // gated on schedulingEnabled
}
```

### 5.2 ChainElement (union)

```
ChainElement =
  | SequentialStep    // includes pause_after
  | ParallelStage     // includes continue_on_error + parallel[]
```

### 5.3 SequentialStep

```
SequentialStep {
  // --- shared step-member fields ---
  subagent_type: string
  prompt: string
  description?: string
  model?: string
  thinking?: string
  max_turns?: number (≥1)
  output?: string
  output_mode?: "inline" | "file-only"
  reads?: string[]
  isolated?: boolean
  inherit_context?: boolean
  isolation?: "worktree"
  files?: string[]
  // --- sequential-only ---
  pause_after?: boolean
}
```

### 5.4 ParallelStage

```
ParallelStage {
  parallel: ParallelMember[]   // min 1 item
  continue_on_error?: boolean
  description?: string
  output?: string
  output_mode?: "inline" | "file-only"
}
```

### 5.5 ParallelMember

```
ParallelMember {
  // --- shared step-member fields (same as SequentialStep, minus pause_after) ---
  subagent_type: string
  prompt: string
  description?: string
  model?: string
  thinking?: string
  max_turns?: number (≥1)
  output?: string
  output_mode?: "inline" | "file-only"
  reads?: string[]
  isolated?: boolean
  inherit_context?: boolean
  isolation?: "worktree"
  files?: string[]
}
```

### 5.6 get_subagent_result and steer_subagent

These are small and not worth refactoring beyond description brevity.

---

## 6. Migration and Compatibility

### 6.1 No behavioral change

The chain execution engine (`executeChain` in `src/index.ts`, chain IO in `src/chain-io.ts`) reads the parsed argument object, not the TypeBox schema. Changing the schema definition does not change runtime behavior as long as the parameter names, types, and optionality remain identical.

### 6.2 Existing chain calls continue to work

Any chain call that works today will produce the same parsed argument object after schema compaction, because the field names and shapes are unchanged. The only difference is the TypeBox source structure and the serialized description strings.

### 6.3 LLM comprehension risk

Shorter field descriptions could degrade LLM comprehension of edge-case parameters (especially `pause_after`, `chain_run_id`, `remaining`, and the `reads`/`output_mode` handoff pattern). Mitigation:
- Keep the tool-level `description` string as the teaching surface — it already carries the prose guidance.
- Field descriptions should be terse identifiers with one-sentence clarifications.
- The compact mode exists as a repository feature; whether shorter descriptions work for all models, including larger ones, is a hypothesis pending §7 benchmark.

### 6.4 Custom tool description mode

The `custom` mode (`toolDescriptionMode: "custom"`, reading from `agent-tool-description.md`) must continue to work. It uses `{{typeList}}`, `{{guidelines}}`, and other placeholders. These placeholders are independent of the parameter schema and must keep rendering correctly.

---

## 7. Serializer Benchmark / Validation Plan

Every savings claim MUST be validated against actual token counts. The benchmark plan:

### 7.1 Baseline

1. Serialize the current `Agent` tool definition to JSON Schema using the same serializer Pi uses at tool-registration time.
2. Count tokens on the serialized JSON string using the same tokenizer as the target model (e.g., `claude-opus-4-6`'s tokenizer).
3. Record separately: description string tokens, parameter schema tokens, total.

### 7.2 Variants to test

| Variant                              | What changes                                                 |
| ------------------------------------ | ------------------------------------------------------------ |
| A (baseline)                         | Current schema, `full` mode                                  |
| B                                    | Current schema, `compact` mode (already available)           |
| C                                    | Shared step-member TypeBox definition (H1)                   |
| D                                    | Post-process `$defs` + `$ref` on serialized schema (H2)      |
| E                                    | Shortened field descriptions                                 |
| F (target)                           | B + C + D + E combined                                       |

### 7.3 Measurement

For each variant:
1. Generate the serialized JSON Schema.
2. Run through the target model's tokenizer (use `claude-opus-4-6`'s `claude_tokenizer` or equivalent).
3. Report: total tokens, description-only tokens, schema-only tokens.
4. Compare against baseline A.

### 7.4 Success criteria

- Variant F (target) is at least 40 % smaller than baseline A in total tool-schema tokens.
- No parameter semantics are lost (field names, types, optionality, min/max constraints unchanged).
- The chain execution engine passes all existing `test/chain-io.test.ts` tests without modification.

---

## 8. Open Decisions

1. **TypeBox restructuring approach:** Should the shared step-member fields be extracted as a `Type.Object` and referenced via `Type.Composite`, or should we define a helper function that returns the object and call it twice? The benchmark will tell us which approach the serializer handles better.

2. **Post-processing layer:** If the TypeBox serializer does not emit `$defs`/`$ref`, should we add a post-processing pass that finds identical sub-schemas and deduplicates them? This is an additional build step with its own maintenance cost. Only worth it if H1 and H2 prove significant.

3. **Description brevity vs LLM usability:** How short can field descriptions be before the model starts misusing parameters like `pause_after` or `reads`? We do not have empirical data. The safe path: ship the compact schema behind a setting (`toolDescriptionMode` or a new `schemaMode`), let users opt in, and collect feedback.

4. **`remaining` schema sharing:** Currently `remaining` re-uses `chainElementUnion` as a TypeBox reference. If the serializer inlines it, do we accept the cost or add a post-processing pass? The cost is modest (one extra copy of the union) and the runtime correctness benefit of a single source of truth may outweigh it.

5. **`compact` mode default:** Should `compact` become the default for `toolDescriptionMode`? The repository claims it is ~75 % smaller — unverified, requires §7 benchmark. The only hesitation is whether the shorter prose degrades chain orchestration quality. Worth an A/B test.

---

## 9. Sources Checked

- `src/index.ts` (lines 1–1166, all tool registrations and `chainElementUnion`)
- `src/chain-io.ts` (full file: chain IO, validation, `isAgentReadOnly`, `parseChainNext`)
- `src/recovery.ts` (full file: recovery strategies, checkpoint protocol)
- `src/agent-types.ts` (full file: unified registry, tool-name resolution)
- `src/default-agents.ts` (full file: 6 default agent configs)
- `src/types.ts` (full file: AgentConfig, AgentRecord, chain types)
- `src/settings.ts` (settings persistence, `toolDescriptionMode`)
- `AGENTS.md` (repo orientation)
- `README.md` (full feature documentation)
- `DECISIONS.md` (architectural decisions log)
