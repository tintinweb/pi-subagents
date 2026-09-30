# Selective Claude Code schema alignment

**Status**: Candidate; no execution authority.
**Design risk**: High — public tool schema and imported tool restrictions cross configuration and execution boundaries.
**Output language**: English.
**Task**: `claude-schema-alignment`.

## Outcome and boundary

Implement confirmed option A: make pi-subagents easier for models familiar with Claude Code to invoke, while preserving pi runtime semantics. This delivers deterministic contract compatibility, not a measured improvement in third-party model success rates. No model benchmark or full Claude agent-file importer is included.

Keep this as one TaskIntent: schema optionality and frontmatter normalization share one public compatibility contract, documentation, and release boundary. Do not change RPC, workflow scripting, lifecycle tools, model precedence, skills inheritance, agent discovery directories, or project routing policy. Do not add dependencies.

## Discovery evidence

- `src/index.ts`: top-level Agent schema currently requires `subagent_type`; execute delegates to `resolveSpawnType`, carries fallback notes to background/scheduled calls, and exempts resume from spawn rejection. Tool descriptions and the agent-file creation template are additional model-visible references in this file.
- `src/agent-types.ts`: `resolveSpawnTypeIn` already treats missing type like an unresolved type and respects `fallbackSubagent`; `resolveEnabledTypeIn` rejects missing types. These policies remain unchanged.
- `src/nested-tools.ts`: independently declares Agent parameters and resolves new spawns strictly against `allowed_subagents`. It loads the same custom-agent parser. Nested omission must not grant an implicit agent.
- `src/custom-agents.ts`: common parser for global, workspace, and project definitions; partitions builtin names from `ext:` selectors; translates frontmatter into AgentConfig; already owns de-duplicated warnings across consecutive reloads.
- `src/agent-runner.ts`: consumes normalized builtin names and `disallowedTools`, including extension and nested-tool exclusion. Leave tool restriction enforcement here unchanged; normalize once in the parser.
- `src/invocation-config.ts`: frontmatter outranks invocation values; preserves explicit false and zero. No priority change.
- `src/agent-file-toggle.ts`: `serializeAgentFile` emits canonical pi fields. Keep the writer canonical; verify a loaded alias survives serialize/reload through existing tests in `test/custom-agents.test.ts`.
- `README.md`: frontmatter table, Agent parameter table, nested allowlist rules, fallback/default descriptions. Add the compatibility matrix here rather than introducing another reference guide.
- `CHANGELOG.md`: add one concise Unreleased entry at implementation time. Released sections remain immutable.
- Package metadata loads `src/index.ts` directly; compiled `dist` is build output, not a separately maintained schema mirror.

Test seams: `test/fallback-subagent-wiring.test.ts` exercises the actual registered top-level Agent and scheduler with mocked runner; `test/nested-tools.test.ts` exercises child ownership and strict allowlists; `test/custom-agents.test.ts` uses real temporary agent files and loader/serializer round trips; `test/agent-runner.test.ts` already covers builtin, extension, and nested denylist enforcement; `test/invocation-config.test.ts` covers precedence. Reuse these seams instead of introducing a compatibility subsystem.

## Technical design

**Design views**: public interfaces and configuration data flow. No lifecycle/state transition changes or new asynchronous ordering are introduced; existing scheduling, ownership, interruption, and recovery continue unchanged.
**Diagram decision**: not_required.
**Diagram reason**: one normalization boundary feeds existing AgentConfig consumers; the field table and explicit invariants fully describe the flow.

### D1 — Optional top-level agent type

Make only the top-level `Agent.subagent_type` optional. Missing values enter the existing resolver unchanged: default/configured fallback works, strict `fallbackSubagent: none` refuses before spawn, and invalid fallback configuration stays an error. Resume must work without a type. Scheduled calls must persist a resolved nonempty type. Update contradictory descriptions/comments and handle omitted values safely in rendering.

Nested Agent keeps its required type and strict allowlist semantics. Its schema distinction is documented; no implicit nested general-purpose selection is introduced. Do not alter `prompt`, `description`, or any other field requirement.

### D2 — Normalize selected frontmatter fields

| Imported field | Canonical field | Rule |
| --- | --- | --- |
| `disallowedTools` | `disallowed_tools` | Parse the same CSV/YAML-list input supported by the existing parser |
| `maxTurns` | `max_turns` | Same value domain as the existing canonical parser; no new default |
| `background` | `run_in_background` | `true` pins background; `false` leaves mode unspecified, preserving the selected Claude-side semantic boundary |

If a non-null canonical value is present, it wins, including `false`, `0`, and empty lists. When both spellings are supplied, issue a de-duplicated warning naming the file and fields and explaining canonical precedence; do not merge restrictions or silently pick the alias. Existing canonical validation behavior remains unchanged. Reject invalid alias types through a clear warning and ignore that alias; do not convert a malformed alias into a new setting. `maxTurns` accepts non-negative integers, `background` accepts booleans, and `disallowedTools` accepts strings or arrays of strings.

Do not alias `effort` in this change: provider effort is not proven equivalent to pi thinking levels. Treat it as a known unsupported field with a warning directing authors to explicit `thinking` configuration. Canonical serialization remains snake_case. A round trip preserves effective settings, not imported spelling or ignored fields.

### D3 — Narrow tool-name normalization

In `tools` and in the selected denylist field, normalize case-insensitive matches of the seven existing builtin names to their canonical spelling. Map `Glob` (case-insensitive) to `find`; document that this selects pi's file-search capability and does not reproduce Claude Glob's invocation schema.

