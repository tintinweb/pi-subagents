# Agent viewer modes

Audience: contributors implementing or reviewing the Transcript / Info / Prompt / Output overlay.

This is the feature spec. The user-facing summary lives in README.md.

# PRD: Agent viewer modes (Transcript / Info / Prompt / Output)

## 1. Overview

One overlay shows one agent. The overlay has four views: **Transcript**, **Info**, **Prompt**, **Output**.

You pick a view in two ways:

- Arrow keys and Enter
- Keys `t` `i` `p` `o`

Those two ways work in:

1. `/agents` → Running agents → pick agent
2. FleetView, when an agent row is selected
3. Inside the overlay, to switch view without closing it

The name is **Info**, not Stats. Transcript is `t` so it does not collide with workflow Skip (`s`).

The spawn prompt is stored on the agent record. Turn counts are not stored and not shown.

## 2. Problem

- Who is affected? Users who open a subagent from `/agents` or FleetView.
- What happens today? The overlay opens Transcript and auto-scrolls to the end. The spawn prompt is at the top. Final output is mixed with tool lines. Run facts sit in one cramped header.
- Why it matters: Users cannot read the prompt, the result, or the run facts without scrolling a long transcript.

## 3. Goals

- Pick Transcript, Info, Prompt, or Output with arrows + Enter.
- Pick the same views with `t` `i` `p` `o`.
- Use both methods in `/agents`, in FleetView, and inside the overlay.
- Prompt shows only the first spawn prompt.
- Info shows run facts with no turn count.
- Output shows only the final result, or `No output yet.`

Evidence: picker and overlay header name the view. Prompt text matches the stored spawn prompt, not parent context.

## 4. Non-Goals

- Do not store or show turn counts.
- Do not add settings.
- Do not change spawn, steer, or stop tools.
- Do not show parent context in Prompt.
- Do not put the four views on `main` or workflow rows.
- Do not rewrite the above-editor widget.

## 5. Users & Use Cases

- Primary user: a person who spawned a subagent and wants the prompt, the result, or the run facts.
- Secondary user: a person who uses FleetView instead of `/agents`.
- Key scenarios:
  1. `/agents` → pick agent → pick Prompt with arrows, or press `p`.
  2. FleetView on an agent row → press `p` to open Prompt at once.
  3. FleetView on an agent row → Enter → arrow to Info → Enter.
  4. Inside Transcript, press `o`, read the result, press `t` to return.

## 6. User Stories

- As a user I want a four-view picker so I can choose Transcript, Info, Prompt, or Output.
- As a user I want `t` `i` `p` `o` on that picker so I can skip the arrows.
- As a user I want the same keys on a selected FleetView agent row so I can open a view without a second menu.
- As a user I want the same keys inside the overlay so I can switch views without closing it.
- As a user I want Prompt to show the first spawn prompt only.

## 7. Functional Requirements

Terms:

- **View** — Transcript, Info, Prompt, or Output.
- **Overlay** — the agent viewer. It has one active view.
- **View picker** — a four-row list of views. Arrows move. Enter opens. `t` `i` `p` `o` open at once.
- **Spawn prompt** — the `prompt` string passed to spawn. Not the session user message after parent context is prepended.

MUST:

1. The system must store the spawn prompt on `AgentRecord` at spawn time and keep it for the life of the record.
2. After the user picks an agent in `/agents` → Running agents, the system must open the view picker.
3. FleetView Enter on an **agent** row must open the same view picker. `main` still returns to the prompt. A workflow row still opens the workflow inspector.
4. The view picker must list Transcript, Info, Prompt, Output in that order.
5. In the view picker, Up/Down must move the highlight. Enter must open the overlay on the highlighted view.
6. In the view picker, `t` `i` `p` `o` must open the overlay on that view. They must not type into the editor.
7. When FleetView is active and an **agent** row is selected, `t` `i` `p` `o` must open the overlay on that view at once (no picker). The list must consume those keys.
8. When FleetView is active and `main` or a workflow row is selected, `t` `i` `p` `o` must not open an agent overlay.
9. The overlay header must show the active view name.
10. Inside the overlay, with no steer composer open, `t` `i` `p` `o` must switch view. The overlay stays open.
11. Pressing the key for the current view must keep that view.
12. Transcript must keep today’s live conversation, auto-scroll, `m`, Enter-to-steer, and `x` stop.
13. Prompt must show only the stored spawn prompt, wrapped and scrollable.
14. If no spawn prompt is stored, Prompt must show `No prompt stored.`
15. Info must show at least: model name or id, thinking level, cost (when `showCost` is on), tool call count, elapsed duration, start time, and end time or `running`.
16. Info must not show a turn count.
17. Output must show `record.result` only, wrapped and scrollable.
18. If there is no result yet, Output must show `No output yet.` Output stays in the picker even while the agent runs.
19. Esc / `q` / Ctrl+C must close the overlay from every view. Esc on the picker must cancel and return to the list.
20. While the steer composer is open, `t` `i` `p` `o` must type into the composer. They must not switch views.
21. `x` stop must work from every view, with the same two-press confirm as today.
22. Prompt is the first spawn prompt only. Resume and steer text stay in Transcript.

