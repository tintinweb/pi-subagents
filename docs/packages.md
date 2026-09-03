# Shipping subagents in a pi package

A pi package can declare its own subagents and workflow scripts. Installing the package is then the whole setup — no copying `.md` files into every project's `.pi/agents/`, and no sync script running on container start ([#109](https://github.com/tintinweb/pi-subagents/issues/109)).

This guide is for both sides of that: authoring a package that ships agents, and controlling which packages a machine accepts them from.

For where locally-authored agents live and what their frontmatter accepts, see [`README.md`](../README.md#custom-agents).

## The idea

Pi already ships four resource types inside packages — `extensions`, `skills`, `prompts`, `themes` — declared under a `pi` key in `package.json` and installed with `pi install`. Subagents are this extension's concept, so pi knows nothing about them, and until now a package author's only option was to tell users to copy files.

The mechanism here is the same shape as pi's, with one deliberate difference: **a package must declare its agents by name.** Pi falls back to scanning conventional directories (`skills/`, `prompts/`, …) when a package has no `pi` key at all. This extension never does. A package that happens to carry an `agents/` folder for some other tool contributes nothing until it says so — that is the author's half of the agreement, and installing the package is the user's.

## Authoring

### 1. Declare the paths

```json
{
  "name": "my-subagents",
  "version": "1.0.0",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./src/index.ts"],
    "subagents": {
      "agents": ["./agents"],
      "workflows": ["./workflows"]
    }
  }
}
```

`keywords: ["pi-package"]` is pi's discoverability convention, not a requirement. The `extensions` entry is only there to show the keys coexisting — a package can ship agents and nothing else.

Adding `pi.subagents` is safe for pi itself: its manifest reader looks at `extensions`, `skills`, `prompts` and `themes` and ignores every other key.

### 2. Put the files there

```
my-subagents/
├── package.json
├── agents/
│   ├── researcher.md
│   └── reviewer.md
└── workflows/
    └── audit.js
```

An agent file is an ordinary agent `.md` — the same frontmatter a `.pi/agents/` file takes, documented in [`README.md`](../README.md#custom-agents). A workflow file is an ordinary saved workflow, and still has to carry its `export const meta = …` declaration to count as one ([`workflows.md`](workflows.md)).

```markdown
---
name: pkg-researcher
description: Research with sources, for the my-subagents toolchain
tools: read, grep, ext:my-mcp/search
model: claude-haiku-4-5
---

You research things. Cite what you read.
```

### 3. Ship it

Include the directories in the published tarball — npm's `files` field, or an `.npmignore` that does not exclude them. Then:

```bash
pi install npm:my-subagents          # published
pi install git:github.com/me/repo    # straight from git
pi install /path/to/my-subagents     # local checkout, for development
pi install ./my-subagents -l         # project scope, into .pi/settings.json
```

A local-path install is not copied, so an edit to the agent file is live on the next `Agent` call — the fastest authoring loop.

### Entry syntax

Entries are paths relative to the package root.

| Entry | Meaning |
|---|---|
| `"./agents"` | A directory. Scanned for `*.md` (`*.js` for workflows), non-recursively. |
| `"./agents/one.md"` | A single file, taken as-is. |
| `"!./agents/wip.md"` | An exclusion. Applies to a file inside an included directory, which is the only form that does anything useful. |

The exclusion may name a path the package does not ship yet, so a file added in a later version is still skipped rather than silently appearing.

Nothing outside the package root is read. The containment check runs on canonical paths, so `../../.ssh` is refused and a symlinked `agents/` pointing at `/etc` does not get around it either.

Glob patterns are deliberately **not** supported. Pi expands globs because it resolves four resource types across arbitrary layouts; here the entries are one or two directories, and answering a glob would mean walking a third-party tree.

### Accepted spellings

All four mean the same thing. The top-level `pi-subagents` key is the one [`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents) reads, so a single manifest works with either extension.

```jsonc
"pi": { "subagents": { "agents": ["./agents"], "workflows": ["./flows"] } }
"pi": { "subagents": ["./agents"] }            // shorthand for { "agents": [...] }
"pi-subagents": { "agents": ["./agents"] }
"pi-subagents": ["./agents"]                   // shorthand for { "agents": [...] }
```

`pi.subagents` wins if a package carries both.

### Naming

A package agent registers under its frontmatter `name:`, with no namespace prefix. There is no `mypkg:researcher` form (yet — the `:` character stays reserved for it, so agent names may not contain one).

That makes a name a shared space, so prefix anything that could collide: `acme-researcher` rather than `researcher`. Two packages claiming one name is last-load-wins with a warning naming the file that took over, and *any* local file claiming it takes it from both.

## Operating

### Which packages are read

Only what pi itself has installed — the `packages[]` array in pi's `settings.json`, global (`~/.pi/agent/settings.json`) and project (`.pi/settings.json`), resolved through pi's own package manager so npm, git and local sources all land on the right install root.

`node_modules` is never scanned. Being a transitive dependency of your project means nothing here, exactly as it means nothing to pi.

A package listed only by a project's settings stays invisible until you trust the project, matching pi — an untrusted `.pi/settings.json` is not read at all. This is the shape a team distributes agents in: commit the package to `.pi/settings.json`, and everyone who trusts the repo gets them.

One wrinkle on the *very first* session in a repo, before pi has saved a trust decision. The `Agent` tool's description — the list of agent types the model is told about — is built when the extension loads, which is before the trust prompt is answered. A project-scoped package's agents are registered and can be spawned by name that session, but the model is not told they exist until the next one. Once the decision is saved (or `defaultProjectTrust` is `"always"`), every later session is correct from the first turn.

### Precedence

Lowest to highest:

| | Source |
|---|---|
| 1 (lowest) | Built-in agents (`general-purpose`, `Explore`, `Plan`) |
| 2 | Installed pi packages |
| 3 | `$PI_CODING_AGENT_DIR/agents/*.md` (global) |
| 4 | `.agents/agents/*.md` (project workspace) |
| 5 (highest) | `.pi/agents/*.md` (project) |

A package can offer a `reviewer`; it can never take the name from a `reviewer` of yours. This mirrors pi's own precedence for package-provided skills and Claude Code's for plugin agents.

Saved workflows resolve first-hit-wins over the same ordering, so package directories are searched last.

One consequence worth knowing: a package agent *does* outrank a built-in. A package could ship a `general-purpose` — which is also the default `fallbackSubagent` — and take over unspecified delegation. Narrow the gate below if that matters for your setup.

### In `/agents`

A package agent is listed with a `▪` badge and is read-only: its file lives under pi's install root, where an edit is lost on the next `pi update` and a delete is undone by the next `pi install`.

The badge says a package won, not which one. The declaring package's name — the full `@scope/name`, which is also what you can write into a [`packageAgents` allowlist](#turning-it-off) — is prefixed to the description line under the highlighted row, and titles the agent's action menu.

- **Eject** copies it into your project or personal agent directory as an editable file that shadows the original. The copy carries the agent's full configuration, including `ext:` tool selectors and `persist_session`.
- **Disable** writes an `enabled: false` stub at project or personal scope, which shadows the package definition without touching it. Deleting that stub restores the package agent.

An agent the *package author* shipped with `enabled: false` shows as disabled and offers no Enable — only the package can take that back. Ejecting it is the way out: the copy is written without an `enabled:` line, so the ejected agent is on.

### Turning it off

`packageAgents` and `packageWorkflows` in [`subagents.json`](../README.md#persistent-settings) both default to `true`:

```json
{
  "packageAgents": ["my-subagents"],
  "packageWorkflows": false
}
```

| Value | Effect |
|---|---|
| `true` (or absent) | Every declaring package contributes. |
| `false` | None do. |
| `["a", "b"]` | Only those packages. |

A list entry matches the unscoped short name (`@acme/tools` → `tools`), the full package name, or the settings source string, case-insensitively. A bare string is read as a one-entry list, so a `"my-pkg"` typo narrows the gate rather than silently widening it.

The two are separate on purpose: an agent is markdown handed to a model, a workflow is JavaScript this extension executes, so package agents can be accepted while package workflow scripts are refused.

Both appear in `/agents → Settings` as on/off rows. An allowlist is hand-written in `subagents.json`; toggling the row replaces it, and the toast says what it replaced.

### Why on by default

Installing a package is already the trust decision. Pi executes an installed package's `extensions/` and puts its `skills/` descriptions in the system prompt, with no per-resource prompt — [pi's own docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) say so plainly: *"Pi packages run with full system access."*

A declared `.md` agent is strictly less privileged than what the same package already runs, so it rides the boundary the user crossed at `pi install` rather than inventing a second one. The gate exists for narrowing that anyway, not as a second install step.

## Troubleshooting

**The agent does not appear.**

1. `pi list` — is the package in pi's settings at all? Discovery reads that array, not `node_modules`, and not a `pi -e` source: a `--extension` install is resolved for that one run and never written to `packages[]`, so its agents stay invisible even though its extensions and skills load.
2. Does `package.json` carry `pi.subagents` (or `pi-subagents`)? A `pi` key that declares only `extensions` contributes no agents; the conventional `agents/` directory is not scanned.
3. Is the file `*.md` directly inside a declared directory? The scan is not recursive.
4. Does the frontmatter parse, and does it have a `name:`? A broken file is skipped with a `[pi-subagents] Skipping agent file …` warning on stderr.
5. Is `packageAgents` set to `false` or to a list that does not include it? Check `/agents → Settings → Package agents`.
6. Is the package configured only in an untrusted project's `.pi/settings.json`? Trust the project, or install it globally.

**It appears but a different one runs.** A local file of the same name outranks it. `/agents` shows the badge of whichever won — `•` project, `◦` global, `▪` package.

**Edits to the package file do nothing.** Agents reload on every `Agent` call, so a local-path install picks up edits immediately. An npm or git install is a copy under `~/.pi/agent/{npm,git}/`; edit the source and reinstall, or install the local path during development.

**A file over 1 MB is skipped.** Package files are third-party content re-read on every spawn, so there is a per-file ceiling, matching Claude Code's for plugin agents. Local files are unbounded.

**`strictAgentFiles` and a broken package file.** Strict mode fails startup over an unparseable file in *your* `.pi/agents/`, which is the point of it. It deliberately does not extend to files inside installed packages — those are not yours to fix, and one bad `.md` in a dependency should not stop pi from starting.

## Reference

| | |
|---|---|
| Manifest keys | `pi.subagents.agents`, `pi.subagents.workflows`, `pi-subagents.agents`, `pi-subagents.workflows`, plus the bare-array shorthand for each |
| Settings | `packageAgents`, `packageWorkflows` — `boolean \| string[]`, default `true` |
| Agent file layout | `<declared dir>/*.md`, non-recursive |
| Workflow file layout | `<declared dir>/*.js`, must carry `export const meta = …` |
| Per-file size ceiling | 1 MiB |
| Discovery source | pi's `settings.json → packages[]`, global and project |
| Precedence | Above built-ins, below every local agent |
| Implementation | [`src/package-resources.ts`](../src/package-resources.ts) |