Never lowercase arbitrary extension or nested tool names: `Agent`, `StructuredOutput`, unknown names, and `ext:` selectors retain exact bytes. Preserve existing wildcard/none behavior and unknown-tool diagnostics. Normalization must happen before builtin partition/wildcard expansion and before the denylist reaches runtime, so `Bash` cannot fail to deny `bash`.

### D4 — Unsupported-field diagnostics

Recognize `permissionMode`, `mcpServers`, `hooks`, `omitClaudeMd`, `initialPrompt`, `experimental`, and `effort` as unsupported for this compatibility contract. Presence produces a warning naming the path and key(s), explicitly saying the fields are ignored and their claimed behavior is not active. Never log field values, hook bodies, or MCP configuration contents. Reuse `warnIfNew`: unchanged files do not spam consecutive reloads; removal followed by reintroduction may warn again. Unknown unrelated frontmatter remains governed by existing behavior.

Warnings are informational and do not implement permissions or hooks. This limitation must be explicit in README. No security equivalence or full import compatibility claim is allowed.

### D5 — Compatibility documentation and ownership

README includes a version-qualified matrix using `matched`, `alias`, `different`, `unsupported`, and `pi-only`; distinguish documented capability comparisons from unpublished/version-dependent Claude Agent schema. Cite official subagent/tools references and the observed Claude Code 2.1.278 comparison baseline from Brainstorm, without claiming all versions match. Record model precedence, skills inheritance, nested omission, background false, and Glob differences.

These aliases are a supported parsing feature, not a temporary bridge or dual runtime. Owner: pi-subagents maintainers. No sunset is scheduled while the documented compatibility contract is supported; removal requires an explicit breaking compatibility decision, removal of the parser entries and matrix rows, and adjustment of their focused tests in the same release. There is no migration, second representation, or persisted compatibility state to clean up.

## Verification and acceptance mapping

Execution posture: test-first at the existing behavioral seams because schema validation can reject a call before runtime fallback executes.

- **AC-1 / D1**: extend `test/fallback-subagent-wiring.test.ts` to verify the registered JSON schema accepts omitted type (not merely direct execute), foreground/background fallback, strict rejection with no runner call, missing-type schedule normalization, and resume without type. Run it with `test/nested-tools.test.ts` to protect the strict nested boundary. Include omitted-type rendering coverage if the schema change reaches a rendering helper.
- **AC-2 / D2–D4**: extend `test/custom-agents.test.ts` with alias-only input, canonical collisions including false/zero/empty, invalid aliases, background false, builtin and Glob normalization, exact extension/nested names, warnings without sensitive values, consecutive reload de-duplication, and serialize/reload behavior. Feed a loaded alias config through the existing runner test seam to prove denied tools are unavailable. Run the custom-agent and runner test files together.
- **D5 and invariants**: review README tables/descriptions and the Unreleased entry against the implemented behavior. Run `npm run check` after implementation as required by the repository; this is a regression requirement, not an acceptance descriptor. Existing invocation-config tests must continue to pass. No network calls, live model evaluations, build, or dependency installation are needed for focused acceptance.

Acceptance descriptors use the existing local Vitest executable and files. Planning validates descriptors only; implementation adds assertions, and Kernel QA executes them afterward. Passing the current pre-change tests alone does not prove these new requirements.

## Recovery and Devil's Advocate Audit

- Rollback resilience: changes are limited to the schema, parser, related tests, and documentation. Partial implementation is not release-ready; remove task-owned changes manually if abandoned, preserving unrelated work. No data migration or external writes exist. Imported alias-only files would lose semantics after rollback, so warn users to convert to canonical fields before deploying a rollback.
- Verification vanity: execute-only tests would miss the required-field defect; assert schema acceptance as well as runner selection. Parser snapshots would miss ineffective denylists; exercise loaded configuration through the runtime tool-selection seam. A warning test must assert no configuration values leak.
- Spec dilution: preserve every confirmed Brainstorm item below. No new lifecycle tool, expanded nested permissions, hidden model override, or skills semantic change can be justified as compatibility work.
- Remaining uncertainty: improved model reliability is a hypothesis. This task proves supported input behavior only; a future explicitly requested benchmark can measure model-specific success rates.

## Brainstorm Trace

| Item | Disposition |
| --- | --- |
| BR-REQ-1 | Outcome, AC-1 and AC-2 improve deterministic supported inputs; no unmeasured success claim |
| BR-DEC-1 | D1–D5 implement a selective superset with explicit semantic limits |
| BR-DEC-2 | D1/AC-1 optional top-level type; strict nested exception follows the existing privilege boundary |
| BR-DEC-3 | D2–D3/AC-2 safe aliases and narrow tool-name normalization; effort excluded as non-equivalent |
| BR-DEC-4 | D4/AC-2 visible de-duplicated unsupported-field diagnostics |
| BR-DEC-5 | Boundary and D5 preserve pi fields, tools, workflow, and RPC |
| BR-OUT-1 | No SendMessage, TaskStop, or fork emulation |
| BR-OUT-2 | Model precedence and skills inheritance unchanged |
| BR-OUT-3 | No hooks, permissions, or MCP runtime implementation |

## Handoff

Candidate authoring and validation confer no execution authority. This request is planning-only. Git tracking is performed by the user under the agreed session workflow; after tracking, validation must report `valid: true` and `enrollment_ready: true` before any later native Enrollment. Do not stage, commit, enroll, or implement during this planning request.