SHOULD:

23. Info SHOULD also show status, token total, and invocation tags (isolated, worktree, inherit context, background).
24. Overlay and picker footers SHOULD show `t/i/p/o`. Wider terminals MAY spell the names.
25. Each overlay view SHOULD keep its own scroll offset across switches.
26. FleetView idle/active hints SHOULD mention `t/i/p/o` when an agent row can be opened.

COULD:

27. Output COULD use the same `m` Markdown cycle as Transcript.

## 8. Non-Functional Requirements

- Every rendered line must fit the terminal width. Same rule as `ConversationViewer` today.
- Prompt and Output must cap huge text with `RESULT_MAX_CHARS`, same as Transcript tool results.
- Footer at 80 columns must still fit. Prefer `t/i/p/o` if width is tight.
- No extra network calls. Views read the in-memory record and session.
- Do not write the spawn prompt to a new log file.
- FleetView must consume `t` `i` `p` `o` on an agent row. Today any other key leaves the list and types into the editor. That must not happen for these four keys.

## 9. User Flow

`/agents` path:

1. User types `/agents`.
2. User picks Running agents.
3. User picks one agent.
4. View picker opens.
5. User arrows to a view and presses Enter, **or** presses `t` `i` `p` `o`.
6. Overlay opens on that view.
7. User presses `t` `i` `p` `o` to switch views.
8. Esc closes the overlay. The running-agent list returns.

FleetView fast path:

1. User activates FleetView. An agent row is selected.
2. User presses `p` (or `t` / `i` / `o`).
3. Overlay opens on that view. No picker.

FleetView slow path:

1. User activates FleetView. An agent row is selected.
2. User presses Enter.
3. View picker opens.
4. User arrows + Enter, or presses `t` `i` `p` `o`.
5. Overlay opens on that view.

## 10. Success Metrics

No product telemetry.

- Manual: `/agents` picker opens all four views. Keys and arrows both work.
- Manual: FleetView `p` on an agent row opens Prompt. Enter still opens the picker.
- Manual: Prompt text equals the Agent-tool `prompt` when `inherit_context` is on.
- Tests: picker and overlay consume `t` `i` `p` `o`. Composer does not switch views. FleetView does not type `p` into the editor.

## 11. Edge Cases & Failure Modes

- Agent still running: Output shows `No output yet.` Transcript stays live.
- Agent queued, no session: Transcript keeps today’s “no session” notice if chosen. Prompt and Info still open from the record.
- Record spawned before this change: Prompt shows `No prompt stored.`
- Resume adds more user messages: Prompt still shows the first spawn prompt.
- `showCost` off: Info omits cost.
- Steer composer open: letter keys go to the input.
- Stop armed (`x` once): `t` `i` `p` `o` disarm stop and switch view.
- FleetView on `main` or a workflow: `t` `i` `p` `o` do not open the agent overlay.
- FleetView inactive (editor focused): `t` `i` `p` `o` type into the editor as today.
- Very long prompt/result: cap and show the Transcript truncation note.
- Overlay width under 6 columns: keep current empty render.

## 12. Open Questions

None that block build. Locked:

- FleetView: picker on Enter, and `t` `i` `p` `o` on the selected agent row.
- Prompt: first spawn prompt only.
- Output: always listed. Empty copy is `No output yet.`

## 13. Acceptance Criteria

- Given I pick an agent in `/agents` → Running agents, when the next UI opens, then I see Transcript, Info, Prompt, Output.
- Given that picker, when I press Down to Output and press Enter, then the overlay opens on Output.
- Given that picker, when I press `p`, then the overlay opens on Prompt with no extra Enter.
- Given FleetView is active and an agent row is selected, when I press `i`, then the overlay opens on Info and `i` is not typed into the editor.
- Given FleetView is active and an agent row is selected, when I press Enter, then the view picker opens.
- Given FleetView is active on `main`, when I press `p`, then no agent overlay opens.
- Given the overlay is on Transcript, when I press `p`, then the body is the spawn prompt and the header says Prompt.
- Given `inherit_context` was on, when I open Prompt, then I do not see parent conversation text.
- Given the overlay is on Info, then I see model, thinking, tool count, elapsed time, and start/end or `running`, and I do not see turns.
- Given a completed agent with `result`, when I press `o`, then I see only that result.
- Given a running agent with no result, when I open Output, then I see `No output yet.`
- Given I am on Prompt, when I press `t`, then I am back on Transcript and the overlay did not close.
- Given the steer composer is open, when I press `p`, then `p` is typed and the view does not change.
- Given any view, when I press Esc, then the overlay closes.
