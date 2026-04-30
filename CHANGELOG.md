# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **`@mariozechner/pi-{ai,coding-agent,tui}` moved from `dependencies` to `peerDependencies`.** Pi extensions are loaded by the host runtime — declaring the framework as a regular dependency installed a *second* copy under this extension's `node_modules`, producing two `runtime` instances and breaking single-instance assumptions (Symbol identity, `instanceof` checks, internal singleton state). Now declared as peers with `>=0.70.5` (permissive minimum so the extension follows whatever version the host has); npm v7+/Bun/pnpm auto-install peers for local development. Matches the shape of `pi-manage-todo-list`.
- **`@sinclair/typebox` pinned from `latest` to `^0.34.49`.** `latest` meant every fresh install could pull a different version with breaking changes; the caret range now tracks the version actually validated against the test suite. Stays as a regular `dependency` because it's a data-only schema library — two copies in memory are harmless.

## [0.6.3] - 2026-04-28

### Fixed
- **`run_in_background: true` (and `inherit_context`, `isolated`) silently ignored on default agents** ([#37](https://github.com/tintinweb/pi-subagents/issues/37) — thanks [@kylesnowschwartz](https://github.com/kylesnowschwartz) for the diagnosis). The three built-in defaults (`general-purpose`, `Explore`, `Plan`) baked `runInBackground: false`, `inheritContext: false`, and `isolated: false` into their configs. `resolveAgentInvocationConfig` uses `agentConfig?.field ?? params.field ?? false`, and `??` only falls through on `null`/`undefined` — so an explicit `false` from the agent config silently won over the caller's `true`. Calling `Agent({ subagent_type: "general-purpose", run_in_background: true })` returned the result inline instead of backgrounding, blocking the parent UI for the agent's full runtime. Fix drops the three lines from each default (and from the unreachable defensive fallback in `agent-runner.ts`) — the type already declared each as `field?: boolean` with JSDoc *"undefined = caller decides"*, so the runtime now matches the documented contract. **Behavior:** custom agents that explicitly set these fields in frontmatter still lock as before (the v0.5.1 "frontmatter is authoritative" guarantee is preserved); the fix only stops *defaults* from spuriously claiming an opinion on callsite-strategy fields they don't actually have. The unreachable fallback now spreads `DEFAULT_AGENTS.get("general-purpose")` instead of duplicating the config inline, so future drift is impossible.

## [0.6.2] - 2026-04-28

### Fixed
- **`Agent` tool fails on Windows with `ENOENT` creating output directory** ([#27](https://github.com/tintinweb/pi-subagents/issues/27) — thanks [@sixnathan](https://github.com/sixnathan) for the diagnosis). The cwd-encoding regex in `output-file.ts` only handled POSIX `/` separators, so on Windows `cwd = "C:\\Users\\foo\\project"` survived unchanged and `path.join(tmpRoot, encoded, …)` produced an invalid nested-absolute path. Now extracts a small `encodeCwd()` helper that handles both `/` and `\\` separators, strips the Windows drive-letter prefix, and preserves UNC server/share segments. The `chmodSync(root, 0o700)` call is also wrapped in a try/catch that swallows errors only on Windows (where chmod is a no-op and can throw on some filesystems); on Unix the error still propagates so umask-defeating `0o700` enforcement is preserved.

## [0.6.1] - 2026-04-25

### Added
- **Persistent `/agents` → Settings** ([#24](https://github.com/tintinweb/pi-subagents/issues/24)) — the four runtime tuning values (`maxConcurrent`, `defaultMaxTurns`, `graceTurns`, `defaultJoinMode`) now survive pi restarts via a two-file dual-scope model mirroring pi's own `SettingsManager`. Global `~/.pi/agent/subagents.json` provides machine-wide defaults (edit by hand; the menu never writes here); project `<cwd>/.pi/subagents.json` holds per-project overrides (written by `/agents` → Settings). Load merges both with project winning on conflicts. Invalid fields are silently dropped per field; malformed JSON emits a warning to stderr and falls back to defaults so startup always proceeds; write failures downgrade the settings toast to a warning with `(session only; failed to persist)` so changes aren't silently reverted on next restart.
- **New lifecycle events** — `subagents:settings_loaded` (emitted once at extension init with the merged settings) and `subagents:settings_changed` (emitted on each `/agents` → Settings mutation with the new snapshot and a `persisted: boolean` flag so listeners can react to write failures).

### Fixed
- **`AGENTS.md` / `CLAUDE.md` / `APPEND_SYSTEM.md` no longer leak into sub-agent prompts** ([#26](https://github.com/tintinweb/pi-subagents/pull/26) — thanks [@mikeyobrien](https://github.com/mikeyobrien) for the diagnosis). Upstream `buildSystemPrompt()` re-appends `contextFiles` and `appendSystemPrompt` *after* our `systemPromptOverride` runs, which silently defeated `prompt_mode: replace` and `isolated: true` — parent project context (e.g. autoresearch-mode blocks) was bleeding into fresh `Explore` / custom sub-agents regardless of frontmatter. Fix uses upstream's `noContextFiles: true` flag (skips the load entirely, introduced in pi 0.68) plus `appendSystemPromptOverride: () => []` (no flag equivalent for append sources). **Behavior change:** subagents no longer implicitly inherit parent `AGENTS.md`/`CLAUDE.md`/`APPEND_SYSTEM.md`. To get parent project context into a subagent, use `prompt_mode: append` (parent's already-built system prompt flows in via `systemPromptOverride`), or `inherit_context: true` (parent conversation), or inline the content into the agent's own frontmatter.
- **Custom agent discovery respects `PI_CODING_AGENT_DIR`** ([#35](https://github.com/tintinweb/pi-subagents/pull/35), closes [#23](https://github.com/tintinweb/pi-subagents/issues/23) — thanks [@Amolith](https://github.com/Amolith) for the diagnosis). Two remaining hardcoded `~/.pi/agent/agents/` paths in `custom-agents.ts` and `index.ts` bypassed the env var, so users who relocated their agent directory (e.g. via `PI_CODING_AGENT_DIR`) still had global agents loaded from the default location and help text referencing the wrong path. Both now use upstream `getAgentDir()`, consistent with `agent-runner.ts` and `settings.ts`; tilde expansion is handled by upstream.

## [0.6.0] - 2026-04-24

> **⚠️ Breaking: drops support for `pi` < 0.68.** The upstream `pi-coding-agent` package shipped breaking API changes in v0.68 (and further ones in v0.70). This release migrates to `^0.70.2` and is **not** backward-compatible with hosts on `pi` 0.62–0.67. Users on those versions must upgrade their `pi` installation (`npm install -g @mariozechner/pi-coding-agent@latest`) before updating this extension.

### Changed
- **Bumped peer `@mariozechner/pi-coding-agent` to `^0.70.2`** ([#28](https://github.com/tintinweb/pi-subagents/pull/28)) — crosses the v0.68 breaking-change line upstream. Specifically: tools are now passed as `string[]` (was `Tool[]`); `cwd`/`agentDir` are mandatory on `SettingsManager.create()` and `DefaultResourceLoader`; `session_switch` event renamed to `session_before_switch`; `ToolDefinition.params` widens to `unknown` under contextual typing, requiring `defineTool(...)`.
- **Tool registrations wrapped with `defineTool(...)`** — preserves `TParams` inference so `execute` handlers get properly-typed `params` instead of `unknown`. Applies to the `Agent`, `get_subagent_result`, and `steer_subagent` tools.

### Removed
- **Cwd-bound tool factory registry** — the internal `TOOL_FACTORIES` closure table and `create{Bash,Edit,Read,Write,Grep,Find,Ls}Tool` imports are gone. Exported helpers renamed: `getToolsForType(type, cwd)` → `getToolNamesForType(type)`, `getMemoryTools(cwd, set)` → `getMemoryToolNames(set)`, `getReadOnlyMemoryTools(cwd, set)` → `getReadOnlyMemoryToolNames(set)` — all returning `string[]` instead of `Tool[]`. The host binds cwd when resolving tool names, so the extension no longer instantiates tools directly.

### Fixed
- **Subagent `SettingsManager` read wrong project settings in worktree mode** ([#30](https://github.com/tintinweb/pi-subagents/pull/30)) — `SettingsManager.create()` was called without arguments, defaulting `cwd` to `process.cwd()`. When the subagent's effective cwd differed (worktree isolation or explicit `cwd` override), its settings manager read `.pi/settings.json` from the parent's cwd rather than its own, diverging from the loader and session manager. Now passes `effectiveCwd` and `agentDir` explicitly, keeping all three managers consistent.

## [0.5.2] - 2026-03-26

### Fixed
- **Extension `session_start` handlers now fire in subagent sessions** ([#20](https://github.com/tintinweb/pi-subagents/issues/20)) — `bindExtensions()` was never called on subagent sessions, so extensions that initialize state in `session_start` (e.g. loading credentials, setting up connections) silently failed at runtime. Tools appeared registered but were non-functional. Now calls `session.bindExtensions()` after tool filtering and before prompting, matching the lifecycle used by pi's interactive, print, and RPC modes. Also triggers `extendResourcesFromExtensions("startup")` so extension-provided skills and prompts are discovered.

## [0.5.1] - 2026-03-24

### Changed
- **Agent config is authoritative** — frontmatter values for `model`, `thinking`, `max_turns`, `inherit_context`, `run_in_background`, `isolated`, and `isolation` now take precedence over `Agent` tool-call parameters. Tool-call params only fill fields the agent config leaves unspecified.
- **`join_mode` is now a global setting only** — removed the per-call `join_mode` parameter from the `Agent` tool. Join behavior is configured via `/agents` → Settings → Join mode.
- **`max_turns: 0` means unlimited** — agent files can now explicitly set `max_turns: 0` to lock unlimited turns. Previously `0` was silently clamped to `1`.

### Fixed
- **Final subagent text preserved from non-streaming providers** — agents using providers that return the final message without streaming `text_delta` events no longer return empty results. Falls back to extracting text from the completed session history.
- **`effectiveMaxTurns` passed to spawn calls** — previously `params.max_turns` was passed raw to both foreground and background spawn, bypassing the agent config entirely.

## [0.5.0] - 2026-03-22

### Added
- **RPC stop handler** — new `subagents:rpc:stop` event bus RPC allows other extensions to stop running subagents by agent ID. Returns structured error ("Agent not found") on failure.
- **`abort` in `SpawnCapable` interface** — cross-extension RPC consumers can now stop agents, not just spawn them.
- **Live turn counter** — all agents now show a live turn count in the widget, inline result, and completion notification. With a turn limit: `⟳5≤30` (5 of 30 turns). Without: `⟳5`. Updates in real time as turns progress via `onTurnEnd` callback.
- **Biome linting** — added [Biome](https://biomejs.dev/) for correctness linting (unused imports, suspicious patterns). Style rules disabled. Run `npm run lint` to check, `npm run lint:fix` to auto-fix.
- **CI workflow** — GitHub Actions runs lint, typecheck, and tests on push to master and PRs.
- **Auto-trigger parent turn on background completion** — background agent completion notifications now use `triggerTurn: true`, automatically prompting the parent agent to process results instead of waiting for user input.

### Changed
- **Standardized RPC envelope** — cross-extension RPC handlers (`ping`, `spawn`, `stop`) now use a `handleRpc` wrapper that emits structured envelopes (`{ success: true, data }` / `{ success: false, error }`), matching pi-mono's `RpcResponse` convention.
- **Protocol versioning via ping** — ping reply now includes `{ version: PROTOCOL_VERSION }` (currently v2). Callers can detect version mismatches and warn users to update.
- **Default max turns is now unlimited** — subagents no longer have a 50-turn default cap. The default is unlimited (no turn limit), matching Claude Code's main loop behavior. Users can still set explicit limits per-agent via `max_turns` frontmatter or the Agent tool parameter, or globally via `/agents` → Settings (`0` = unlimited).
- **Stale dist in published package** — added `prepublishOnly` hook to build fresh `dist/` on every `npm publish`.

### Fixed
- **Tool name display** — `getAgentConversation` now reads `ToolCall.name` (the correct property) instead of `toolName`, resolving `[Tool: unknown]` in conversation viewer and verbose output.
- **Env test CI failure** — `detectEnv` test assumed a branch name exists, but CI checks out detached HEAD. Split into separate tests for repo detection and branch detection with a controlled temp repo.

## [0.4.9] - 2026-03-18

### Fixed
- **Conversation viewer crash in narrow terminals** ([#7](https://github.com/tintinweb/pi-subagents/issues/7)) — `buildContentLines()` in the live conversation viewer could return lines wider than the terminal when `wrapTextWithAnsi()` misjudged visible width on ANSI-heavy input (e.g. tool output with embedded escape codes, long URLs, wide tables). All content lines are now clamped with `truncateToWidth()` before returning. Same class of bug as the widget fix in v0.2.7, different component.

### Added
- **Conversation viewer width-safety tests** — 17 tests covering `render()` and `buildContentLines()` across varied content (plain text, ANSI codes, unicode, tables, long URLs, narrow terminals). Includes mock-based regression tests that simulate upstream `wrapTextWithAnsi` returning overwidth lines, ensuring the safety net catches them.

## [0.4.8] - 2026-03-18

### Added
- **Cross-extension RPC** — other pi extensions can spawn subagents via `pi.events` event bus (`subagents:rpc:ping`, `subagents:rpc:spawn`). Emits `subagents:ready` on load.
- **Session persistence for agent records** — completed agent records are persisted via `pi.appendEntry("subagents:record", ...)` for cross-extension history reconstruction.

### Fixed
- **Background agent notification race condition** — `pi.sendMessage()` is fire-and-forget, so completion notifications sent eagerly from `onComplete` could not be retracted when `get_subagent_result` was called in the same turn. Notifications are now held behind a 200ms cancellable timer; `get_subagent_result` cancels the pending timer before it fires, eliminating duplicate notifications. Group notifications also re-check `resultConsumed` at send time so consumed agents are filtered out.

## [0.4.7] - 2026-03-17

### Added
- **Custom notification renderer** — background agent completion notifications now render as styled, themed boxes instead of raw XML. Uses `pi.registerMessageRenderer()` with the `"subagent-notification"` custom message type. The LLM continues to receive `<task-notification>` XML via `content`; only the user-facing display changes.
- **Group notification rendering** — group completions render each agent as its own styled block (icon, description, stats, result preview) instead of showing only the first agent.
- **Output file streaming for background agents** — background agents now get the same output file transcript as foreground agents, with `onSessionCreated` wiring and proper cleanup on completion/error.
- `NotificationDetails` type in `types.ts` — structured details for the notification renderer, with optional `others` array for group notifications.
- `buildNotificationDetails()` helper — extracts renderer-facing details from an `AgentRecord`.

### Changed
- **Notification delivery** — `sendIndividualNudge` and group notification now use `pi.sendMessage()` (custom message) instead of `pi.sendUserMessage()` (plain text), enabling renderer-controlled display.
- **Steered status rendering** — steered agents show "completed (steered)" in the notification box instead of plain "completed".

### Fixed
- **Output file cleanup on completion** — `agent-manager.ts` now calls `record.outputCleanup()` in both the success and error paths of agent completion, ensuring the streaming subscription is flushed and released.

## [0.4.6] - 2026-03-16

### Fixed
- **Graceful shutdown aborts agents instead of blocking** — `session_shutdown` now calls `abortAll()` instead of `waitForAll()`, so the process exits immediately instead of hanging until all background agents complete. Agent results are undeliverable after shutdown anyway.

### Added
- `abortAll()` method on `AgentManager` — stops all queued and running agents at once, returning the count of affected agents.

## [0.4.5] - 2026-03-16

### Changed
- **Widget render-once pattern** — the widget callback is now registered once via `setWidget()` and subsequent updates use `requestRender()` instead of re-registering the entire widget on every `update()` call. Eliminates layout thrashing from repeated widget teardown/setup cycles.
- **Status bar dedup** — `setStatus()` is now only called when the status text actually changes, avoiding redundant TUI updates.
- **UICtx change detection** — `setUICtx()` detects context changes and forces widget re-registration, correctly handling session switches.

### Refactored
- Extracted `renderWidget()` private method — moves all widget content rendering out of the `update()` closure into a standalone method that reads live state on each call.
- `update()` is now a lightweight coordinator: counts agents, manages registration lifecycle, and triggers re-renders.

## [0.4.4] - 2026-03-16

### Fixed
- **Race condition in `get_subagent_result` with `wait: true`** — `resultConsumed` is now set before `await record.promise`, preventing a redundant follow-up notification. Previously the `onComplete` callback (attached at spawn time via `.then()`) always fired before the await resumed, seeing `resultConsumed` as false.
- **Stale agent records across sessions** — new `clearCompleted()` method removes all completed/stopped/errored agent records on `session_start` and `session_switch` events, so tasks from a prior session don't persist into a new one.
- **`steer_subagent` race on freshly launched agents** — steering an agent before its session initialized silently dropped the message. Now steers are queued on the record and flushed once `onSessionCreated` fires.

### Changed
- Extracted `removeRecord()` private helper in `AgentManager` — deduplicates dispose+delete logic between `cleanup()` and `clearCompleted()`.

### Added
- 8 new tests covering `resultConsumed` race condition and `clearCompleted` behavior (185 total).

## [0.4.3] - 2026-03-13

### Added
- **Persistent agent memory** — new `memory` frontmatter field with three scopes: `"user"` (global `~/.pi/`), `"project"` (per-project `.pi/`), `"local"` (gitignored `.pi/`). Agents with write/edit tools get full read-write memory; read-only agents get a read-only fallback that injects existing MEMORY.md content without granting write access or creating directories.
- **Git worktree isolation** — new `isolation: "worktree"` frontmatter field and Agent tool parameter. Creates a temporary `git worktree` so agents work on an isolated copy of the repo. On completion, changes are auto-committed to a `pi-agent-<id>` branch; clean worktrees are removed. Includes crash recovery via `pruneWorktrees()`.
- **Skill preloading** — `skills` frontmatter now accepts a comma-separated list of skill names (e.g. `skills: planning, review`). Reads from `.pi/skills/` (project) then `~/.pi/skills/` (global), tries `.md`/`.txt`/bare extensions. Content injected into the system prompt as `# Preloaded Skill: {name}`.
- **Tool denylist** — new `disallowed_tools` frontmatter field (e.g. `disallowed_tools: bash, write`). Blocks specified tools even if `builtinToolNames` or extensions would provide them. Enforced for both extension-enabled and extension-disabled agents.
- **Prompt extras system** — new `PromptExtras` interface in `prompts.ts`; `buildAgentPrompt()` accepts optional memory and skill blocks appended in both `replace` and `append` modes.
- `getMemoryTools()`, `getReadOnlyMemoryTools()` in `agent-types.ts`.
- `buildMemoryBlock()`, `buildReadOnlyMemoryBlock()`, `isSymlink()`, `safeReadFile()` in `memory.ts`.
- `preloadSkills()` in `skill-loader.ts`.
- `createWorktree()`, `cleanupWorktree()`, `pruneWorktrees()` in `worktree.ts`.
- `MemoryScope`, `IsolationMode` types; `memory`, `isolation`, `disallowedTools` fields on `AgentConfig`; `worktree`, `worktreeResult` fields on `AgentRecord`.
- 177 total tests across 8 test files (41 new tests).

### Fixed
- **Read-only agents no longer escalated to read-write** — enabling `memory` on a read-only agent (e.g. Explore) previously auto-added `write`/`edit` tools. Now the runner detects write capability and branches: read-write agents get full memory tools, read-only agents get read-only memory prompt with only the `read` tool added.
- **Denylist-aware memory detection** — write capability check now accounts for `disallowedTools`. An agent with `tools: write` + `disallowed_tools: write` correctly gets read-only memory instead of broken read-write instructions.
- **Worktree requires commits** — repos with no commits (empty HEAD) are now rejected early with a warning instead of failing silently at `git worktree add`.
- **Worktree failure warning** — when worktree creation fails, a warning is prepended to the agent's prompt instead of silently falling through to the main cwd.
- **No force-branch overwrite** — worktree cleanup appends a timestamp suffix on branch name conflict instead of using `git branch -f`.

### Security
- **Whitelist name validation** — agent/skill names must match `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`, max 128 chars. Rejects path traversal, leading dots, spaces, and special characters.
- **Symlink protection** — `safeReadFile()` and `isSymlink()` reject symlinks in memory directories, MEMORY.md files, and skill files, preventing arbitrary file reads.
- **Symlink-safe directory creation** — `ensureMemoryDir()` throws on symlinked directories.

### Changed
- `agent-runner.ts`: tool/extension/skill resolution moved before memory detection; `ctx.cwd` → `effectiveCwd` throughout.
- `custom-agents.ts`: extracted `parseCsvField()` helper; added `csvListOptional()` and `parseMemory()`.
- `skill-loader.ts`: uses `safeReadFile()` from `memory.ts` instead of raw `readFileSync`.
- Agent tool schema updated with `isolation` parameter and help text for `memory`, `isolation`, `disallowed_tools`, and skill list.

## [0.4.2] - 2026-03-12

### Added
- **Event bus** — agent lifecycle events emitted via `pi.events.emit()`, enabling other extensions to react to sub-agent activity:
  - `subagents:created` — background agent registered (includes `id`, `type`, `description`, `isBackground`)
  - `subagents:started` — agent transitions to running (includes queued→running)
  - `subagents:completed` — agent finished successfully (includes `durationMs`, `tokens`, `toolUses`, `result`)
  - `subagents:failed` — agent errored, stopped, or aborted (same payload as completed)
  - `subagents:steered` — steering message sent to a running agent
- `OnAgentStart` callback and `onStart` constructor parameter on `AgentManager`.
- **Cross-package manager** now also exposes `spawn()` and `getRecord()` via the `Symbol.for("pi-subagents:manager")` global.

## [0.4.1] - 2026-03-11

### Fixed
- **Graceful shutdown in headless mode** — the CLI now waits for all running and queued background agents to complete before exiting (`waitForAll` on `session_shutdown`). Previously, background agents could be silently killed mid-execution when the session ended. Only affects headless/non-interactive mode; interactive sessions already kept the process alive.

### Added
- `hasRunning()` / `waitForAll()` methods on `AgentManager`.
- **Cross-package manager access** — agent manager exposed via `Symbol.for("pi-subagents:manager")` on `globalThis` for other extensions to check status or await completion.

## [0.4.0] - 2026-03-11

### Added
- **XML-delimited prompt sections** — append-mode agents now wrap inherited content in `<inherited_system_prompt>`, `<sub_agent_context>`, and `<agent_instructions>` XML tags, giving the model explicit structure to distinguish inherited rules from sub-agent-specific instructions. Replace mode is unchanged.
- **Token count in agent results** — foreground agent results, background completion notifications, and `get_subagent_result` now include the token count alongside tool uses and duration (e.g. `Agent completed in 4.2s (12 tool uses, 33.8k token)`).
- **Widget overflow cap** — the running agents widget now caps at 12 lines. When exceeded, running agents are prioritized over finished ones and an overflow summary line shows hidden counts (e.g. `+3 more (1 running, 2 finished)`).

### Changed - **changing behavior**
- **General-purpose agent inherits parent prompt** — the default `general-purpose` agent now uses `promptMode: "append"` with an empty system prompt, making it a "parent twin" that inherits the full parent system prompt (including CLAUDE.md rules, project conventions, and safety guardrails). Previously it used a standalone prompt that duplicated a subset of the parent's rules. Explore and Plan are unchanged (standalone prompts). To customize: eject via `/agents` → select `general-purpose` → Eject, then edit the resulting `.md` file. Set `prompt_mode: replace` to go back to a standalone prompt, or keep `prompt_mode: append` and add extra instructions in the body.
- **Append-mode agents receive parent system prompt** — `buildAgentPrompt` now accepts the parent's system prompt and threads it into append-mode agents (env header + parent prompt + sub-agent context bridge + optional custom instructions). Replace-mode agents are unchanged.
- **Prompt pipeline simplified** — removed `systemPromptOverride`/`systemPromptAppend` from `SpawnOptions` and `RunOptions`. These were a separate code path where `index.ts` pre-resolved the prompt mode and passed raw strings into the runner, bypassing `buildAgentPrompt`. Now all prompt assembly flows through `buildAgentPrompt` using the agent's `promptMode` config — one code path, no special cases.

### Removed
- Deprecated backwards-compat aliases: `registerCustomAgents`, `getCustomAgentConfig`, `getCustomAgentNames` (use `registerAgents`, `getAgentConfig`, `getUserAgentNames`).
- `resolveCustomPrompt()` helper in index.ts — no longer needed now that prompt routing is config-driven.

## [0.3.1] - 2026-03-09

### Added
- **Live conversation viewer** — selecting a running (or completed) agent in `/agents` → "Running agents" now opens a scrollable overlay showing the agent's full conversation in real time. Auto-scrolls to follow new content; scroll up to pause, End to resume. Press Esc to close.

## [0.3.0] - 2026-03-08

### Added
- **Case-insensitive agent type lookup** — `"explore"`, `"EXPLORE"`, and `"Explore"` all resolve to the same agent. LLMs frequently lowercase type names; this prevents validation failures.
- **Unknown type fallback** — unrecognized agent types fall back to `general-purpose` with a note, instead of hard-rejecting. Matches Claude Code behavior.
- **Dynamic tool list for general-purpose** — `builtinToolNames` is now optional in `AgentConfig`. When omitted, the agent gets all tools from `TOOL_FACTORIES` at lookup time, so new tools added upstream are automatically available.
- **Agent source indicators in `/agents` menu** — `•` (project), `◦` (global), `✕` (disabled) with legend. Defaults are unmarked.
- **Disabled agents visible in UI** — disabled agents now show in the "Agent types" list (marked `✕`) with an Enable action, instead of being invisible.
- **Enable action** — re-enable a disabled agent from the `/agents` menu. Stub files are auto-cleaned.
- **Disable action for all agent types** — custom and ejected default agents can now be disabled from the UI, not just built-in defaults.
- `resolveType()` export — case-insensitive type name resolution for external use.
- `getAllTypes()` export — returns all agent names including disabled (for UI listing).
- `source` field on `AgentConfig` — tracks where an agent was loaded from (`"default"`, `"project"`, `"global"`).

### Fixed
- **Model resolver checks auth for exact matches** — `resolveModel("anthropic/claude-haiku-4-5-20251001")` now fails gracefully when no Anthropic API key is configured, instead of returning a model that errors at the API call. Explore silently falls back to the parent model on non-Anthropic setups.

### Changed
- **Unified agent registry** — built-in and custom agents now use the same `AgentConfig` type and a single registry. No more separate code paths for built-in vs custom agents.
- **Default agents are overridable** — creating a `.md` file with the same name as a default agent (e.g. `.pi/agents/Explore.md`) overrides it.
- **`/agents` menu** — "Agent types" list shows defaults and custom agents together with source indicators. Default agents get Eject/Disable actions; overridden defaults get Reset to default.
- **Eject action** — export a default agent's embedded config as a `.md` file to project or personal location for customization.
- **Model labels** — provider-agnostic: strips `provider/` prefix and `-YYYYMMDD` date suffix (e.g. `anthropic/claude-haiku-4-5-20251001` → `claude-haiku-4-5`). Works for any provider.
- **New frontmatter fields** — `display_name` (UI display name) and `enabled` (default: true; set to false to disable).
- **Menu navigation** — Esc in agent detail returns to agent list (not main menu).

### Removed
- **`statusline-setup` and `claude-code-guide` agents** — removed as built-in types (never spawned programmatically). Users can recreate them as custom agents if needed.
- `BuiltinSubagentType` union type, `SUBAGENT_TYPES` array, `DISPLAY_NAMES` map, `SubagentTypeConfig` interface — replaced by unified `AgentConfig`.
- `buildSystemPrompt()` switch statement — replaced by config-driven `buildAgentPrompt()`.
- `HAIKU_MODEL_IDS` fallback array — Explore's haiku default is now just the `model` field in its config.
- `BUILTIN_MODEL_LABELS` — model labels now derived from config.
- `ALL_TOOLS` hardcoded constant — general-purpose now derives tools dynamically.

### Added
- `src/default-agents.ts` — embedded default configs for general-purpose, Explore, and Plan.

## [0.2.7] - 2026-03-08

### Fixed
- **Widget crash in narrow terminals** — agent widget lines were not truncated to terminal width, causing `doRender` to throw when the tmux pane was narrower than the rendered content. All widget lines are now truncated using `truncateToWidth()` with the actual terminal column count.

## [0.2.6] - 2026-03-07

### Added
- **Background task join strategies** — smart grouping of background agent completion notifications
  - `smart` (default): 2+ background agents spawned in the same turn are auto-grouped into a single consolidated notification instead of individual nudges
  - `async`: each agent notifies individually on completion (previous behavior)
  - `group`: force grouping even for solo agents
  - 30s timeout after first completion delivers partial results; 15s straggler re-batch window for remaining agents
- **`join_mode` parameter** on the `Agent` tool — override join strategy per agent (`"async"` or `"group"`)
- **Join mode setting** in `/agents` → Settings — configure the default join mode at runtime
- New `src/group-join.ts` — `GroupJoinManager` class for batched completion notifications

### Changed
- `AgentRecord` now includes optional `groupId`, `joinMode`, and `resultConsumed` fields
- Background agent completion routing refactored: individual nudge logic extracted to `sendIndividualNudge()`, group delivery via `GroupJoinManager`

### Fixed
- **Debounce window race** — agents that complete during the 100ms batch debounce window are now deferred and retroactively fed into the group once it's registered, preventing split notifications (one individual + one partial group) and zombie groups
- **Solo agent swallowed notification** — if only one agent was spawned (no group formed) but it completed during the debounce window, its deferred notification is now sent when the batch finalizes
- **Duplicate notifications after polling** — calling `get_subagent_result` on a completed agent now marks its result as consumed, suppressing the subsequent completion notification (both individual and group)

## [0.2.5] - 2026-03-06

### Added
- **Interactive `/agents` menu** — single command replaces `/agent` and `/agents` with a full management wizard
  - Browse and manage running agents
  - Custom agents submenu — edit or delete existing agents
  - Create new custom agents via manual wizard or AI-generated (with comprehensive frontmatter documentation for the generator)
  - Settings: configure max concurrency, default max turns, and grace turns at runtime
  - Built-in agent types shown with model info (e.g. `Explore · haiku`)
  - Aligned formatting for agent lists
- **Configurable turn limits** — `defaultMaxTurns` and `graceTurns` are now runtime-adjustable via `/agents` → Settings
- Sub-menus return to main menu instead of exiting

### Removed
- `/agent <type> <prompt>` command (use `Agent` tool directly, or create custom agents via `/agents`)

## [0.2.4] - 2026-03-06

### Added
- **Global custom agents** — agents in `~/.pi/agent/agents/*.md` are now discovered automatically and available across all projects
- Two-tier discovery hierarchy: project-level (`.pi/agents/`) overrides global (`~/.pi/agent/agents/`)

## [0.2.3] - 2026-03-05

### Added
- Screenshot in README

## [0.2.2] - 2026-03-05

### Changed
- Renamed package to `@tintinweb/pi-subagents`
- Fuzzy model resolver now only matches models with auth configured (prevents selecting unconfigured providers)
- Custom agents hot-reload on each `Agent` tool call (no restart needed for new `.pi/agents/*.md` files)
- Updated pi dependencies to 0.56.1

### Refactored
- Extracted `createActivityTracker()` — eliminates duplicated tool activity wiring between foreground and background paths
- Extracted `safeFormatTokens()` — replaces 4 repeated try-catch blocks
- Extracted `buildDetails()` — consolidates AgentDetails construction
- Extracted `getStatusLabel()` / `getStatusNote()` — consolidates 3 duplicated status formatting chains
- Shared `extractText()` — consolidated duplicate from context.ts and agent-runner.ts
- Added `ERROR_STATUSES` constant in widget for consistent status checks
- `getDisplayName()` now delegates to `getConfig()` instead of separate lookups
- Removed unused `Tool` type export from agent-types

## [0.2.1] - 2026-03-05

### Added
- **Persistent above-editor widget** — tree view of all running/queued/finished agents with animated spinners and live stats
- **Concurrency queue** — configurable max concurrent background agents (default: 4), auto-drain
- **Queued agents** collapsed to single summary line in widget
- **Turn-based widget linger** — completed agents clear after 1 turn, errors/aborted linger for 2 extra turns
- **Colored status icons** — themed rendering via `setWidget` callback form (`✓` green, `✓` yellow, `✗` red, `■` dim)
- **Live response streaming** — `onTextDelta` shows truncated agent response text instead of static "thinking..."

### Changed
- Tool names match Claude Code: `Agent`, `get_subagent_result`, `steer_subagent`
- Labels use "Agent" / "Agents" (not "Subagent")
- Widget heading: `●` when active, `○` when only lingering finished agents
- Extracted all UI code to `src/ui/agent-widget.ts`

## [0.2.0] - 2026-03-05

### Added
- **Claude Code-style UI rendering** — `renderCall`/`renderResult`/`onUpdate` for live streaming progress
  - Live activity descriptions: "searching, reading 3 files…"
  - Token count display: "33.8k token"
  - Per-agent tool use counter
  - Expandable completed results (ctrl+o)
  - Distinct states: running, background, completed, error, aborted
- **Async environment detection** — replaced `execSync` with `pi.exec()` for non-blocking git/platform detection
- **Status bar integration** — running background agent count shown in pi's status bar
- **Fuzzy model selection** — `"haiku"`, `"sonnet"` resolve to best matching available model

### Changed
- Tool label changed from "Spawn Agent" to "Agent" (matches Claude Code style)
- `onToolUse` callback replaced with richer `onToolActivity` (includes tool name + start/end)
- `onSessionCreated` callback for accessing session stats (token counts)
- `env.ts` now requires `ExtensionAPI` parameter (async `pi.exec()` instead of `execSync`)

## [0.1.0] - 2026-03-05

Initial release.

### Added
- **Autonomous sub-agents** — spawn specialized agents via tool call, each running in an isolated pi session
- **Built-in agent types** — general-purpose, Explore (defaults to haiku), Plan, statusline-setup, claude-code-guide
- **Custom user-defined agents** — define agents in `.pi/agents/<name>.md` with YAML frontmatter + system prompt body
- **Frontmatter configuration** — tools, extensions, skills, model, thinking, max_turns, prompt_mode, inherit_context, run_in_background, isolated
- **Graceful max_turns** — steer message at limit, 5 grace turns, then hard abort
- **Background execution** — `run_in_background` with completion notifications
- **`get_subagent_result` tool** — check status, wait for completion, verbose conversation output
- **`steer_subagent` tool** — inject steering messages into running agents mid-execution
- **Agent resume** — continue a previous agent's session with a new prompt
- **Context inheritance** — fork the parent conversation into the sub-agent
- **Model override** — per-agent model selection
- **Thinking level** — per-agent extended thinking control
- **`/agent` and `/agents` commands**

[0.6.3]: https://github.com/tintinweb/pi-subagents/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/tintinweb/pi-subagents/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/tintinweb/pi-subagents/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/tintinweb/pi-subagents/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/tintinweb/pi-subagents/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/tintinweb/pi-subagents/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/tintinweb/pi-subagents/compare/v0.4.9...v0.5.0
[0.4.9]: https://github.com/tintinweb/pi-subagents/compare/v0.4.8...v0.4.9
[0.4.8]: https://github.com/tintinweb/pi-subagents/compare/v0.4.7...v0.4.8
[0.4.7]: https://github.com/tintinweb/pi-subagents/compare/v0.4.6...v0.4.7
[0.4.6]: https://github.com/tintinweb/pi-subagents/compare/v0.4.5...v0.4.6
[0.4.5]: https://github.com/tintinweb/pi-subagents/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/tintinweb/pi-subagents/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/tintinweb/pi-subagents/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/tintinweb/pi-subagents/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/tintinweb/pi-subagents/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/tintinweb/pi-subagents/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/tintinweb/pi-subagents/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/tintinweb/pi-subagents/compare/v0.2.7...v0.3.0
[0.2.7]: https://github.com/tintinweb/pi-subagents/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/tintinweb/pi-subagents/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/tintinweb/pi-subagents/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/tintinweb/pi-subagents/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/tintinweb/pi-subagents/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/tintinweb/pi-subagents/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/tintinweb/pi-subagents/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/tintinweb/pi-subagents/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/tintinweb/pi-subagents/releases/tag/v0.1.0
