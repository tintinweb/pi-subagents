# Local contract: overridable model/effort defaults

Operator approval: profile controls must provide overridable defaults; package-level changes were explicitly approved for Agent calls, workflows, @mentions, and RPC launches. Model/effort changes do not change tool or permission restrictions.

Source baseline: `4f572eaa04c09d3dbc16e4a5f13a16b295e84e14` from `https://github.com/tintinweb/pi-subagents.git`, npm `@tintinweb/pi-subagents@0.19.0` gitHead; installed `src/invocation-config.ts` matches this baseline. Assigned source workspace is `/opt/engineering/pi-subagents`, detached at that exact baseline. No branches, commits, pushes, tags, or publication are authorized.

## Contract

- Resolve model and thinking independently: explicit caller value first, profile value as default second, existing parent/settings fallback last. Preserve supported explicit `off` and do not treat invalid values as omissions. Validate the resolved caller/profile level against Pi SDK's supported-level list for the resolved model, including `off`: reject it when reasoning cannot be disabled or the model is unresolved; accept it for non-reasoning models. Selected profile defaults must not silently clamp; a model-only override incompatible with profile effort fails until the caller supplies supported effort. Only when both caller and profile effort are absent does the existing parent/settings SDK fallback remain unchanged.
- Keep max-turn, context inheritance, isolation, background, tool, extension, nested-delegation and permission restrictions unchanged. This is only model/thinking precedence.
- Direct and nested Agent tools must use caller-first model/thinking resolution. Existing workflow and RPC caller-first routing must remain correct; fresh mentions without explicit parameters still consume their profile defaults, and model-mediated mentions that generate Agent parameters obey the same precedence.
- Unsupported explicit configurations must fail visibly instead of silently inheriting/clamping to another model/effort. Do not invent cross-provider thinking equivalence or a semantic role classifier.
- Resumed live agents must not be reset to profile defaults or reattributed. This contract does not introduce a new in-session switching API. Requests through a path that cannot honor a switch must report that limitation. Do not rewrite historical session model/effort records.
- Role defaults remain in user profiles: complex Builder `openai-codex/gpt-6.1-sol` medium; Reviewer same model xhigh; Investigator same model high. Startup default remains Sol High. No profile tool privileges are broadened.

## Mapping, acceptance, readiness

The shared `resolveAgentInvocationConfig` in `src/invocation-config.ts` currently uses frontmatter before caller for model/thinking; this is the primary correction point. `src/agent-runner.ts` already resolves explicit options before profile defaults. Existing workflow host and RPC routes already convey caller options; test their behavior rather than adding parallel dispatch. Avoid vendor-file monkeypatching or a hook that covers only direct tool calls.

Acceptance: default-only, model-only, thinking-only, paired overrides; explicit `off`; unchanged restriction precedence; caller model scope classification; direct/nested Agent entry paths; workflow/RPC forwarding; mention fallback/profile defaults; unsupported configuration rejection; resume preservation. Faux/scripted tests only, no paid/live model calls. Update affected user-facing reference and changelog together with code. Retain actual test outputs and limits.

Simplification: reuse shared resolver and existing launch paths, with the smallest necessary validation at the central launch boundary. No new configuration format, policy engine, routing table, persistence, provider, or lifecycle state is required.

Readiness: **READY — DIRECT IMPLEMENTATION**. User explicitly approved the changed model/effort precedence. Existing ownership and permission boundaries are retained; no deployed service, billing, authority expansion, or data migration is involved. The source is an exact matching, isolated engineering checkout. Independent review of the exact diff and deterministic test evidence is required before local activation. Source AGENTS.md forbids commit/branch/publication; respect it. Activate only through a backed-up local package configuration after validation; do not edit installed npm source files in place.

Stop and return to the operator if this requires changing tool/permission restrictions, widening role authority, resetting resumed histories, adding a new invocation framework, or paid/model qualification. No live/deployed runtime claims follow from package tests.
