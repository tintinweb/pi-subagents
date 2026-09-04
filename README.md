# @tintinweb/pi-subagents

A [pi](https://pi.dev) extension that brings **Claude Code-style autonomous sub-agents and workflow orchestration** to pi. Spawn specialized agents that run in isolated sessions — each with its own tools, system prompt, model, and thinking level. Run them in the background (the default) or block on them, steer them mid-run, resume completed sessions, and define your own custom agent types. When the orchestration shouldn't be improvised, hand a deterministic JavaScript script to the `SubagentWorkflow` tool — `agent()`, `parallel()`, `pipeline()` — and scripts written for Claude Code's `Workflow` tool run here unchanged.

<img width="600" alt="pi-subagents screenshot" src="https://github.com/tintinweb/pi-subagents/raw/master/media/screenshot.png" />


https://github.com/user-attachments/assets/8685261b-9338-4fea-8dfe-1c590d5df543

<img width="600" alt="pi-color-badges-white" src="https://github.com/user-attachments/assets/555dcae4-333e-4ff0-b420-7b3369c018a4" />


## Features

- **Claude Code look & feel** — same tool names, calling conventions, and UI patterns (`Agent`, `get_subagent_result`, `steer_subagent`) — feels native
- **Parallel background agents** — spawn multiple agents that run concurrently with automatic queuing (configurable concurrency limit, default 10) and smart group join (consolidated notifications)
- **Live widget UI** — persistent above-editor widget with animated spinners, live tool activity, token counts, and colored status icons. Configurable via `/agents → Settings → Widget`: `all` (every agent), `background` (default — hides foreground runs, which already render inline as the `Agent` tool result), or `off`
- **FleetView** — Claude Code-style navigable list of `main` + every running subagent rendered below the editor (earliest-launched first). Press `↓` (or `←`) at an empty prompt to jump in, `↑`/`↓` to move the selection, `Enter` to open the selected agent's live, auto-updating conversation, `Esc` to return. Finished agents linger briefly before dropping out, and a viewer stays open through completion so you can read the final output. Toggle via `/agents → Settings → Fleet view`
- **Conversation viewer** — select any agent in `/agents` to open a live-scrolling overlay of its full conversation (auto-follows new content, scroll up to pause). Steer a running agent inline by pressing `Enter` to open a composer, typing, then `Enter` to send (`Esc` or an empty submit returns) — the message appears as a user message and redirects the agent after its current tool. Stop a still-running agent by pressing `x` (then `x` again to confirm) — both work for background agents too. Assistant text renders as Markdown; `m` cycles that between off, assistant-only and everything (see [Viewer markdown](#persistent-settings))
- **Custom agent types** — define agents in `.pi/agents/<name>.md` or `.agents/agents/<name>.md` (project) or globally, with YAML frontmatter: custom system prompts, model selection, thinking levels, tool restrictions, and Claude Code-compatible colored name badges
- **Nested subagents** — opt-in, default-off delegation: a custom agent that sets `allowed_subagents` gets its own ownership-scoped `Agent`, `get_subagent_result`, and `steer_subagent` tools, depth-capped from the main session (default 2). It can control only its own children, they are stopped when it finishes, and their transcripts and token spend roll up to it. The allowlist is a privilege boundary — a child runs with its own tools, so pick it as carefully as `tools:` itself
- **Agent mentions** — subagents are first-class: type `@explore also check the RPC path` at the prompt and it goes to that agent instead of the main model, without a word of it entering the chat. One syntax covers the whole lifecycle — message it while it runs, resume it once it has finished, reopen its session from disk long after that, or start it if it never ran. Mentioning an agent that isn't running spawns it through an off-screen clone of the conversation, so it gets Claude Code's context-written prompt and a real `Agent` tool call without a word of it reaching the chat; `direct` mode starts it here from your text instead, with no model call at all. The orchestrator can `name` an agent so you address it as `@auth-audit`, and handles work in `steer_subagent`/`get_subagent_result` too. `@` completes live agents, resumable ones, and startable types alongside pi's file completion; `@main` forces text back to the main model. Toggle via `/agents → Settings → Agent mentions`
- **Scripted workflows** — a `SubagentWorkflow` tool that runs a deterministic JavaScript script orchestrating many subagents: `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()` and `args`, with a pure-literal `meta` block declaring the phases. `pipeline()` has no barrier between stages, so one item can be in a later stage while another is still in the first — unlike `parallel()`, which idles every fast agent until the slowest finishes. Runs in the background with a live card, inspectable via `/agents → Workflows` or by selecting the run in FleetView. `agent()` also takes `gate: "npm test"` to verify a child by running a command (inside its worktree, when isolated) rather than asking another model, and `resume: "<label>"` to continue a child instead of re-paying its context. Scripts run in a `node:vm` sandbox on a worker thread where `Date.now()`, `Math.random()` and `eval` throw. On by default, but it stands down for company: if another extension already provides a `Workflow` or `SubagentWorkflow` tool, this one warns and disables itself for the session rather than offering the model two orchestrators. Pin it either way with `"workflowsEnabled"` in `subagents.json` or `/agents → Settings → Workflows`. A script written for Claude Code's `Workflow` tool runs here unchanged: same globals, `schema` returns a validated object exactly as it does there, `budget` is present and always reports no token target (pi has no such directive) so its `budget.total`-guarded patterns still take the branch they were written for, and nested `workflow()` composes saved workflows one level deep. **[Full guide](https://github.com/tintinweb/pi-subagents/blob/master/docs/workflows.md)**
- **Mid-run steering** — inject messages into running agents to redirect their work without restarting
- **Session resume** — pick up where an agent left off, preserving full conversation context. Persisted sessions remain resumable by ID or handle after record eviction, extension reload, or parent-session resume. Resumes detached by default and notifies you on completion, just like a fresh spawn; pass `run_in_background: false` to block and get the result inline
- **Graceful turn limits** — agents get a "wrap up" warning before hard abort, producing clean partial results instead of cut-off output
- **Case-insensitive agent types** — `"explore"`, `"Explore"`, `"EXPLORE"` all work. A type that doesn't resolve to exactly one *enabled* agent — unknown, disabled, or ambiguous between two agents differing only by case — falls back to general-purpose with a note, or is refused outright under [`fallbackSubagent: none`](#persistent-settings)
- **Fuzzy model selection** — specify models by name (`"haiku"`, `"sonnet"`) instead of full IDs, with automatic filtering to only available/configured models
- **Context inheritance** — optionally fork the parent conversation into a sub-agent so it knows what's been discussed
- **Persistent agent memory** — three scopes (project, local, user) with automatic read-only fallback for agents without write tools
- **Git worktree isolation** — run agents in isolated repo copies; changes auto-committed to branches on completion
- **Skill preloading** — inject named skills into agent system prompts, discovered from `.pi/skills/`, `.agents/skills/`, and global locations (Pi-standard `<name>/SKILL.md` directory layout supported)
- **Tool denylist** — block specific tools via `disallowed_tools` frontmatter
- **Styled completion notifications** — background agent results render as themed, compact notification boxes (icon, stats, result preview) instead of raw XML. Expandable to show full output. Group completions render each agent individually
- **Event bus** — lifecycle events (`subagents:created`, `started`, `completed`, `failed`, `steered`, `compacted`) emitted via `pi.events`, enabling other extensions to react to sub-agent activity
- **Cross-extension RPC** — other pi extensions can spawn, stop, and join subagents via the `pi.events` event bus (`subagents:rpc:ping`, `subagents:rpc:spawn`, `subagents:rpc:stop`, `subagents:rpc:consume`). Standardized reply envelopes with protocol versioning. Emits `subagents:ready` on session start. **[Full reference](https://github.com/tintinweb/pi-subagents/blob/master/docs/rpc.md)**
- **Schedule subagents** — pass `schedule` to the `Agent` tool to fire on cron / interval / one-shot. Session-scoped jobs with PID-locked persistence; results land via the same `subagent-notification` followUp path as manual background completions; manage via `/agents → Scheduled jobs`
- **Model scope enforcement** — opt-in validation that subagent model choices stay within your pi `enabledModels` allowlist (sourced from `/scoped-models`, with both global and project-local pi settings honored). Caller-supplied out-of-scope → hard error to orchestrator; frontmatter-pinned out-of-scope → warning + runs anyway (frontmatter authoritative). Toggle via `/agents → Settings → Scope models`

## Install

```bash
pi install npm:@tintinweb/pi-subagents
```

Or load directly for development:

```bash
pi -e ./src/index.ts
```

Requires pi **0.84.0 or newer**: the [`SubagentWorkflow`](#subagentworkflow) tool builds on `constrainedSampling` (pi 0.82.0) and pi-tui's `stripTerminalSequences` (0.84.0). The `peerDependencies` range declares it, so npm flags an older pi at install time.

### Other hosts

This extension is developed and tested against [pi](https://pi.dev).

Third-party adapters report running it elsewhere. These are maintained independently of this project: not tested here, not covered by our CI, and compatibility may break with any release.

- **DeepSeek Harness (`dsh`)** — via an adapter that maps pi's host API onto native DSH agents. Details and reports: [#258](https://github.com/tintinweb/pi-subagents/issues/258)

## Quick Start

The parent agent spawns sub-agents using the `Agent` tool:

```
Agent({
  subagent_type: "Explore",
  prompt: "Find all files that handle authentication",
  description: "Find auth files",
  run_in_background: true,
})
```

Agents run in the background by default: the call returns an ID immediately and notifies you on completion, carrying a preview of the result (use `get_subagent_result` for the full text). Pass `run_in_background: false` to block until the agent finishes and get its full output inline.

### Scheduling

Add a `schedule` field to register the agent to fire later instead of running now:

```
Agent({
  subagent_type: "Explore",
  prompt: "Look at recent commits and summarize what changed since last week",
  description: "Weekly commit review",
  schedule: "0 0 9 * * 1",   // 9am every Monday (6-field cron)
})
```

Schedule formats:

- **Cron** — 6-field (`second minute hour day-of-month month day-of-week`), e.g. `"0 0 9 * * 1"` for 9am every Monday, `"0 */15 * * * *"` for every 15 minutes.
- **Interval** — `"5m"`, `"1h"`, `"30s"`, `"2d"`. Fires repeatedly at that interval.
- **One-shot relative** — `"+10m"`, `"+2h"`, `"+1d"`. Fires once at that future time.
- **One-shot absolute** — full ISO timestamp, e.g. `"2026-12-25T09:00:00.000Z"`.

When a schedule fires, the spawn runs in background and its completion notification arrives in the conversation through the same `subagent-notification` followUp path as a manually-spawned background agent — your parent agent reasons about the result the same way.

Schedules are **session-scoped**: they reset on `/new` and restore on `/resume`. List and cancel via `/agents → Scheduled jobs` (creation is the `Agent` tool's job — there is no parallel manual-create wizard). Storage at `<cwd>/.pi/subagent-schedules/<sessionId>.json` with PID-based file locking for cross-instance safety.

**Disable the feature entirely**: `/agents → Settings → Scheduling → disabled` removes `schedule` from the `Agent` tool spec (no LLM-context cost), hides the menu entry, and stops any active scheduler. The schema-level removal takes effect on the next pi session; the runtime kill is immediate. Re-enable from the same menu.

Restrictions:
- `schedule` cannot be combined with `inherit_context` (no parent conversation exists at fire time) or `resume` (schedules create fresh agents).
- `run_in_background: false` is refused — scheduled jobs always run in the background. Omitting it, or passing `true`, is fine.
- Scheduled fires bypass the `maxConcurrent` queue so a 5-minute interval cannot be deferred behind long-running manual agents.
- **Headless `pi -p` doesn't wait for scheduled subagents.**

## UI

The extension renders a persistent widget above the editor showing active agents. By default it shows background runs only (`widgetMode: background`) — foreground agents already render inline as the `Agent` tool result, so the widget would otherwise double-render them. Switch to `all` (every agent) or `off` (hide the widget) via `/agents → Settings → Widget`:

```
● Agents
├─ ⠹ Agent  Refactor auth module · ↻5≤30 · 5 tool uses · 33.8k token (62%) · 12.3s
│    ⎿  editing 2 files…
├─ ⠹ Explore  Find auth files · ↻3 · 3 tool uses · 12.4k token (8%) · 4.1s
│    ⎿  searching…
├─ ⠹ Agent  Long-running task · ↻42 · 38 tool uses · 91.0k token (84% · ⇊2) · 2m17s
│    ⎿  reading…
└─ 2 queued
```

The token field is annotated with two optional signals inside parens:
- **`NN%`** — context-window utilization (color-coded: <70% dim, 70–85% warning, ≥85% error). Omitted when the model has no declared `contextWindow`, or briefly right after compaction.
- **`⇊N`** — number of times the session has compacted, when > 0. Stays dim; the percent's color carries urgency.

### FleetView

While subagents are running, a Claude Code-style navigable list renders **below** the editor:

```
  esc to interrupt · ← for agents · ↓ to manage

  ● main
  ○ workflow         audit-src                    12/40 agents · 32s · ↓ 26.4k tokens
  ○ general-purpose  Sleep then report 1                                11s · ↓ 13.1k tokens
  ○ general-purpose  Sleep then report 2                                11s · ↓ 13.1k tokens
                                                                                   ↓ 3 more
```

Running [workflows](#subagentworkflow) appear as a single `workflow` row above the agents, carrying their agent counts in place of a description. `Enter` on one opens the same two-pane inspector `/agents → Workflows` does, rather than a conversation overlay. A run's own agents are *not* listed separately — they belong to the run, which reports for them, so they are filtered out of the fleet list, the above-editor widget, the `/agents` menus and `@handle` resolution exactly as nested children are. They are also outside the `maxConcurrent` pool: the run has its own concurrency cap, and routing a fan-out through the session pool as well would let one workflow starve everything else. The agents are ordered earliest-launched first, and only agents you can actually open are shown (pending/queued agents with no session yet appear once they start). At an **empty prompt**, press `↓` (or `←`) to move focus from the prompt into the list — the selected row is marked `●`, the rest `○`. The selected row renders in the theme's primary text color rather than the muted/dim treatment of the others; an agent with a configured `color` shows its badge there too, bolded. `↑`/`↓` move the selection, `Enter` opens the selected agent's live conversation overlay (it auto-updates as the agent works), and `Esc` (or `↑` above `main`) returns to the prompt. Selecting `main` returns to the normal view. Inside the overlay, press `Enter` to steer the running agent — type a message and `Enter` to send it (`Esc` or an empty submit returns), and it redirects the agent the same way the `steer_subagent` tool does. A viewer stays open when its agent finishes so you can read the final output, and finished agents linger in the list for a few seconds before dropping out. Typing anything at a non-empty prompt behaves normally — the list only captures arrow keys when the prompt is empty. Disable it entirely via `/agents → Settings → Fleet view`.

### Agent mentions

Subagents are addressable. Every agent has a typeable handle — the agent type, lowercased, numbered when instances collide (`explore`, `explore-2`) — and `@handle <message>` at the prompt talks to that agent, whatever state it happens to be in. Type `@` to pick one:

```
❯ @
  @auth-audit     send message · Explore · running · audit the auth flow
  @explore-2      send message · running · find flaky tests
  @code-review    resume · code-review · check the diff
  @plan           start agent · Software architect agent for designing implementation plans.
  index.ts        src/index.ts                        ← pi's own file rows, still there
  index.d.ts      dist/index.d.ts
```

The handle names the **agent**, not one process, so a single syntax covers its whole lifecycle:

| State | `@explore fix the flaky test` does |
|-------|-----------------------------------|
| running or queued | sends the message into its conversation, exactly as `steer_subagent` would |
| finished | **resumes** it in the background from its existing session, continuing where it left off |
| finished long ago, record gone | **reopens** its session from disk and continues there |
| never started | **starts** it — by default, through a clone of this conversation ([below](#starting-a-new-agent)) |

No turn is ever spent in the main conversation, and nothing about the mention enters the chat. The answer comes back as the ordinary background-completion notification, so the main model can relay it.

#### Starting a new agent

Claude Code does not start a mentioned agent itself. `@agent-<type>` becomes an *attachment* appending a `<system-reminder>` to your prompt — "the user has expressed a desire to invoke the agent X; please invoke the agent appropriately, passing in the required context to it" — and the main model makes the tool call. There is no tool forcing and no allowed-tools narrowing: the mention constrains *which* agent, not what it is told. So the model writes the agent's prompt, giving it the conversation context a cold spawn lacks.

The cost is a visible turn — the model's reasoning and its tool block, narrating a decision you already made by typing the handle. This extension keeps the mechanism and moves it off-screen. The conversation is copied into a throwaway in-memory session, that clone takes the turn holding only the `Agent` tool, and what it starts is an ordinary top-level agent:

```
@cyan whats your favorite color        →  (nothing in the chat)
  └─ clone of this conversation, off-screen
       └─ Agent(subagent_type: "cyan", prompt: …)
            ▸ Cyan Agent   favorite color        ← widget, fleet row, handle
```

It is a literal clone — the session's own entries and the same system prompt, not [`inherit_context`](#agent-frontmatter)'s text rendering of them — taken from memory and compaction-aware, so what the copy reads is what the main model is working from. The clone gets one tool and one job; it cannot read, write or run anything, because an invisible turn with the full toolset could do invisible work. The agent it starts is attributed to the *real* session, so its transcript and `rootSessionId` land where they would have anyway, and it carries no `tool-use-id` — the main conversation never issued one.

| Mode | `@plan sketch the migration`, with no Plan agent running |
|------|----------------------------------------------------------|
| `model` (default) | a clone of this conversation takes the turn off-screen and calls `Agent`, so the agent starts with a prompt **written from the conversation**. Nothing reaches the chat but a `Prompting @plan…` toast — the wording marks the wait for that turn, where `direct`'s `Started @plan` means it is already running |
| `direct` | the agent starts here, immediately, with your message verbatim as its prompt. No model call at all, so no latency before it begins |
| `off` | `@` means only "attach a file" again |

Either way the started agent honours its own frontmatter — `model:`, `thinking:`, `max_turns:` all apply, since neither path passes them and the agent's config wins. Mentioning something as the very first thing in a session works: there is simply no history to carry, and the clone still runs on your model and system prompt. If it cannot deliver at all — a model can always answer in prose instead of calling the tool — the agent is started directly with your text and the toast says so, rather than leaving you with nothing running.

`model` is also the only mode that works outside the TUI: `pi -p '@plan the migration'` clones, spawns, and reports through the normal completion path, where a direct start would have detached the agent and printed nothing. Messaging and resuming stay TUI-only for that reason, in both modes.

Two things to weigh against `direct`: the clone re-sends the whole conversation, and the agent does not start until that turn finishes.

**Named agents.** The `Agent` tool takes an optional `name`, so the orchestrator can call one `auth-audit` instead of leaving you to tell `@explore-2` from `@explore-3`. A name is *additive*: the type-derived handle is still assigned, so `@explore` keeps reaching that agent rather than starting a second one beside it. Both names share one namespace — an alias can never shadow a live handle or the reverse — and the popup shows one row per agent, under its alias, with the type moved into the description. `steer_subagent` and `get_subagent_result` accept a handle too, so you and the model address agents the same way.

**Resuming much later.** Because subagent sessions are persisted by default ([`rememberAgents`](#persistent-settings)), a handle keeps working after the agent's in-memory record is evicted: `@explore anything else?` reopens the conversation from disk. Only the *definition* is re-resolved, so a continuation runs under the agent type's current frontmatter, not the one the first run used. If the type has since been deleted or disabled, the resume is refused rather than falling back to another agent — re-enable it and the handle works again. Names from an evicted agent stay reserved, so a later Explore becomes `explore-2` rather than shadowing something you can still reach; the 100 most recent are kept, and all of them are forgotten on `/new` and session switch. A resumed agent takes those names back, so `@explore` keeps meaning the same conversation. An agent whose session was only ever in memory leaves nothing to reopen, and the mention starts a fresh one instead; if the session file has since been deleted, the mention says so and frees the handle rather than silently sending your message to a new agent.

The grammar mirrors Claude Code's, and is deliberately narrow so nothing gets swallowed by accident:

| Input | Goes to |
|-------|---------|
| `@explore fix the flaky test` | the `explore` agent |
| `@agent-explore fix the flaky test` | the same agent — Claude Code's manual spelling, accepted as a synonym |
| `@main @explore is not a mention` | the main model, with `@main ` stripped — the escape hatch |
| `@explore` (no message) | the main model — a bare handle is never a send |
| `hey @explore look at this` | the main model — only a **leading** mention is routed |
| `@src/index.ts summarize this` | the main model, with pi's normal file attachment |
| `@nosuchagent hello` | the main model, verbatim — no agent, no type, no interception |

While an agent is live its handle addresses *it*, so `@explore` never starts a second Explore alongside a running one — use the `Agent` tool for deliberate parallelism. `@<agent-id>` works too. `main` is reserved and can never be an agent's handle (a type slugging to it gets `main-2`); handles are capped at 64 characters. A handle written as typed always wins over the `@agent-` form, so an agent genuinely called `agent-explore` stays reachable. [Nested subagents](#nested-subagents) are not addressable — they are hidden from every top-level surface and only their owner may steer them, so a handle that would name one starts a fresh top-level agent instead of reaching through that boundary. Suggestions list live agents first, then resumable ones, then startable types — and then pi's own file rows, in the same popup: `@` stays the file picker it always was, and the handles are added to it rather than replacing it. Disable the whole thing via `/agents → Settings → Agent mentions`.

A `direct`-mode start takes the non-tool spawn path shared with the scheduler and cross-extension RPC, so — like those — it writes no `.output` transcript. That is the trade for skipping the model call: a `model`-mode start goes through the real `Agent` tool and keeps everything. Live tool activity and the turn counter are *not* part of that trade — a direct start renders them like any other agent. A mention-*resumed* agent goes through the full resume wiring and keeps both in either mode.

Individual agent results render Claude Code-style in the conversation:

| State | Example |
|-------|---------|
| **Running** | `⠹ ↻3≤30 · 3 tool uses · 12.4k token (8%)` / `⎿ searching, reading 3 files…` |
| **Completed** | `✓ ↻8 · 5 tool uses · 33.8k token (62%) · 12.3s` / `⎿ Done` |
| **Wrapped up** | `✓ ↻50≤50 · 50 tool uses · 89.1k token (84% · ⇊2) · 45.2s` / `⎿ Wrapped up (turn limit)` |
| **Stopped** | `■ ↻3 · 3 tool uses · 12.4k token (8%)` / `⎿ Stopped` |
| **Error** | `✗ ↻3 · 3 tool uses · 12.4k token (8%)` / `⎿ Error: timeout` |
| **Aborted** | `✗ ↻55≤50 · 55 tool uses · 102.3k token (95% · ⇊3)` / `⎿ Aborted (max turns exceeded)` |

Completed results can be expanded (ctrl+o in pi) to show the full agent output inline.

By default, foreground and background agents each stream their full conversation to a per-subagent transcript — a JSON-lines file at `<os-tmpdir>/pi-subagents-<uid>/<cwd>/<session>/tasks/<agent-id>.output` (owner-only `0700`, cleared on reboot). Set `output_transcript: false` on a custom agent to write no transcript path or file for it, or set `outputTranscript: false` in `subagents.json` to make transcripts opt-in for the whole project (frontmatter overrides the project default). This governs **only** the transcript: it is independent of `persist_session` (the pi session on disk), and it does not affect `isolation: worktree` (which commits the agent's work to a git branch) or `memory:` (durable files) — set those accordingly if the goal is to keep a run off disk entirely. Background agent completion notifications render as styled boxes:

```
✓ Find auth files completed
  ↻3 · 3 tool uses · 12.4k token · 4.1s
  ⎿  Found 5 files related to authentication...
  transcript: /tmp/pi-subagents-501/home-user-project/sess-1/tasks/agent-abc123.output
```

Group completions render each agent as a separate block. The LLM receives structured `<task-notification>` XML for parsing, while the user sees the themed visual.

## Default Agent Types

| Type | Tools | Model | Prompt Mode | Description |
|------|-------|-------|-------------|-------------|
| `general-purpose` | all 7 | inherit | `append` (parent twin) | Inherits the parent's full system prompt — same rules, CLAUDE.md, project conventions |
| `Explore` | read, bash, grep, find, ls | haiku (falls back to inherit) | `replace` (standalone) | Fast codebase exploration (read-only) |
| `Plan` | read, bash, grep, find, ls | inherit | `replace` (standalone) | Software architect for implementation planning (read-only) |

The `general-purpose` agent is a **parent twin** — it receives the parent's entire system prompt plus a sub-agent context bridge, so it follows the same rules the parent does. Explore and Plan use standalone prompts tailored to their read-only roles.

Default agents can be **ejected** (`/agents` → select agent → Eject) to export them as `.md` files for customization, **overridden** by creating a `.md` file with the same name (e.g. `.pi/agents/general-purpose.md`), or **disabled** per-project with `enabled: false` frontmatter.

## Custom Agents

Define custom agent types by creating `.md` files. The frontmatter `name:` is the `subagent_type` and dispatch identity, falling back to the filename when absent; `display_name` only changes the UI label. Claiming a default agent's name overrides it.

Agents are discovered from three locations (higher priority wins):

| Priority | Location | Scope |
|----------|----------|-------|
| 1 (highest) | `.pi/agents/<name>.md` | Project — pi's config dir; authoritative, and where `/agents` writes |
| 2 | `.agents/agents/<name>.md` | Project — the shared cross-tool `.agents` workspace (same convention as `.agents/skills/`) |
| 3 | `$PI_CODING_AGENT_DIR/agents/<name>.md` (default `~/.pi/agent/agents/<name>.md`) | Global — available everywhere |

Project-level agents override global ones with the same name, so you can customize a global agent for a specific project. If both project locations define the same name, **`.pi/agents/` wins** — `.pi` stays the project authority; `.agents/agents/` is an additional read location for projects that keep their agent assets in the `.agents` workspace. The global location follows the upstream `PI_CODING_AGENT_DIR` env var — set it to relocate all pi-coding-agent state (agents, skills, settings) to a custom directory. An agent's name is its frontmatter `name:`, falling back to the filename, so two files can now claim the same one — the later load wins, and the warning below names the file that took over.

An unreadable or unparseable agent file is skipped, not fatal — a warning names the file and the error. If it was overriding a same-named agent, a second line names the file that loads instead. Set `strictAgentFiles: true` in `subagents.json` (or `/agents → Settings → Strict agent files`) to fail startup on a broken file instead; mid-session reloads still only warn.

### Example: `.pi/agents/auditor.md`

```markdown
---
color: red
description: Security Code Reviewer
tools: read, grep, find, bash
model: anthropic/claude-opus-4-6
thinking: high
max_turns: 30
---

You are a security auditor. Review code for vulnerabilities including:
- Injection flaws (SQL, command, XSS)
- Authentication and authorization issues
- Sensitive data exposure
- Insecure configurations

Report findings with file paths, line numbers, severity, and remediation advice.
```

Then spawn it like any built-in type:

```
Agent({ subagent_type: "auditor", prompt: "Review the auth module", description: "Security audit" })
```

### Frontmatter Fields

All fields are optional — sensible defaults for everything.

| Field | Default | Description |
|-------|---------|-------------|
| `description` | filename | Agent description shown in tool listings |
| `name` | filename | **The agent's type** — what `subagent_type` and `@handle` address. Claude Code's rule: the filename doesn't have to match, so `blubb.md` with `name: code-review` dispatches as `code-review`. Omit it and the filename is used. Any value works except one containing `:`, which Claude Code reserves for plugin-scoped identifiers — such a file is skipped with a warning. Two files may declare the same name; the later load wins, as a filename clash always did |
| `display_name` | the type | Label shown in the UI (widget, agent list, badges) — cosmetic only, and independent of `name`. Claude Code has no equivalent; a file that sets only `name` badges as its type, unchanged |
| `color` | — | Background color for the agent name badge in the Agent tool header, widget, FleetView, and conversation viewer. Supports Claude Code's `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink`, `cyan` (the values its own default theme uses); quoted six-digit hex such as `"#8B5CF6"`; and Agency Agents aliases (`amber`, `teal`, `indigo`, `gold`, `neon-green`, `neon-cyan`, `metallic-blue`, `violet`, `rose`, `lime`, `gray`/`grey`, `fuchsia`, `slate`, `navy`). Badge text is black or white, whichever clears 4.5:1 against the rendered background — Claude Code uses one inverse color for every badge. Invalid values render no badge and preserve each surface's existing theme foreground |
| `tools` | all 7 | Which tools the agent can call. Built-in names (`read, grep, …`), `*` / `all` (all built-ins), `none`, and `ext:<extension>` / `ext:<extension>/<tool>` selectors for extension tools. See [Tool & extension scoping](#tool--extension-scoping) below |
| `extensions` | `true` | Which extensions to load for the agent. `true` (all defaults), `false` (none), or an explicit list: `[mcp, "/abs/path.ts", "*"]`. See [Tool & extension scoping](#tool--extension-scoping) below |
| `exclude_extensions` | — | Extension denylist applied after `extensions:` — exclude wins. Plain names only (case-insensitive), no paths or `*`. Useful with `extensions: true` to drop one extension (e.g. `pi-notify`) |
| `skills` | `true` | `true` inherits the parent's skills; `false` inherits none. A comma-separated list preloads **only** those skills into the system prompt and does not inherit the rest (see [Skill Preloading](#skill-preloading) for discovery locations) |
| `memory` | — | Persistent agent memory scope: `project`, `local`, or `user`. Auto-detects read-only agents |
| `disallowed_tools` | — | Comma-separated tools to deny even if extensions provide them |
| `isolation` | — | Set to `worktree` to run in an isolated git worktree, or `off` to refuse one even when the caller passes `isolation: "worktree"` (frontmatter is authoritative). `none`, `no`, and `false` are accepted spellings of `off` |
| `model` | inherit parent | Model — `provider/modelId` or fuzzy name (`"haiku"`, `"sonnet"`). Resolved tolerantly (`.`/`-` and a trailing date stamp are interchangeable) and falls back to the same model under another provider if the named one doesn't have it |
| `thinking` | inherit | off, minimal, low, medium, high, xhigh, max — actual availability depends on your pi version and model; pi clamps unsupported levels down |
| `max_turns` | unlimited | Max agentic turns before graceful shutdown. `0` or omit for unlimited |
| `persist_session` | `subagents.json` `rememberAgents` (default `true`) | Persist this subagent as a normal pi session instead of keeping the session in memory only; overrides the `rememberAgents` project default in both directions. It records its spawning session as parent, so it nests under it in `/resume`. The subagent's `.output` transcript is still written either way unless `output_transcript: false` |
| `output_transcript` | `true` (or `subagents.json` `outputTranscript`) | Write this subagent's `.output` transcript; when set, overrides the `subagents.json` `outputTranscript` default. Set `false` to write no transcript file or path. Governs only the transcript — independent of `persist_session`, `isolation: worktree`, and `memory:` |
| `session_dir` | pi default | Optional session directory when `persist_session: true`; omitted uses pi's normal session location, and relative paths resolve from the agent cwd. A session outside the parent's session directory (this override, or `isolation: worktree`) is listed separately, so it shows as a root instead of nesting |
| `allowed_subagents` | none | Opt in to scoped nested `Agent`, `get_subagent_result`, and `steer_subagent` tools. Omitted / empty / `none` / `false` = no nesting; `all` (or `"*"` / `true`) = any enabled agent; comma-separated list = only those agent types |
| `prompt_mode` | `replace` | `replace`: body is the full system prompt (no AGENTS.md / CLAUDE.md inheritance). `append`: body appended to parent's prompt (agent acts as a "parent twin" — inherits parent's AGENTS.md / CLAUDE.md) |
| `inherit_context` | `false` | Fork parent conversation into agent |
| `run_in_background` | — | Pin this agent to background (`true`) or foreground (`false`). Omit to follow `backgroundByDefault` |
| `isolated` | `false` | Hermetic specialist mode: forces `extensions: false` + `skills: false` + drops `ext:` selectors. Only built-in tools. Distinct from `isolation: worktree` (filesystem) |
| `enabled` | `true` | Set to `false` to disable an agent (useful for hiding a default agent per-project) |

Frontmatter is authoritative. If an agent file sets `model`, `thinking`, `max_turns`, `inherit_context`, `run_in_background`, `isolated`, or `isolation`, those values are locked for that agent. `Agent` tool parameters only fill fields the agent config leaves unspecified.

**Forgiving `model:` resolution.** A `model:` pin is matched against pi's model registry tolerantly, so cosmetic id variations don't silently drop the agent back to the parent's model: `.` and `-` are treated as equivalent in version numbers (`claude-haiku-4.5` ≡ `claude-haiku-4-5`), a trailing `-YYYYMMDD` date stamp is optional (`anthropic/claude-haiku-4-5-20251001` matches an undated registry id and vice-versa), and a `provider/modelId` whose named provider doesn't carry that model retries the bare id against every provider. Precedence is **exact → fuzzy under the named provider → same model under any provider → unavailable**, so an exact match always wins and dated snapshots aren't conflated. If nothing resolves, the pin can't run and the agent inherits the parent model — `/agents → Agent types` flags this case as `(unavailable, fallback: inherit)` and shows the resolved target `(→ provider/id)` when resolution lands on a different provider or version than configured. (This is distinct from [Model Scope](#model-scope) enforcement, which matches the `enabledModels` allowlist by *exact* entry.)

### Nested subagents

Nested delegation is default-off. Set `allowed_subagents` only on a non-isolated custom agent that owns a real fan-out responsibility:

```yaml
---
tools: read, grep, find
extensions: false
allowed_subagents: support-file-finder, support-callsite-tracer   # or `all`
---
```

**The allowlist is a privilege boundary, not just a routing hint.** A child runs with *its own* `tools:`, `extensions:`, and `isolated:` — the parent's restrictions are not inherited — so delegation grants the parent the union of what the listed agents can do. The read-only agent above can write and run commands through any listed agent that can, and `all` reaches every enabled agent including `general-purpose`. Choose the list as carefully as you would choose `tools:` itself; that is the main reason this is default-off.

`allowed_subagents` is runtime-enforced. A comma-separated list restricts nesting to those types; `all` (or `"*"` / `true`, matching how `extensions:` and `skills:` take booleans) allows any enabled agent; omitted, empty, `none`, or `false` means no nested tools are injected at all. Unknown, disabled, and out-of-list types are rejected rather than falling back — regardless of the project's [fallback agent](#persistent-settings) setting, so a configured fallback can never hand a nested caller an agent outside its allowlist — and a nested `model:` is validated against [Model Scope](#model-scope) exactly like a top-level spawn. Result, resume, and steering operations are ownership-scoped, so a parent can control only its own children. Nested records remain internal to that parent and do not appear in top-level tools, lifecycle events, or agent UI — so when a parent finishes, is stopped, or ends a resumed turn, its nested children are stopped with it. They do write their own `.output` transcript (subject to the same `output_transcript` gate), filed under the root session's directory alongside their ancestors', so a nested run can still be inspected after the fact. Their token usage is folded into every ancestor's totals up to the top-level agent (lifecycle events, completion notifications, `/agents`), so nested spend stays attributable at any depth even though the children themselves stay hidden. A nested result that ends `stopped`, `aborted`, or `steered` is labelled as partial, the same guarantee top-level results carry.

The hard cap is depth 2 by default: main session (0) → subagent (1) → nested child (2). Change it project-wide with `maxSubagentDepth` in `subagents.json` (or `/agents → Settings → Nested depth`); `0` or `1` turns nesting off everywhere. An agent already at the cap gets no nested tools at all — not even `get_subagent_result`, since it can never own a child. A child must independently set `allowed_subagents` to delegate again; isolated agents never receive nested tools.

Nested children occupy no concurrency slot, in either pool — their parent already holds one, and queueing them behind it would deadlock a parent waiting on its own child. The depth cap bounds how *deep* nesting goes, not how *wide*: a parent's only limit on concurrent children is that each spawn costs it a turn. Pair `allowed_subagents` with a `max_turns` on that agent if you want a hard ceiling on its fan-out.

Because a subagent session never activates this extension (that is what keeps a child from building a second agent manager, and it is why nested tools are injected directly instead), a subagent also gets none of the extension's other surfaces: no `/agents` command, no cross-extension RPC handlers, no `subagents:ready` event.

### Tool & extension scoping

`extensions:` decides **which extensions load**, `tools:` decides **which tools surface to the LLM**. They compose:

```yaml
# Default (both omitted): all extensions load, all 7 built-ins surface

tools: read, grep, find           # narrow to listed built-ins; extensions still load
tools: "*"                        # all 7 built-ins (alias: `all`)
tools: none                       # zero built-ins (alias: `""`)
tools: "*, ext:mcp/search"        # built-ins plus one extension tool

extensions: false                 # no extensions load
extensions: [mcp]                 # only mcp loads
extensions: ["*", "/abs/foo.ts"]  # all defaults plus one path-loaded extension

exclude_extensions: pi-notify     # everything except pi-notify (with extensions: true)

# Specialist: load one extension, expose only one of its tools, keep built-ins
extensions: [mcp]
tools: "*, ext:mcp/search"

isolated: true                    # hermetic: built-ins only, no extensions/skills/context
```

A few rules the examples don't make obvious:

- `extensions:` is the sole loading authority. `ext:foo` in `tools:` narrows what surfaces; it can't load `foo` on its own. Mismatches fire `extension-error:…` warnings.
- Any `ext:` entry flips extension tools to an explicit allowlist — unnamed extensions still load (handlers fire) but expose no tools. So `tools: "*, ext:mcp/search"` exposes only `search` from `mcp`, nothing from any other extension.
- Extension names match case-insensitively (`[Mcp]` = `[mcp]`); tool names in `ext:foo/bar` stay case-sensitive.
- Extensions that register tools **lazily** work too. MCP-backed extensions typically can't enumerate their tools until their servers connect, so they register from `session_start` or `before_agent_start` rather than at load. Subagent scoping is re-derived as tools appear, so these surface normally — including under `ext:` selectors, which keep narrowing correctly no matter when a tool shows up.
- Extensions bound into a subagent see **both ends** of that session's lifecycle: `session_start` when the agent starts, `session_shutdown` (reason `quit`) when its session is disposed — on quit, and when its record is evicted ~10 minutes after it finishes. Release per-session resources there; anything left armed outlives the session it belongs to. Handlers are given three seconds on quit, after which teardown proceeds regardless.
- An installed **package** extension matches by its package short name (`@scope/pi-subagents` → `[pi-subagents]`), in addition to its path-derived name (a package whose entry is `src/index.ts` also answers to `[src]`). Prefer the package name — the path-derived one is incidental.
- Plain `tools:` typos fail loudly: `tools: reed, grep` fires `tools-error:…` instead of silently producing an under-tooled agent.
- `exclude_extensions:` wins over `extensions:` and over `ext:` selectors — an excluded extension never loads and a `tools: ext:` entry can't pull it back. Plain names only (no paths, no `*`); a name matching nothing fires an `extension-error:…` warning.
- `exclude_extensions:` is **not a sandbox**: excluded extensions' factory code still executes once during loading. Exclusion suppresses their tools and their bound lifecycle hooks (`pi.on` handlers like `session_start` only fire for extensions bound to the session), but not other load-time side effects — a factory that subscribes directly to the shared `pi.events` bus stays live. Don't rely on it to contain an untrusted extension.
- Array and string forms are equivalent: `[a, b]` == `"a, b"`.

**How an agent's scope is advertised.** The Agent tool description lists every available agent with a `(Tools: …)` suffix, and that suffix is what the orchestrator reads when deciding where to route work. It describes **built-in scope only** — extension tools are resolved when the agent runs (extensions may register lazily, see above), so they can't be enumerated when the description is built:

| `tools:` | suffix |
|---|---|
| omitted, `*`, or `all` | `*` |
| a list of built-ins | that list, e.g. `read, grep` |
| `none` with `isolated: true` or `extensions: false` | `none` |
| `none`, or only `ext:` entries, with extensions loading | `no built-ins, extension tools only` |

The last two rows are separate because zero built-ins is not zero tools: `tools: none` alongside `extensions:` still surfaces every extension tool, so calling it `none` would understate what the agent can do. Note `*` doesn't enumerate extension tools either — an agent with `tools: "*, ext:mcp/search"` advertises `*`.

## Tools

### `Agent`

Launch a sub-agent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | yes | The task for the agent |
| `description` | string | yes | Short 3-5 word summary (shown in UI) |
| `name` | string | no | Memorable name for this agent (`auth-audit`), addressable as `@name` and accepted by `steer_subagent`/`get_subagent_result`. Additive — the type-derived handle is still assigned |
| `subagent_type` | string | yes | Agent type (built-in or custom) |
| `model` | string | no | Model — `provider/modelId` or fuzzy name (`"haiku"`, `"sonnet"`). Resolved tolerantly (`.`/`-` and a trailing date stamp interchangeable) with provider fallback |
| `thinking` | string | no | Thinking level: off, minimal, low, medium, high, xhigh, max (availability depends on pi version and model) |
| `max_turns` | number | no | Max agentic turns. Omit for unlimited (default) |
| `run_in_background` | boolean | no | Defaults to `true`; `false` blocks and returns the result inline |
| `resume` | string | no | Agent ID or handle to resume a previous session, including a persisted session whose in-memory record was evicted |
| `isolated` | boolean | no | No extension/MCP tools |
| `isolation` | `"off"` \| `"worktree"` | no | `worktree` runs in an isolated git worktree; `off` (the default) does not. Absent from the schema entirely when `worktreeIsolation: false` |
| `inherit_context` | boolean | no | Fork parent conversation into agent |

### `SubagentWorkflow`

Run a deterministic script that orchestrates many subagents. Returns a task id immediately; the run continues in the background and notifies on completion.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `script` | string | no | The workflow source. Must begin with `export const meta = { name, description }` |
| `scriptPath` | string | no | Path to a script file. Takes precedence over `script` and `name` |
| `name` | string | no | A saved workflow — `<name>.js` in `.pi/workflows/`, `.agents/workflows/` or `<agent dir>/workflows/`, carrying an `export const meta` declaration |
| `args` | any | no | Passed through to the script as the `args` global, verbatim |
| `resumeFromRunId` | string | no | Replay an earlier run in this session — its unchanged leading `agent()` calls return their recorded results instead of spawning |
| `title` / `description` | string | no | Accepted and ignored, as in Claude Code — a workflow is named by its `meta` block |

At least one of `script` / `scriptPath` / `name` is required; `scriptPath` wins over `script`, which wins over `name`. Each invocation's script is persisted to the session directory and its path returned, so iterating means editing that file and re-running rather than resending the source. A saved workflow reports its own file instead, so the same loop works on it — project `.pi/workflows/` shadows a same-named global one. Those directories are ordinary folders that may hold other scripts, so only files carrying the `export const meta = { name, description }` declaration are listed or resolved; naming anything else reports that it is not a workflow rather than running it. The check is a regex over the source — nothing in the file is executed to make it, and even a real parse evaluates only the `meta` object literal, in an empty `node:vm` context with a 100ms bound.

```js
export const meta = {
  name: 'auth-audit',
  description: 'Find routes missing auth checks, then verify each finding',
  phases: [{ title: 'Scan' }, { title: 'Audit' }],
}

phase('Scan')
const listing = await agent('List every route file under src/routes/. One path per line.')
const files = listing.split('\n').map(s => s.trim()).filter(Boolean)
log('auditing ' + files.length + ' files')

phase('Audit')
return await pipeline(
  files,
  file => agent(`Audit ${file} for missing auth checks.`, { label: `audit:${file}` }),
  (found, file) => agent(`Try to REFUTE this finding about ${file}: ${found}`, { label: `verify:${file}` }),
)
```

Concurrency is capped at `max(1, min(16, cpus - 2))` — the run's own limit, independent of the session's `maxConcurrent` pool, which its agents do not enter. There are 1000 agents per run and 4096 items per `parallel`/`pipeline` call.

**Full guide:** [`docs/workflows.md`](https://github.com/tintinweb/pi-subagents/blob/master/docs/workflows.md) — how the model writes the script for you, how to edit and re-run it, how to save one as a reusable named workflow, plus the complete `agent()` option reference, recipes and troubleshooting.

### `get_subagent_result`

Check status and retrieve results from a background agent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | yes | Agent ID to check |
| `wait` | boolean | no | Wait for completion |
| `verbose` | boolean | no | Include full conversation log |

Cancelling a `wait: true` call (for example, with `Esc`) stops only the wait. The background agent keeps running, and its completion notification still arrives normally.

### `steer_subagent`

Send a steering message to a running agent. The message interrupts after the current tool execution.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | yes | Agent ID to steer |
| `message` | string | yes | Message to inject into agent conversation |

## Commands

| Command | Description |
|---------|-------------|
| `/agents` | Interactive agent management menu — agent types, running agents, scheduled jobs, workflow runs, settings |

`/agents → Workflows` (shown only when [workflows](#persistent-settings) are on) opens a framed two-pane inspector over a run, with two levels of depth:

```
 audit-src
 Dynamically discover files under src/ and audit each …                    1/3 agents · 32s

 ╭ Phases ──────────┬ Discover · 1 agent ──────────────────────────────────────────────╮
 │ ❯ ✔ Discover 1/1 │ ❯ ✔ discover:src Opus 5 (1M context) · 26.4k tok             25s │
 │   2 Audit    0/2 │                                                                  │
 │   3 Verify       │                                                                  │
 │   4 Synthesize   │                                                                  │
 ╰──────────────────┴──────────────────────────────────────────────────────────────────╯
 ↑↓ select · ⏎ open · f filter · x stop · esc close · c convo
```

The overview puts the phases on the left (a phase shows its number until it finishes, then `✔`/`✘`) and the selected phase's agents on the right. `⏎` opens one: the agents move to the left pane and the right becomes that agent's **Prompt**, **Activity** and **Outcome**, with `⏎` now expanding the prompt and `esc` going back a level rather than closing. `↑↓` (or `j`/`k`) move and `f` cycles the state filter, naming it in the pane title. The dialog opens as a centered overlay, like the conversation viewer an agent row opens; the frame sizes itself to what it holds, between six rows and twenty-two, so a three-agent run is not twenty rows of nothing and a two-hundred-agent one scrolls inside the pane. Long titles truncate with `…` rather than tearing it. With more than one workflow in the session it asks which, newest first.

The run itself takes five keys, and the footer offers each only while it can actually do something:

| Key | What it does |
|-----|--------------|
| `x` | Stop the run. Live runs only — a settled one has nothing left to stop |
| `p` | Pause / resume. Pausing stops *starting* agents; ones already running are left to finish, because killing model work mid-turn throws away everything it has spent. Held time is subtracted from the run's elapsed clock |
| `s` | Skip the selected agent: its `agent()` call returns `null`, exactly as a terminal failure does, and the row renders skipped. Offered while the agent is queued or running |
| `r` | Retry the selected agent: the child is stopped and the same call runs again, so the script's `agent()` promise is still the one waiting and gets the new answer. Running agents only — once a call has settled its value is already the script's, and a re-run would have nowhere to put one. The row then reads `attempt 2 · user retry` |
| `c` | Open the selected agent's **conversation** — the same live, scrolling viewer a fleet-list row opens, over the dialog, which hides itself underneath and comes back when you close it. The one key here that shows something rather than changing the run, so it works at both levels and on an agent that has already finished; reading what a child actually did is most of why anyone opens the inspector. Offered once the child has a record to open, which excludes a queued agent and one replayed from the resume journal. Records are swept ten minutes after they finish, and the key says so rather than opening an empty viewer |

Skipping is immediate for a running agent and for one held at a pause; an agent parked behind the concurrency limit takes its skip when it reaches the front of the queue.

### CLI flags

| Flag | Description |
|------|-------------|
| `--subagents-workflow-file=<path>` | Run a workflow script at session start |

Use the `=` form. The bare `--flag value` spelling consumes the next argument, so `pi --subagents-workflow-file review.js "do the thing"` would take the prompt as the flag's value. Composes with headless mode: `pi -p --subagents-workflow-file=review.js`. With no tool call to attach to, the run renders as a session entry and its result is handed to the model as context for its next turn.

The `/agents` command opens an interactive menu:

```
Running agents (2) — 1 running, 1 done     ← only shown when agents exist
Agent types (6)                             ← unified list: defaults + custom
Create new agent                            ← manual wizard or AI-generated
Settings                                    ← max concurrency (background + foreground), max turns, grace turns, join mode
```

- **Running agents** — select one to open its live conversation viewer. While it's still running, press `Enter` to open the steering composer, then `Enter` again to send a message that redirects the agent (same mechanism as the `steer_subagent` tool; `Esc` or an empty submit returns), or press `x` (then `x` again to confirm) to stop/abort it — including **background** agents, which a global Esc can't unambiguously target (Esc still stops a blocking foreground `Agent` call). A stopped agent reports its partial output flagged as incomplete, not as a completion. `m` cycles how much of the transcript renders as Markdown — see [Viewer markdown](#persistent-settings).
- **Agent types** — unified list with source indicators: `•` (project), `◦` (global), `✕` (disabled). Each row shows the agent's model, and the highlighted agent's full description appears below the list. The model column flags `(unavailable, fallback: inherit)` when a configured model can't be resolved (it would silently inherit the parent model), and shows `(→ provider/id)` when it resolves to a different provider or version than configured. Select an agent to manage it:
  - **Default agents** (no override): Eject (export as `.md`), Disable
  - **Default agents** (ejected/overridden): Edit, Disable, Reset to default, Delete
  - **Custom agents**: Edit, Disable, Delete
  - **Disabled agents**: Enable, Edit, Delete
- **Eject** — writes the embedded default config as a `.md` file to project or personal location, so you can customize it
- **Disable/Enable** — toggle agent availability. Disabled agents stay visible in the list (marked `✕`) and can be re-enabled
- **Create new agent** — choose project/personal location, then manual wizard (step-by-step prompts for name, tools, model, thinking, system prompt) or AI-generated (describe what the agent should do and a sub-agent writes the `.md` file). Any name is allowed, including default agent names (overrides them)
- **Settings** — configure max concurrency (background and foreground), default max turns, grace turns, and join mode at runtime

## Graceful Max Turns

Instead of hard-aborting at the turn limit, agents get a graceful shutdown:

1. At `max_turns` — steering message: *"Wrap up immediately — provide your final answer now."*
2. Up to 5 grace turns to finish cleanly
3. Hard abort only after the grace period

| Status | Meaning | Icon |
|--------|---------|------|
| `completed` | Finished naturally | `✓` green |
| `steered` | Hit limit, wrapped up in time | `✓` yellow |
| `aborted` | Grace period exceeded | `✗` red |
| `stopped` | User-initiated abort | `■` dim |

## Concurrency

There are two independent pools.

**Background** (`maxConcurrent`, default 10). Excess agents are automatically queued and start as running agents complete. The widget shows queued agents as a collapsed count. Since agents run in the background by default, nearly every spawn takes a slot; the limit was raised from 4 so that ordinary parallel fan-outs don't queue.

**Foreground** (`maxConcurrentForeground`, default `0` = unlimited). Off by default, so nothing changes unless you set it. pi dispatches a message's tool calls through `Promise.all`, so several `Agent` calls with `run_in_background: false` in one message have always started at once — this bounds that. Useful mainly with local models, where parallel agents thrash the prompt cache ([#253](https://github.com/tintinweb/pi-subagents/issues/253)). A queued foreground agent appears in `/agents → Running agents` as `queued` and can be stopped there; its `Agent` call says so while it waits and then returns its result normally.

The two are deliberately **not** one limit. A foreground agent blocks the parent anyway — the parent could have done that work itself without paying a slot — so charging it to the background pool would let a saturated pool starve the main session.

The foreground pool does not cover `resume`: a foreground resume reopens an existing session and never reaches the spawn path, so several blocking resumes in one message can still run at once. A *background* resume does take a background slot and queues behind them like any other background agent.

Nested children and a [workflow](#subagentworkflow)'s agents are outside the pool entirely. A nested child would deadlock behind a parent waiting on it; a workflow already bounds its own fan-out at `max(1, min(16, cpus - 2))`, and counting its agents twice would let one run fill the session's pool and starve everything else.

## Join Strategies

When background agents complete, they notify the main agent. The **join mode** controls how these notifications are delivered. It applies only to background agents.

| Mode | Behavior |
|------|----------|
| `smart` (default) | 2+ background agents spawned in the same turn are auto-grouped into a single consolidated notification. Solo agents notify individually. |
| `async` | Each agent sends its own notification on completion (original behavior). Best when results need incremental processing. |
| `group` | Force grouping even when spawning a single agent. Useful when you know more agents will follow. |

**Timeout behavior:** When agents are grouped, a 30-second timeout starts after the first agent completes. If not all agents finish in time, a partial notification is sent with completed results and remaining agents continue with a shorter 15-second re-batch window for stragglers.

**Configuration:**
- Configure join mode in `/agents` → Settings → Join mode

## Model Scope

**Opt-in:** off by default. Enable via `/agents → Settings → Scope models`.

When on, each subagent spawn's effective model is validated against pi's own `enabledModels` list (configured via pi's `/scoped-models` UI). pi-subagents reads that list; it doesn't manage it. Both of pi's settings files are honored: global `~/.pi/agent/settings.json` and project-local `<cwd>/.pi/settings.json`. **Project overrides global** — mirrors pi's `SettingsManager` deep-merge, so a tighter per-project scope (hand-edited into the project settings) is respected.

**Out-of-scope handling depends on source:**

| Model source | Out-of-scope behavior |
|---|---|
| Caller-supplied via `Agent({ model: "..." })` | Hard error returned to the orchestrator, listing allowed models |
| Caller-supplied via cross-extension RPC (`subagents:rpc:spawn`, e.g. pi-tasks `TaskExecute`) | Hard error returned to the calling extension, listing allowed models |
| Pinned in agent frontmatter | Warning toast + the pinned model runs (frontmatter is authoritative) |
| Parent-inherited (neither set) | Warning toast + parent's model runs |

**Design:** `scopeModels` is a guardrail against the orchestrator picking unexpected models at runtime, not a hard policy against user-level config. The "frontmatter is authoritative" guarantee from v0.5.1 still holds for `model:` — caller params can't override frontmatter, and frontmatter pins run even when out of scope (with a visible warning).

**Nested spawns** ([nested subagents](#nested-subagents)) apply the same table against the parent's config root. The hard-error case is identical; the warning cases proceed silently, since a subagent session has no UI to toast to.

**Pattern format:** only exact `provider/modelId` entries are honored (e.g. `anthropic/claude-haiku-4-5-20251001`). Glob patterns (`*sonnet*`), bare model IDs, and `:thinking` suffixes — which pi itself supports — are silently dropped here. pi's `/scoped-models` picker writes exact entries, so the limitation is invisible if you configure scope through the UI. Hand-edited globs produce an empty allowed set (scope check becomes a no-op).

**No-op safety:** if `enabledModels` is missing or empty in pi's settings, scope check skips entirely — no false positives, no spurious errors.

## Persistent Settings

Runtime tuning values set via `/agents` → Settings (max concurrency, max foreground concurrency, default max turns, grace turns, nested depth, fallback agent, default join mode, scheduling on/off, scope models on/off, disable defaults on/off, strict agent files on/off, agent mentions on/off, output transcript on/off, tool description full/compact/custom, widget all/background/off, usage reporting on/off, cost display on/off, model display on/off, viewer markdown off/assistant/all) persist across pi restarts. Two files, merged on load:

- **Global:** `~/.pi/agent/subagents.json` — your machine-wide defaults. Edit by hand; the `/agents` menu never writes here.
- **Project:** `<cwd>/.pi/subagents.json` — per-project overrides. Written by `/agents` → Settings.

**Precedence:** project overrides global on any field present in both. Missing fields fall back to the hardcoded defaults (max concurrency `10`, max foreground concurrency `0` = unlimited, default max turns unlimited, grace turns `5`, nested depth `2`, join mode `smart`, defaults enabled).

**Nested depth** (`maxSubagentDepth`, default `2`): the hard ceiling on [nested delegation](#nested-subagents), counted from the main session (main = 0, its subagents = 1). `0` or `1` disables nesting project-wide regardless of any agent's `allowed_subagents`. Read when a subagent session is built, so a change applies to agents started after it.

**Fallback agent** (`fallbackSubagent`, default `general-purpose`): the agent used when a caller-supplied `subagent_type` doesn't resolve to exactly one enabled agent — unknown, disabled, or ambiguous because two agents differ only by case. Name any enabled agent to route those calls there instead, or set `none` for **strict**, fail-closed dispatch: the call is refused with an error listing the available types, and nothing spawns. Strict mode matters most for background and scheduled calls, which would otherwise start executing a substituted agent before the caller learns anything. Also settable from `/agents → Settings → Fallback agent`. The boolean `false` is accepted as a spelling of `none`, because it would otherwise be dropped as the wrong type and silently leave the permissive default in place. Every other value is read as an agent name, so a mistaken `off` fails loudly at dispatch rather than meaning one thing in the settings file and another in the resolver. A fallback agent that is itself unknown or disabled is a misconfiguration and is reported rather than quietly replaced. Note the default is unchanged and stays permissive by design: with `disableDefaultAgents` and no `general-purpose` of your own, an unresolvable type still resolves to a built-in config carrying *all* tools — set `none` (or name one of your own agents) to close that.

**Strict agent files** (`strictAgentFiles`, default `false`): when on, an unreadable or unparseable [agent file](#custom-agents) aborts extension load at startup and names the file, instead of being skipped with a warning — so a checked-in `.pi/agents/` can't silently fall through to a same-named agent from another location. Startup only: the mid-session reload that runs on each `Agent` call keeps warning either way, since a bad edit shouldn't kill a session on an unrelated spawn. Also settable from `/agents → Settings → Strict agent files`.

**Disable defaults** (`disableDefaultAgents`, default `false`): when on, the three built-in agents (general-purpose, Explore, Plan) are not registered — only your project/global custom agents are advertised and spawnable. User-defined agents are unaffected, including ones that override a default by name. The Agent tool's type list updates on the next pi session (the tool schema is registered at startup).

**Agent mentions** (`agentMentions`, default `"model"`): whether [`@handle message`](#agent-mentions) at the prompt addresses that subagent instead of the main model — messaging, resuming or starting it — and whether `@` offers agents alongside pi's file completion. `"model"` and `"direct"` differ only in [who starts an agent that isn't running](#starting-a-new-agent): an off-screen clone of this conversation, via a `<system-reminder>` and a real `Agent` call, or this extension, immediately and with no model call. Messaging and resuming are direct in both. `"off"` gates all three actions plus the suggestion list, so `@` means only "attach a file" again and every `@…` prompt reaches the main model verbatim. Toggle via `/agents → Settings → Agent mentions`; applied live. The booleans this setting used to take are still read — `true` as `"model"`, `false` as `"off"`.

**Background by default** (`backgroundByDefault`, default `true`): what an `Agent` call that doesn't say means. On — following Claude Code — the agent runs detached, the call returns its ID immediately, and a completion notification carries a preview of the result (`get_subagent_result` for the full text). Set `false` to restore the previous behaviour, where an unqualified spawn blocked the turn and returned its output inline. An explicit `run_in_background` on the call, or in an agent file's frontmatter, overrides this in both directions; the setting only decides what "unspecified" means. **Top-level only** — a nested spawn (an agent spawning its own) always defaults to foreground, because a detached child is stopped when its parent settles and has no notification path of its own. Toggle via `/agents → Settings → Background by default`; applied live.

**Remember agents** (`rememberAgents`, default `true`): whether subagents persist their pi session, which lets [`@handle`](#agent-mentions) and `Agent({ resume })` reopen an agent's conversation after record eviction, extension reload, or parent-session resume. Two visible consequences of the default: top-level subagents write a session file, and they nest under the session that spawned them in pi's `/resume`. Agents spawned by another agent are excluded — they get no handle, so nothing could reopen their transcript. A custom agent's `persist_session` frontmatter overrides this per agent, in both directions. Toggle via `/agents → Settings → Remember agents`; with it off, handles expire with their record (roughly ten minutes past completion) and `@explore` then starts a fresh agent rather than resuming — the behaviour before this setting existed.

**Output transcript** (`outputTranscript`, default `true`): the project/global default for writing each subagent's `.output` transcript. Toggle via `/agents → Settings → Output transcript`, or set `false` in `subagents.json` to make transcripts opt-in project-wide — useful when run transcripts shouldn't sit on disk for backup or DLP tooling to pick up. A custom agent's `output_transcript` frontmatter overrides this per agent. Applied live at spawn time. Governs only the transcript, not `persist_session`, worktree commits, or memory files.

**Worktree isolation** (`worktreeIsolation`, default `true`): whether `isolation: "worktree"` may create a worktree at all. Toggle via `/agents → Settings → Worktree isolation`, or set `false` in `subagents.json` on a repo where a copy costs too much time or disk. Off, the `Agent` tool's `isolation` parameter is dropped from the schema entirely and the bullet describing it leaves the tool description with it — nothing to pass, and no context spent describing it — and worktrees are refused on every other path too (agent files, scheduled jobs, cross-extension RPC). The `/agents` agent-file generator stops offering the `isolation:` frontmatter field too, so a generated agent can't bake in a request that would be refused. A requested worktree is downgraded to a normal run rather than failing the call, since declining one is the point; there is deliberately no note on the result, which is exactly why the prose has to go when the parameter does. The refusal applies immediately; the parameter and its prose appear or disappear on the next pi session. See [Turning worktrees off](#turning-worktrees-off).

**Report usage to session** (`reportUsage`, default `false`): whether subagent spend is added to *this* session's own totals. Subagents run in their own pi sessions, so by default pi's footer, statusline and `/cost` count only what the main model spent — a session that delegated most of its work reads as nearly free. Turn it on and each `Agent` / `get_subagent_result` / `steer_subagent` result carries the spend accumulated since the last one, which pi folds into `getSessionStats()`; `/cost` attributes it to the **Tools/summaries** bucket. Toggle via `/agents → Settings → Report usage to session`; applied live.

Three things worth knowing about the numbers. Every token component is reported, `cacheRead` included — the cached prefix genuinely is re-read and re-billed on every call, and pi counts it the same way for the session's own messages, so withholding it would make a subagent's rows count differently from every other row in one total. (The extension's *own* token displays still leave it out, which is a different question: there it inflates a reading of how much work was done.) Cost is pi's own per-message figure, priced from the model's listed rates; a model pi has no rates for contributes zero rather than an estimate. And the context-window percentage is untouched: pi derives it from assistant messages alone, so a delegating session's context doesn't appear to fill up faster. Agents that finish in the background have no tool result of their own to ride on, so their spend is carried by the next one you make — the footer catches up on the following call, not the moment they finish.

**Show cost** (`showCost`, default `false`): whether the subagent surfaces print an estimated cost beside their token counts — the widget (running *and* finished lines), [FleetView](#fleetview), the conversation viewer, foreground results, `get_subagent_result`, and completion notifications:

```text
├─ ⠹ Explore  inspect code · ↻3 · 8.2k token · ~$0.0042 · 4.1s
✓ Explore  inspect code · ↻8 · 5 tool uses · ~$0.0181 · 12.3s
```

When several background agents finish together, their notification is topped with the batch total (`3 agents · 45.1k token · ~$0.042`) so the figures don't have to be added up by hand.

The `~` marks it as pi's estimate rather than a billed figure. **A cost is shown only when there is one to show:** a model pi has no pricing data for reports zero, and `$0.00` beside its tokens would say the run was measured and found free rather than never measured — so nothing is printed at all, on every surface. For the same reason a real cost too small to render reads `<$0.0001`. Figures keep cents at minimum and four decimals at most (`~$0.0042`, `~$0.05`, `~$1.24`) — rounding everything to cents would print the same number for runs that differed fourfold.

Independent of `reportUsage`: this one is what you read, that one is what your session counts. Toggle via `/agents → Settings → Show cost`; applied live.

**Show model** (`showModel`, default `false`): whether the widget's running rows name the model driving each agent and the thinking level it is running at:

```text
├─ ⠹ Explore  inspect code · sonnet 4.6 · thinking: high · ↻3 · 8.2k token · 4.1s
```

Off by default because the row already carries the description, turns, tool uses, tokens and elapsed time, and every character it gains is one the description loses on a narrow terminal. The other surfaces show the pair either way: the `Agent` tool result names the model beside its tags, and the conversation viewer's `↳` row spells out the canonical `provider/model-id`.

Both places report what the run *actually* used, read back from the child session once pi has resolved its defaults and clamped the level to what the model supports — not what the call asked for. Where those differ, the request is kept beside the effective value rather than dropped, whether pi clamped it or an agent file's frontmatter outranked it:

```text
  ↳ anthropic/claude-haiku-4-5 · thinking: low (asked max) · background
```

Toggle via `/agents → Settings → Show model`; applied live.

**Viewer markdown** (`viewerMarkdown`, default `"assistant"`): how much of the [conversation viewer](#ui)'s transcript is rendered as Markdown rather than shown verbatim.

```text
off        every line literal, as before this setting existed
assistant  assistant text rendered; tool results verbatim and dim   (default)
all        tool results rendered too
```

Scoped rather than all-or-nothing because the two kinds of content have different contracts. Assistant text *is* Markdown — the model writes it that way, and the viewer was the only surface showing its source. A tool result is whatever bytes the tool produced, and a Markdown pass over one rewrites things that occur constantly in real output: `# section` in a shell script loses its `#`, a `---` line is swallowed as a setext heading, indented output is re-fenced, and `| a | b |` is redrawn as a box-drawing table. Each of those reads as the *tool* having misbehaved, which is why `all` is opt-in.

Two rewrites are suppressed outright rather than left to the mode, because they change *data* rather than layout: ordered-list markers keep their source numbering (`3) 7) 9)` stays, instead of being renumbered `3. 4. 5.`) and backslash escapes are not normalised.

Turn `all` on for tools that genuinely emit Markdown, and off again for a diff or a log. `m` in the viewer cycles the three and persists the choice, so the key and this setting are the same value — the footer shows which is in force as `m raw` / `m md` / `m md+`. Code fences are syntax-highlighted using pi's own Markdown theme — which is also why fenced code is the one part of a result *not* dimmed under `all`; result prose still is, so the transcript keeps its hierarchy. Applied live; also settable from `/agents → Settings → Viewer markdown`.

**Workflows** (`workflowsEnabled`, default `true`): the master switch for scripted workflows. Toggle it via `/agents → Settings → Workflows`, or set it in `subagents.json`. Off, the `SubagentWorkflow` tool is never registered — the model is not told the feature exists and cannot call it, so it costs no tool-spec context — the `/agents → Workflows` entry is hidden, and `--subagents-workflow-file` refuses with a pointer to the setting rather than doing nothing. Read at extension load, so it applies on the next pi session; runs already in flight are left alone.

Leaving it unset is not quite the same as `true`. Unset means *auto*: on, unless another extension already provides a workflow tool, in which case this one warns and stands down for the session. Two orchestrators in one tool spec is a worse default than none — the model has to guess which to call and pays for both descriptions to find out — and the extension that was installed on purpose is the one that should survive. Setting `workflowsEnabled` explicitly pins the answer: `true` keeps ours whatever else is loaded, `false` is off regardless.

The match is on the exact tool names `Workflow` (Claude Code's) and `SubagentWorkflow` (ours), never a substring, so a `list_workflows` or `github_workflow_run` from some CI integration does not silently take the feature down. The check runs at `session_start` and nowhere earlier, because `getAllTools` throws during extension loading and load order means a check at registration time could not see an extension that has not loaded yet — so the tool is registered first and withdrawn from the active set through `setActiveTools`, which rebuilds the system prompt before any turn runs. When the other extension took the `SubagentWorkflow` name itself, pi's first-registration-wins rule already dropped ours, so there is nothing to withdraw and only the menu and the CLI flag come down.

**Tool description** (`toolDescriptionMode`, default `"full"`): which Agent tool description the LLM sees. `"full"` is the rich Claude Code-style prompt (~1,400 tokens with the default agents); `"compact"` is ~75% smaller — one-line agent type list, terse usage notes — for small/local models where tool-spec tokens are expensive. Per-option details stay in the parameter descriptions in every mode (the parameter schema is never customizable). Applies on the next pi session.

`"custom"` registers your own description from `<cwd>/.pi/agent-tool-description.md` (project) or `<agentDir>/agent-tool-description.md` (global; project wins). The file is read once at tool registration, so edits also apply on the next pi session. Dynamic parts stay live via placeholders — a static agent list would go stale the moment you add a custom agent:

```markdown
Launch an autonomous agent. Available types:
{{typeList}}

Custom agents live in .pi/agents/ or {{agentDir}}/agents/.
```

Placeholders: `{{typeList}}` (full per-agent descriptions), `{{compactTypeList}}` (first sentence each), `{{agentDir}}`, `{{isolationGuideline}}` and `{{scheduleGuideline}}` (each expands with its own leading newline + `- ` bullet when the matching feature is on — place them directly after your last rule line; empty when [worktree isolation](#turning-worktrees-off) / scheduling is off). Unknown placeholders are left verbatim with a stderr warning; a missing or empty file falls back to `"full"` with a warning. Note the usual trust umbrella: a project-level file shapes the orchestrator's prompt, same as project agents and extensions do.

**Starting point:** copy [`examples/agent-tool-description.md`](examples/agent-tool-description.md) — it reproduces the default full description exactly (a CI test keeps it in sync), so you can trim from a known-good baseline instead of writing from scratch.

**Example — global defaults for a beefy machine:**

```bash
mkdir -p ~/.pi/agent
cat > ~/.pi/agent/subagents.json <<'EOF'
{
  "maxConcurrent": 16,
  "graceTurns": 10
}
EOF
```

Every project now starts with concurrency 16 and grace 10, without ever touching the menu. Individual projects can still override via `/agents` → Settings.

**Failure behavior:** missing file is silent; malformed JSON logs a `[pi-subagents] Ignoring malformed settings at …` warning to stderr; invalid/out-of-range field values are dropped per-field; write failures downgrade the `/agents` toast to a warning with `(session only; failed to persist)`.

## Events

Agent lifecycle events are emitted via `pi.events.emit()` so other extensions can react:

| Event | When | Key fields |
|-------|------|------------|
| `subagents:created` | `Agent`-tool background spawn, or a detached resume — **not** cross-extension RPC, scheduler, or `@handle` spawns, which are first seen at `subagents:started` | `id`, `type`, `description`, `isBackground` (always `true`) |
| `subagents:started` | Agent transitions to running (including queued→running) | `id`, `type`, `description` |
| `subagents:completed` | Agent finished successfully (background and foreground) | `id`, `type`, `description`, `status`, `durationMs`, `tokens` (display total, `{ input, output, total }` — see the note below), `usage` (the run's spend as a pi `Usage`: token components including `cacheRead`, plus `cost.total` in USD; absent when nothing was spent), `toolUses`, `result` |
| `subagents:failed` | Agent errored, stopped, or aborted (background and foreground) | identical payload to `subagents:completed` — both are built by the same formatter, so `error` and `status` are present on that row too, just empty |
| `subagents:steered` | Steering message accepted — fires for a *queued* steer as well as a delivered one | `id`, `message` |
| `subagents:compacted` | Agent's session successfully compacted | `id`, `type`, `description`, `reason` (`"manual"` / `"threshold"` / `"overflow"`), `tokensBefore`, `compactionCount` |
| `subagents:scheduled` | Schedule lifecycle change | `{ type: "added" \| "removed" \| "updated" \| "fired" \| "error", … }` (job/agentId/error fields per type) |
| `subagents:scheduler_ready` | Scheduler bound to session, enabled jobs armed | `sessionId`, `jobCount` |
| `subagents:ready` | RPC handlers registered and armed — fired on session start; not emitted in a session that excludes pi-subagents | `{}` (empty object) |
| `subagents:settings_loaded` | Persisted settings applied at extension init | `settings` (merged global + project) |
| `subagents:settings_changed` | `/agents` → Settings mutation was applied | `settings`, `persisted` (`boolean` — `false` on write failure) |

The four agent-lifecycle events — `subagents:started`, `:completed`, `:failed`, `:compacted` — are emitted for **top-level agents only**. Nested subagents and a workflow's children emit nothing at all; they report through the parent or workflow that owns them.

`tokens.total` = `input + output + cacheWrite`. `cacheRead` is excluded — each turn's `cacheRead` is the cumulative cached prefix re-read on that one API call, so summing per-message would over-count it as a measure of work done. Use `contextUsage.percent` (surfaced as `(NN%)` in the widget) for current context size.

`usage` answers the other question — what was billed — and so does include `cacheRead`, because the prefix really is re-read and re-charged on every call. It is a pi `Usage`, the same shape pi puts on `ToolResultEvent` and `AssistantMessage`, so `usage.cost.total` is where a listener already expects the money and anything pi adds to `Usage` arrives without a change here. Neither field derives from the other; `tokens` is a view model, `usage` is the data.

## Cross-Extension RPC

Other pi extensions can spawn and stop subagents programmatically via the `pi.events` event bus, without importing this package directly.

All RPC replies use a standardized envelope: `{ success: true, data?: T }` on success, `{ success: false, error: string }` on failure.

**Full reference:** [`docs/rpc.md`](https://github.com/tintinweb/pi-subagents/blob/master/docs/rpc.md) — the complete spawn-option surface (including the fields that are silently stripped), every error string, the completion-notification race, the `Symbol.for("pi-subagents:manager")` registry, and what protocol version `2` does and does not promise. [`tintinweb/pi-tasks`](https://github.com/tintinweb/pi-tasks) is the reference implementation.

### Discovery

Listen for `subagents:ready` to know when RPC handlers are available:

```typescript
pi.events.on("subagents:ready", () => {
  // RPC handlers are registered — safe to call ping/spawn/stop
});
```

`subagents:ready` fires only when pi-subagents is actually loaded **and bound** in the current session. A session that excludes it (via an agent's `extensions:`) emits no `subagents:ready` and does not answer the RPC channels — exactly as if pi-subagents were not installed. Treat "no `subagents:ready`" as "not available here" and give discovery a timeout rather than waiting indefinitely.

### Ping

Check if the subagents extension is loaded and get the protocol version:

```typescript
const requestId = crypto.randomUUID();
const unsub = pi.events.on(`subagents:rpc:ping:reply:${requestId}`, (reply) => {
  unsub();
  if (reply.success) console.log("Protocol version:", reply.data.version);
});
pi.events.emit("subagents:rpc:ping", { requestId });
```

### Spawn

Spawn a subagent and receive its ID:

```typescript
const requestId = crypto.randomUUID();
const unsub = pi.events.on(`subagents:rpc:spawn:reply:${requestId}`, (reply) => {
  unsub();
  if (!reply.success) {
    console.error("Spawn failed:", reply.error);
  } else {
    console.log("Agent ID:", reply.data.id);
  }
});
pi.events.emit("subagents:rpc:spawn", {
  requestId,
  type: "general-purpose",
  prompt: "Do something useful",
  options: { description: "My task", isBackground: true },
});
```

`options` is the manager's spawn-option object, not the `Agent` tool's parameter schema — the background flag is `isBackground`, and the tool's snake_case `run_in_background` is forwarded verbatim and ignored. Every RPC spawn returns its id immediately and runs detached either way; `isBackground: true` is what makes the agent occupy one of the `maxConcurrent` slots (and queue behind them when they are full). It does not affect `subagents:created`, which is never emitted for an RPC spawn at all — the first event you see for one is `subagents:started`. Leaving it unset starts the agent immediately regardless of the limit. `maxConcurrentForeground` never applies here whatever `isBackground` says: it bounds only spawns a caller is blocking on inline, and every RPC spawn is detached. A top-level RPC spawn renders in the widget and FleetView while it runs, with the same live tool activity and turn counter an `Agent`-tool spawn gets — only an explicit `isBackground: false` is dropped by the widget's default `background` mode, the way a foreground `Agent` call is. Nested spawns stay hidden from both.

`options.model` accepts either a `Model` object (e.g. `ctx.model`) or a `"provider/modelId"` string — strings are resolved against `ctx.modelRegistry` at the RPC boundary, so cross-extension callers can forward serializable values without losing auth context. Resolution is fuzzy, so a bare `"sonnet"` can land on a provider you never named: with [Model Scope](#model-scope) on, an override that resolves outside `enabledModels` is refused with an error envelope listing the allowed models, exactly as a caller-supplied `Agent({ model })` is. `null` means unset — the agent inherits, same as omitting the field.

`options.cwd` (absolute path to an existing directory — anything else returns an error envelope; `null` means unset) runs the agent in a different working directory than the parent session. Its tools operate there and the prompt's environment block describes it, but **`.pi` config still loads from the parent session's project** — the target directory's `.pi` extensions never execute, and its agents/skills/settings are not picked up. Combined with `isolation: "worktree"`, the worktree is created *from* the target directory's repo, the agent works at the equivalent subdirectory inside the copy (a monorepo-package cwd stays scoped to that package), and the resulting `pi-agent-*` branch lands in that repo — the completion message names it. On session end, worktree registrations are pruned in every repo that received one; only a hard crash can leave a stale entry (then: `git worktree prune` in the target repo). Agents with `memory:` keep reading/writing the parent project's memory.

### Stop

Stop a running agent by ID:

```typescript
const requestId = crypto.randomUUID();
const unsub = pi.events.on(`subagents:rpc:stop:reply:${requestId}`, (reply) => {
  unsub();
  if (!reply.success) console.error("Stop failed:", reply.error);
});
pi.events.emit("subagents:rpc:stop", { requestId, agentId: "agent-id-here" });
```

### Consume

Say that an agent's result has been shown to the model, so its completion notification is not delivered on top of it:

```typescript
pi.events.emit("subagents:rpc:consume", { requestId: crypto.randomUUID(), agentId: "agent-id-here" });
```

This is the bus-side half of what `get_subagent_result` does when it returns a result. A caller that joins an agent on `subagents:completed` and reports the result itself should consume it — otherwise the notification lands after the parent has already answered, costing a turn to dismiss. Fire-and-forget is the intended use: the reply carries nothing to act on, and the channel is outside the `subagents:rpc:ping` version handshake, so a caller can send it unconditionally and an older extension that has no handler simply keeps notifying. Consuming a running or unknown agent is refused (`success: false`) and changes nothing — a running agent has no result to have been read, and its notification is still the caller's only signal that it finished.

Reply channels are scoped per `requestId`, so concurrent requests don't interfere.

## Persistent Agent Memory

Agents can have persistent memory across sessions. Set `memory` in frontmatter to enable:

```yaml
---
memory: project   # project | local | user
---
```

| Scope | Location | Use case |
|-------|----------|----------|
| `project` | `.pi/agent-memory/<name>/` | Shared across the team (committed) |
| `local` | `.pi/agent-memory-local/<name>/` | Machine-specific (gitignored) |
| `user` | `<agentDir>/agent-memory/<name>/` (default `~/.pi/agent/agent-memory/`, honors `PI_CODING_AGENT_DIR`) | Global personal memory |

The `user` scope previously hardcoded `~/.pi/agent-memory/`. If that legacy directory exists for an agent and the new location doesn't, it keeps being used — existing memories aren't orphaned.

Memory uses a `MEMORY.md` index file and individual memory files with frontmatter. Agents with write tools get full read-write access. **Read-only agents** (no `write`/`edit` tools) automatically get read-only memory — they can consume memories written by other agents but cannot modify them. This prevents unintended tool escalation.

The `disallowed_tools` field is respected when determining write capability — an agent with `tools: write` + `disallowed_tools: write` correctly gets read-only memory.

## Worktree Isolation

Set `isolation: worktree` to run an agent in a temporary git worktree:

```
Agent({ subagent_type: "refactor", prompt: "...", isolation: "worktree" })
```

The agent gets a full, isolated copy of the repository. The worktree directory is removed on completion either way — what differs is whether a branch is left behind:
- **No changes:** worktree is cleaned up automatically, no branch
- **Changes made:** changes are committed to a new branch (`pi-agent-<id>`), and the result names the branch and the `git merge` command for it. The branch is the only artifact — the worktree path is gone, so nothing points into it
- **Agent committed its own work:** the branch is created at the agent's HEAD, preserving its commits (uncommitted leftovers are committed on top first)

The agent's system prompt names the worktree as an isolated copy and tells it to work only there, even if other instructions name the main checkout — otherwise an inherited parent prompt or a task prompt mentioning the project path walks it straight back out of the copy. This is a directive, not a sandbox: an agent with shell access can still `cd` out, so don't rely on `isolation` alone to protect the main checkout.

The automatic preservation commit uses `--no-verify`, so local pre-commit hooks can't block it — the commit is local-only and never pushed, and pre-push/server-side hooks still apply.

If the worktree cannot be created (not a git repo, no commits, or `git worktree add` fails), the `Agent` call fails with a clear error instead of running unisolated — `isolation: "worktree"` is a strict guarantee, not a hint. The call is reported as a failed tool call, not as a subagent that ran and returned that message, so the model doesn't retry it as if the agent had merely reported a problem. Initialize git and commit at least once, or omit `isolation`.

A worktree is a *copy*, so the agent cannot see uncommitted or staged changes in the main checkout. Never use it to review a working-tree or staged diff: the agent finds an empty `git diff` and reports nothing wrong.

### Turning worktrees off

Three levers, from narrowest to broadest:

- **Per call** — omit `isolation`, or pass `isolation: "off"`. The explicit value exists because some models fill every optional parameter they are offered; with `worktree` as the only legal value they had no way to decline one (#231, #184).
- **Per agent** — `isolation: off` in an agent file. Frontmatter is authoritative, so this refuses a worktree even when the caller passes `isolation: "worktree"` — the only way to override a caller.
- **Per project** — `"worktreeIsolation": false` in `subagents.json`. The `Agent` tool's `isolation` parameter disappears from the schema entirely, along with the usage-note bullet that describes it (so it costs the model no context and cannot be passed), and worktree creation is refused on every other path too: agent files, scheduled jobs, and cross-extension RPC. The `/agents` generator also stops offering `isolation:` when writing a new agent file. Use it on a repo large enough that a copy costs real time and disk. The schema and the description are both built at tool registration, so they appear or disappear in the next pi session; the refusal itself takes effect immediately.

  Schema and prose are gated together on purpose. Leaving the bullet in would teach the model to pass a field that is no longer declared — accepted silently, then dropped — and since a refused worktree carries no note on the result, the model would have every reason to go on reporting a `pi-agent-*` branch that was never created. A custom tool description should use the `{{isolationGuideline}}` placeholder rather than hardcoding the bullet, for the same reason.

## Skill Preloading

Skills can be preloaded by name and injected into the agent's system prompt:

```yaml
---
skills: api-conventions, error-handling
---
```

**Discovery roots** (checked in this order, first match wins):

| Scope | Path | Source |
|---|---|---|
| Project | `<cwd>/.pi/skills/` | Pi-standard |
| Project | `<cwd>/.agents/skills/` | [Agent Skills spec](https://agentskills.io/integrate-skills) |
| User | `$PI_CODING_AGENT_DIR/skills/` (default `~/.pi/agent/skills/`) | Pi-standard |
| User | `~/.agents/skills/` | [Agent Skills spec](https://agentskills.io/integrate-skills) |
| User | `~/.pi/skills/` | Legacy (pre-Pi) |

**Per root, a skill named `foo` resolves to the first of:**

- `<root>/foo.md` — flat file at the top level
- `<root>/foo/SKILL.md` — directory skill (top-level)
- `<root>/*/.../foo/SKILL.md` — directory skill, found by recursive descent

Recursion skips dotfile directories and `node_modules`. A directory that itself contains a `SKILL.md` is treated as a single skill — we don't descend into it. Traversal is byte-order sorted for deterministic resolution across filesystems.

**Security:** symlinks are rejected at every layer (root, flat file, skill directory, `SKILL.md` inside a skill directory) — intentional deviation from Pi, which follows symlinks. Skill names with path-traversal characters (`..`, `/`, `\`, spaces, leading dot, >128 chars) are rejected.

## Tool Denylist

Block specific tools from an agent even if extensions provide them:

```yaml
---
tools: read, bash, grep, write
disallowed_tools: write, edit
---
```

This is useful for creating agents that inherit extension tools but should not have write access.

## Architecture

```
docs/                 # Long-form guides (shipped to npm; README links out to them)
  workflows.md        # SubagentWorkflow: writing, editing, saving and re-running scripts
  rpc.md              # Cross-extension integration: pi.events, subagents:rpc:*, manager registry
examples/
  workflows/          # Runnable examples, executed by test/workflow-examples.test.ts
  agent-tool-description.md
test/                 # vitest suite; e2e/ and perf/ subdirectories
src/
  index.ts            # Extension entry: tool/command registration, /agents menu, rendering
  types.ts            # Type definitions (AgentConfig, AgentRecord, etc.)

  # Agent registry
  default-agents.ts   # Embedded default agent configs (general-purpose, Explore, Plan)
  custom-agents.ts    # Load user-defined agents from .pi/agents/, .agents/agents/, and global agents
  agent-types.ts      # Unified agent registry (defaults + user), tool name resolution
  agent-file-toggle.ts # Locate/edit an agent's .md: enabled: toggle, eject to frontmatter
  agent-color.ts      # Claude Code/Agency Agents name color parsing and badge rendering

  # Execution
  agent-runner.ts     # Session creation, execution, graceful max_turns, steer/resume
  agent-manager.ts    # Agent lifecycle, concurrency queue, completion notifications
  nested-tools.ts     # Delegation tools handed to subagents (nested spawn/collect/steer)
  child-context.ts    # AsyncLocalStorage flag marking work done for a child session
  abortable.ts        # Race a wait against Esc without cancelling the background child
  group-join.ts       # Group join manager: batched completion notifications with timeout
  status-note.ts      # Honest status note + salvaged partial output for non-normal outcomes
  usage.ts            # Token usage shapes, accumulators, session-stats readers

  # Invocation surface
  invocation-config.ts # Shared tool-parameter schemas (isolation, join, thinking, ...)
  model-resolver.ts   # Model resolution: exact provider/modelId with fuzzy fallback
  enabled-models.ts   # Read pi's enabledModels settings (project over global)
  model-scope.ts      # scopeModels allowlist policy, shared by top-level and nested tools
  mention.ts          # `@handle message` grammar: suggestion triggers and send parsing
  mention-clone.ts    # Run a mention's turn in a cloned conversation, off the main chat
  cross-extension-rpc.ts # RPC handlers for cross-extension spawn/ping via pi.events

  # Scheduling
  schedule.ts         # SubagentScheduler: cron / +10m / interval / ISO dispatch
  schedule-store.ts   # PID-locked, session-scoped, atomic schedule persistence

  # Context & environment
  memory.ts           # Persistent agent memory (resolve, read, build prompt blocks)
  skill-loader.ts     # Preload skills (Pi-standard + Agent Skills spec layouts)
  output-file.ts      # Streaming output file transcripts for agent sessions
  worktree.ts         # Git worktree isolation (create, cleanup, prune)
  prompts.ts          # Config-driven system prompt builder
  context.ts          # Parent conversation context for inherit_context
  settings.ts         # Persistent settings (~/.pi/agent/subagents.json + .pi/subagents.json)
  env.ts              # Environment detection (git, platform)

  workflow/
    meta.ts           # Extract and validate a script's pure-literal `meta` block
    worker-source.ts  # The sandbox: vm context, determinism prelude, script globals
    runtime.ts        # Worker lifecycle, RPC bridge, semaphore, caps, gate/resume
    progress.ts       # Progress event log and every derived view of it (pure)
    host.ts           # WorkflowHost adapter over AgentManager
    task.ts           # local_workflow task record and batched progress updates
    tool-description.ts # Model-facing description carrying the orchestration patterns
  ui/
    agent-widget.ts       # Persistent widget: spinners, activity, status icons, theming
    fleet-list.ts         # FleetView: navigable agent list below the editor
    conversation-viewer.ts # Live conversation overlay for viewing agent sessions
    viewer-keys.ts        # Viewer scroll keys resolved through user keybindings
    agent-mention.ts      # `@` roster (running, resumable, and startable agents) + popup rows
    schedule-menu.ts      # /agents → Scheduled jobs submenu
    select-item.ts        # Collision-safe ctx.ui.select wrapper (numbered rows)
    workflow-card.ts      # Inline workflow card (tool result and session entry)
    workflow-dialog.ts    # /agents → Workflows two-pane inspector
```

## License

MIT — [tintinweb](https://github.com/tintinweb)
