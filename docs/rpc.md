# Driving subagents from another extension

Another pi extension can spawn a subagent, listen for subagent completion, read the result, steer and stop the run — all over the `pi.events` bus, without importing this package directly. Five request/reply channels (`subagents:rpc:ping`, `subagents:rpc:spawn`, `subagents:rpc:stop`, `subagents:rpc:consume`, `subagents:rpc:steer`), the lifecycle events in README's [event table](../README.md#events), one per-message usage event (`subagents:usage`), one terminal `subagents:disposed`, and one in-process registry at `Symbol.for("pi-subagents:manager")`.

The thing worth understanding up front is that **the bus is in-process.** Every "RPC" call here is a synchronous `pi.events.emit` into the same event loop, and every reply comes back the same way. That single fact explains most of what follows: why `signal` and the `on*` callbacks work on a spawn payload at all, why a `consume` fired inside a `subagents:completed` handler lands *before* the notification decision has been made, and why none of this survives a real process boundary.

For the channel list, the reply envelope, the per-channel snippets and the event table, see [`README.md`](../README.md#cross-extension-rpc). This document is the reference README does not have room for: the complete spawn-option surface, every error string, the notification race, the registry, and what protocol version `2` does and does not promise.

## Spawn options

`subagents:rpc:spawn` forwards `options` to `AgentManager.spawn` — but not verbatim. The manager's `spawn` behind the RPC is `spawnTopLevel` in `src/index.ts`, which deletes internal-only fields first, and then `spawnResolved` overwrites the activity-tracker callbacks with its own. The full interface is `SpawnOptions` in `src/agent-manager.ts`; what a bus caller actually gets is three different things.

**Honoured** — set these and they take effect:

| Field | Type | Notes |
|---|---|---|
| `description` | string | What the agent is doing. Shown in the widget, FleetView and the completion notification |
| `name` | string | A memorable second handle (`@auth-audit`). Slugged, never validated — anything unusable degrades rather than failing the spawn |
| `model` | `Model` **or** `"provider/modelId"` | Strings are resolved at the RPC boundary against `ctx.modelRegistry`. `null` means inherit, not override. Resolution is fuzzy — see [Model Scope](../README.md#model-scope) |
| `maxTurns` | number | Turn ceiling for the run |
| `isolated` | boolean | Strips extensions, skills and nested tools. Applies only when the agent file leaves `isolated:` unset — frontmatter is authoritative. **Not** a git worktree — see the trap table below |
| `inheritContext` | boolean | Fork the parent conversation into the child. Only this option decides — an agent file's `inherit_context:` does not apply to RPC spawns |
| `thinkingLevel` | ThinkingLevel | Clamped to what the resolved model supports |
| `isBackground` | boolean | Occupies a `maxConcurrent` slot and queues behind them. Every RPC spawn runs detached regardless; this is what decides whether it is *pooled* |
| `bypassQueue` | boolean | Starts immediately even when the concurrency limit would queue it. The slot is still counted once running |
| `structuredOutput` | CompiledSchema | Makes the child report through a `StructuredOutput` tool |
| `isolation` | `"worktree"` | Temp git worktree, committed to a `pi-agent-*` branch on completion. The agent file's `isolation:` wins: `worktree` applies even when this is omitted, and `off` refuses it |
| `cwd` | absolute path | The agent's tools operate here; `.pi` config still loads from the parent session's project, and the child reports this directory as untrusted (`ctx.isProjectTrusted()` is `false`) |
| `invocation` | AgentInvocation | Resolved snapshot used for UI display |
| `signal` | AbortSignal | Aborting it stops the subagent |
| `onSpawned` / `onQueued` / `onCompaction` / `onBeforeWorktreeCleanup` | functions | Fire as documented on `SpawnOptions` |

**Silently stripped** — set these and nothing happens, with no error and no note. Each deletion is a deliberate guard, and the reasons are worth knowing because they say what the surface refuses to let a caller forge:

| Field | Why it is taken away |
|---|---|
| `parentAgentId` | Ownership. A forged parent hides your agent under someone else's nested tools |
| `workflowId` | A forged value would hide an RPC-spawned agent inside someone else's workflow — and take it out of the concurrency pool with it |
| `depth`, `maxSubagentDepth` | The nesting cap is inherited, not declared |
| `configCwd` | Config-discovery root; only nested launches may set it |
| `rootSessionId` | Names a transcript directory, so a forged value is a path-traversal primitive |
| `resumeSessionFile` | Worse: it names a file to **open and replay** as a conversation. Dispatcher only, and only from a path this extension itself recorded |
| `reclaim` | Bypasses handle allocation, so a forged value would duplicate a live agent's name and make `@handle` ambiguous |
| `blocking` | Every spawn through here is detached. A forged `blocking` would charge it to the foreground pool and defer it behind a queue whose gate nobody is holding |

**Silently overwritten** — `onToolActivity`, `onTextDelta`, `onTurnEnd`, `onSessionCreated` and `onAssistantUsage` are replaced by the activity tracker's own (`spawnResolved`, `src/index.ts`). Every programmatic spawn passes through one funnel so none can supply half-wired callbacks; a half-wired tracker renders worse than none, which is the bug behind a row that reads `thinking…` for an agent's whole life ([#181](https://github.com/tintinweb/pi-subagents/pull/181)).

Four things that are not obvious from the tables:

- **Nothing is required at runtime.** `description` is non-optional in TypeScript and never validated. A spawn with no `options` at all is legal and is what "returns agent id on success" in `test/cross-extension-rpc.test.ts` pins.
- **`bypassQueue` is not stripped.** Its own doc comment scopes it to the scheduler and the `/agents` generator, but a bus caller can set it and skip the `maxConcurrent` check.
- **`structuredOutput` is documented "set only by the workflow host"** (its field comment on `SpawnOptions`) and is also not stripped.
- **`signal` and the `on*` callbacks are function values.** They work only because the bus is in-process. A caller that genuinely serializes its payload cannot use them, and they arrive as `undefined` rather than failing.

### Names that look right and are not

One of these already shipped as a bug in this project's own README example, so it is worth reading the table even if you are sure.

| You might write | What it does | What you meant |
|---|---|---|
| `run_in_background` | Forwarded verbatim and ignored — it is the [`Agent`](../README.md#agent) *tool's* parameter name | `isBackground` |
| `isolated: true` | Disables extensions, skills and nested tools | `isolation: "worktree"` for a git worktree |
| `isolation: "worktree"` | Creates a git worktree | `isolated: true` to strip capabilities |
| `configCwd` | Stripped | `cwd` |
| `max_turns` / `thinking` / `inherit_context` | Ignored — tool and frontmatter spellings | `maxTurns` / `thinkingLevel` / `inheritContext` |
| `memory` | Nothing. **There is no such option** | Memory scope comes only from the agent definition's frontmatter |

**None of these produce an error.** Option keys are not validated on this path at all — unknown ones are accepted and dropped. (Contrast `agent()` inside a [workflow](workflows.md), which rejects unknown keys by name.)

## Errors

Every failure reaches the caller as `{ success: false, error }`, where `error` is `err?.message ?? String(err)` (`handleRpc` in `src/cross-extension-rpc.ts`) — so these strings are what you will actually see.

| Error | Source |
|---|---|
| `No active session` | spawn handler, `src/cross-extension-rpc.ts` — called before the first bound `session_start`, or in a session that excludes pi-subagents |
| `Model override "<label>" provided but ctx.modelRegistry is unavailable` | spawn handler, `src/cross-extension-rpc.ts` |
| `Model not found: "<input>".` + available models | `resolveModel`, `src/model-resolver.ts` |
| `Model not in scope: "<input>".` + allowed models | `checkModelScope`, `src/model-scope.ts` — only with `scopeModels` on, and checked against the *resolved* model |
| `Unknown or disabled agent type: "<raw>". Available: <list>.` | `resolveSpawnTypeIn`, `src/agent-types.ts` — only under `fallbackSubagent: none` |
| `No agent type given. Available: <list>.` | `resolveSpawnTypeIn` — same condition |
| `<reason> The configured fallbackSubagent "<x>" is itself unknown or disabled. Available: <list>.` | `resolveSpawnTypeIn` |
| `SpawnOptions.cwd must be an absolute path: "<value>"` | `assertValidSpawnCwd`, `src/agent-manager.ts` |
| `SpawnOptions.cwd does not exist: "<cwd>"` | `assertValidSpawnCwd` |
| `SpawnOptions.cwd is not a directory: "<cwd>"` | `assertValidSpawnCwd` |
| ``Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. Initialize git and commit at least once, or omit `isolation`.`` | `AgentManager.startAgent`, surfaced through `awaitStartup`. Every git failure ends here: `createWorktree` (`src/worktree.ts`) catches git's own error and returns nothing |
| `Agent not found` | stop handler, `src/cross-extension-rpc.ts` |
| `Agent is owned by another agent or workflow` | stop handler |
| `Agent is not running` | stop handler. The record exists, so it has already settled |
| `Agent not found or still running` | consume handler |
| `Steer message must be a non-empty string` | steer handler — `message` missing, not a string, or whitespace |
| `Agent not found` / `Agent is owned by another agent or workflow` / `Agent is not running` | steer handler — same lookup, ownership guard and settled check as stop |

Three things the table cannot show:

- **The failure that is not an error.** With `worktreeIsolation` off project-wide, `isolation: "worktree"` is dropped by the `isWorktreeIsolationEnabled()` check in `AgentManager.startAgent` with no error, no note on the record, and a success envelope on the wire. Your agent runs in the main tree. If you asked for isolation because two agents were going to write the same files, they now collide and nothing told you.
- **`data` is omitted** when a handler returns nothing, so a successful stop or consume reply is a bare `{ success: true }` and `reply.data.anything` throws.
- **`requestId` is not validated.** It is interpolated straight into the reply channel, so a caller that omits it gets its reply on the literal channel `subagents:rpc:spawn:reply:undefined` — where every other caller that omitted it is also listening. Send one, and send a unique one.

## Ownership

`isTopLevelAgent(record)` is `parentAgentId === undefined && workflowId === undefined` (`src/agent-manager.ts`). `subagents:rpc:stop` and `subagents:rpc:steer` enforce it through one shared check (`assertOwned` in `src/cross-extension-rpc.ts`): a nested child or a workflow's agent is owned by something that is *waiting on it*, and aborting or redirecting it out from under that owner turns another extension's request into a failed step. It is defence in depth rather than a live hole — no RPC hands out agent ids, so a caller has no ordinary way to name one it does not own.

Two asymmetries to know about, stated as they are:

- **Stop takes an id only**: its `getRecord` is the manager's plain lookup. Consume takes an id *or* an `@handle`: its `consumeResult` (both wired in the `session_start` handler, `src/index.ts`) goes through `resolveAgentRef`.
- **Consume checks `parentAgentId` but not `workflowId`** (`consumeResult`, `src/index.ts`). A workflow-owned agent's result can be marked consumed over the bus even though the same agent cannot be stopped.

The same predicate silently scopes the events. **Every lifecycle event is top-level only** — `subagents:started`, `:completed`, `:failed`, `:steered` and `:compacted` all return early for nested and workflow-owned agents (the `isTopLevelAgent` checks in the `AgentManager` callbacks, `src/index.ts`). `subagents:usage` is the one event that is not scoped: it fires for every agent's messages, nested and workflow-owned included, so a ledger sees a workflow's children spend even though it never sees them start or finish.

**`subagents:disposed` is the last event of a session.** It is emitted at the end of this extension's `session_shutdown`, after every agent is stopped and every child session has shut down, so no `subagents:usage` can follow it. A listener gets only its synchronous prefix on quit: `pi.events.emit` does not await listeners, and pi calls `process.exit` once the shutdown handlers return. Flush with `writeFileSync`, not `fs.promises`. Fields, and the other events, are in README's [event table](../README.md#events).

## The notification race

When a background agent finishes, pi-subagents sends the user a completion notification. If you have already shown the model that result yourself, that notification arrives on top of an answer that was already given, and it costs the parent a turn to dismiss. `subagents:rpc:consume` is how you say you have handled it — the bus-side half of what `get_subagent_result` does when it returns a result.

**When you send it decides whether it works.** The timeline:

1. The agent settles, and the manager's completion callback in `src/index.ts` emits `subagents:completed`.
2. Next, in the same synchronous callback, it checks `record.resultConsumed` and decides whether to notify at all.
3. `pi.events` dispatch is synchronous and in-process, so a handler that emits `subagents:rpc:consume` **without awaiting anything** has already set that flag before step 2 evaluates.

| When you consume | What happens |
|---|---|
| Synchronously, inside your `subagents:completed` handler | The notification is never scheduled. This is the clean path |
| After an `await`, before the notification is sent | Still suppressed. The notification waits in the outbox (`src/completion-outbox.ts`), and consuming the result cancels it there. It is sent about 200 ms after the completion when the parent is idle (`NOTIFICATION_HOLD_MS`), and at the end of the parent's current tool batch when it is busy |
| After it was sent | Too late. pi has queued it with `triggerTurn: true`, and it costs the parent a model call |

Fire-and-forget is the intended use: the reply carries nothing to act on, and the channel sits outside the `subagents:rpc:ping` version handshake on purpose (the comment on the consume handler, `src/cross-extension-rpc.ts`), so you can send it unconditionally and an older pi-subagents with no handler simply keeps notifying.

Consumption is not terminal. An `@handle` steer un-consumes the record (the mention handler, `src/index.ts`) because the agent's reply to that message still needs relaying. A background resume (`AgentManager.resume`) does too, because the record is starting a new run, and so does handing a foreground agent to the background (`AgentManager.sendToBackground`), because its result now has to reach the parent as a notification.

One related thing that lives nowhere else: on every top-level settle, pi-subagents writes a session entry — not an event — via `pi.appendEntry("subagents:record", …)` (the manager's completion callback, `src/index.ts`), carrying `id`, `type`, `description`, `status`, `result`, `error`, `startedAt` and `completedAt`. It exists for cross-extension history reconstruction. It is append-only history, not something to react to.

## Steering a running agent

`subagents:rpc:steer` `{ requestId, agentId, message }` delivers `message` into a running or queued agent's conversation, the bus-side half of the `steer_subagent` tool. It exists for the caller that spawned an agent over the bus and then learns something that agent needs mid-run — a second CI failure on the head it is already fixing, a review that landed while it works — and would otherwise have to choose between spawning a duplicate agent for the same work and dropping the fact.

It takes an id only, enforces the same top-level ownership guard as stop, and answers `Agent is not running` for a record that has settled. A message queued before the agent's session exists is flushed when the session is created, exactly as the tool's steer is. A successful steer emits `subagents:steered` `{ id, message }`, as every steer path does. Like `consume`, it is outside the `ping` version handshake: an older build has no handler and the request times out on your side, so give it a timeout and treat expiry as "not available here".

## The manager registry

`globalThis[Symbol.for("pi-subagents:manager")]` (`MANAGER_KEY` and `registryEntry`, `src/index.ts`) is a second integration surface — the standard Node cross-package singleton pattern, no bus involved:

| Member | Signature | Notes |
|---|---|---|
| `waitForAll()` | `() => Promise<void>` | Resolves when nothing is running. **All** agents, including ones you did not spawn — a shutdown barrier, not a join |
| `hasRunning()` | `() => boolean` | |
| `spawn(pi, ctx, type, prompt, options)` | `=> string` | **Is** `spawnTopLevel`, so the strip list above applies identically |
| `getRecord(id)` | `=> AgentRecord \| undefined` | Filtered through `isTopLevelAgent`, so someone else's child comes back `undefined` rather than leaking |

A stop request now moves a running record through a visible `"stopping"` status before the terminal `"stopped"`. `"stopping"` means the stop was recorded but the attempt has not yet wound down — it settles gracefully within the stop grace (~30 s by default) or forced at expiry, and `record.stopMetadata` carries `{ reason, mode }` (`reason`: `user`/`owner`/`shutdown`; `mode`: `graceful`/`forced`). A queued abort skips straight to `"stopped"` with no `stopMetadata`, because it never acquired a slot or a supervisor. Consumers keying off `"stopped"` string equality are unaffected; anything enumerating statuses should now expect `"stopping"` too.

The slot is claimed by the first activation only; subagent sessions re-activate this extension in the same process, and unconditionally overwriting would point the registry at a short-lived child manager whose shutdown would then delete the root session's entry ([#128](https://github.com/tintinweb/pi-subagents/pull/128)). Child activations leave it alone, and shutdown releases it only if this activation claimed it (`ownsManagerRegistry`, checked in the `session_shutdown` handler).

Prefer the bus. The registry has no reply envelope, no version, and no availability event — `globalThis[Symbol.for("pi-subagents:manager")] === undefined` is the only probe you get, and it is also `undefined` in a session that filtered pi-subagents out. Reach for it for the two things the bus has no verb for — *is anything still running*, and *give me a settled record back* — or for a headless host that wants to block on `waitForAll()` before exiting.

## Protocol versions

`subagents:rpc:ping` replies `{ version: PROTOCOL_VERSION }`, currently `2` (`src/cross-extension-rpc.ts`). The constant was introduced already equal to `2` in 0.5.0; "v1" is a retroactive name for the pre-envelope contract, where spawn replied with a bare `{ id }` or `{ error }`, stop replied `{ success: boolean }` with no message, and each handler caught its own errors.

Everything added since shipped **without a bump**, because all of it is additive: stop's ownership refusal, string-`model` resolution ([#59](https://github.com/tintinweb/pi-subagents/pull/59)/[#60](https://github.com/tintinweb/pi-subagents/issues/60)), `scopeModels` enforcement ([#240](https://github.com/tintinweb/pi-subagents/issues/240)), and the whole `consume` and `steer` channels.

> A `ping` that answers `2` does not tell you whether `consume` or `steer` exists, whether model scope is enforced, or whether stop checks ownership.

So: send `consume` unconditionally and ignore the outcome — an older build has no handler and simply keeps notifying, which is exactly why it was left outside the handshake. And treat every error envelope as authoritative rather than trying to predict which checks are in force.

## Availability

`subagents:ready` is the discovery signal, and both the RPC handlers and the event itself are wired on the first bound `session_start` (its handler in `src/index.ts`) — deliberately not at factory time. pi runs every extension factory *before* applying an agent's `extensions:` filter and only delivers lifecycle events to the survivors, so a factory-time broadcast made a filtered-out session advertise a spawn service it could never provide: `ping` succeeded and every `spawn` answered `No active session` ([#142](https://github.com/tintinweb/pi-subagents/issues/142)).

The consequence is worth stating plainly: **a session that excludes pi-subagents is indistinguishable from pi-subagents not being installed.** It emits no `subagents:ready` and answers nothing. Give discovery a timeout and treat expiry as "not available here" rather than waiting indefinitely. The payload is `{}` — read nothing off it. Handlers are torn down and `rpcHandle` reset in the `session_shutdown` handler, so a later `session_start` re-registers and re-emits.

One more trap on the way in: an RPC-spawned agent emits **no `subagents:created`**. The only three emit sites, all in `src/index.ts`, are the `Agent` tool's `run_in_background` branch, a detached resume (`startBackgroundResume`), and a foreground `Agent` call handed to the background with ctrl+b or the viewer's `b` (`sendForegroundToBackground`) — that one fires after the agent's `subagents:started`, as resume does. Your first event for your own agent is `subagents:started` (the manager's start callback), so key your bookkeeping off the id that `spawn` handed you, not off `subagents:created`.

## What the tests pin

This document has no test of its own, so it is worth knowing which claims are actually held in place:

| Test | Level | Pins |
|---|---|---|
| `test/cross-extension-rpc.test.ts` | Mocked `SpawnCapable` | Envelope shape, per-channel error strings (including steer's), model resolution and scope enforcement |
| `test/rpc-lifecycle-gating.test.ts` | Real extension factory | Nothing wired at factory time, everything once at `session_start`, and live widget activity for RPC spawns ([#142](https://github.com/tintinweb/pi-subagents/issues/142)/[#181](https://github.com/tintinweb/pi-subagents/pull/181)) |
| `test/rpc-result-consumption.test.ts` | Real delivery path | The notification firing, and not firing, around `consume` |

Not pinned anywhere, so treat them as descriptions rather than contracts: the `SpawnOptions.cwd` error strings, `subagents:ready`'s `{}` payload, consume's handle resolution, and its missing `workflowId` check.

## Reference implementation

[**`tintinweb/pi-tasks`**](https://github.com/tintinweb/pi-tasks) is the working integration and the one this surface was shaped by. Its `TaskExecute` drives `subagents:rpc:spawn` — including the serialized `"provider/modelId"` string form that the boundary now resolves — and its `TaskOutput` drives `subagents:rpc:consume`, which exists because pi-tasks joins an agent on `subagents:completed` and reports the result itself ([pi-tasks#62](https://github.com/tintinweb/pi-tasks/issues/62)).

Read it for the shape of the whole loop: waiting on `subagents:ready`, keeping an id-keyed map of outstanding spawns, resolving each from the `subagents:completed` / `subagents:failed` handler, and consuming the result in the same synchronous handler that reports it.

If what you want is many coordinated agents rather than one, hand a script to [`SubagentWorkflow`](workflows.md) instead of fanning out over `subagents:rpc:spawn` — and note that a workflow's agents are not yours: they emit no lifecycle events — only `subagents:usage` — and `subagents:rpc:stop` refuses them.
