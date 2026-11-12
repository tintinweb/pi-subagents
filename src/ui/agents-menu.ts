/**
 * agents-menu.ts — the `/agents` command: its root menu and every page below
 * it except Settings (`settings-menu.ts`), Workflows (`workflow-menu.ts`) and
 * Scheduled jobs (`schedule-menu.ts`), which it opens.
 *
 * Running agents, agent types with their detail page (eject, disable,
 * enable), and the create wizards. The session state these read lives in
 * `index.ts` and comes in through `AgentsMenuDeps`.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionCommandContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { buildNewAgentFile, disableInContent, enableInContent, isEmptyStub, locateAgentFile, personalAgentsDir, projectAgentsDir, serializeAgentFile } from "../agent-file-toggle.js";
import type { AgentManager } from "../agent-manager.js";
import { rowDescription, sourceIndicator, sourceLegend } from "../agent-source-badge.js";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getAllTypes } from "../agent-types.js";
import type { ModelRegistry } from "../model-resolver.js";
import { packageNameForPath } from "../package-resources.js";
import type { SubagentScheduler } from "../schedule.js";
import { type AgentConfig, type AgentRecord, THINKING_LEVELS } from "../types.js";
import { isWorktreeIsolationEnabled } from "../worktree.js";
import { agentTree } from "./agent-tree.js";
import { formatDuration, getDisplayName } from "./agent-widget.js";
import { showSchedulesMenu } from "./schedule-menu.js";
import { selectItem } from "./select-item.js";
import { showWorkflowsMenu, type WorkflowMenuDeps } from "./workflow-menu.js";

export interface AgentsMenuDeps {
  pi: ExtensionAPI;
  manager: AgentManager;
  scheduler: SubagentScheduler;
  /** The Workflows page's deps; its `tasks` also give the menu's run count. */
  workflowMenuDeps: WorkflowMenuDeps;
  isWorkflowsEnabled(): boolean;
  reloadCustomAgents(): void;
  getModelLabel(type: string, registry?: ModelRegistry): string;
  /** The conversation overlay, shared with the Workflows page. */
  viewAgentConversation(ctx: ExtensionCommandContext, record: AgentRecord): Promise<void>;
  showSettings(ctx: ExtensionCommandContext): Promise<void>;
}

export function createAgentsMenu(deps: AgentsMenuDeps): { showAgentsMenu(ctx: ExtensionCommandContext): Promise<void> } {
  const { pi, manager, scheduler, workflowMenuDeps, isWorkflowsEnabled, reloadCustomAgents, getModelLabel, viewAgentConversation, showSettings } = deps;

  async function showAgentsMenu(ctx: ExtensionCommandContext) {
    reloadCustomAgents();
    const allNames = getAllTypes();

    // Each row pairs its label with the value the menu dispatches on.
    const items: { value: string; label: string }[] = [];
    const agents = runningAgentsRoster().map(row => row.record);
    if (agents.length > 0) {
      const running = agents.filter(a => a.status === "running" || a.status === "queued").length;
      const done = agents.filter(a => a.status === "completed" || a.status === "steered").length;
      items.push({ value: "running", label: `Running agents (${agents.length}) — ${running} running, ${done} done` });
    }
    if (allNames.length > 0) {
      items.push({ value: "types", label: `Agent types (${allNames.length})` });
    }
    // Shown only while the scheduler is active.
    if (scheduler.isActive()) {
      items.push({ value: "schedules", label: `Scheduled jobs (${scheduler.list().length})` });
    }
    // Workflow runs, on the same terms as scheduled jobs: shown only when the
    // feature is on, so the menu never advertises something switched off.
    if (isWorkflowsEnabled()) {
      items.push({ value: "workflows", label: `Workflows (${workflowMenuDeps.tasks.size})` });
    }
    items.push({ value: "create", label: "Create new agent" });
    items.push({ value: "settings", label: "Settings" });

    const noAgentsMsg = allNames.length === 0 && agents.length === 0
      ? "No agents found. Create specialized subagents that can be delegated to.\n\n" +
        "Each subagent has its own context window, custom system prompt, and specific tools.\n\n" +
        "Try creating: Code Reviewer, Security Auditor, Test Writer, or Documentation Writer.\n\n"
      : "";

    if (noAgentsMsg) {
      ctx.ui.notify(noAgentsMsg, "info");
    }

    const label = await ctx.ui.select("Agents", items.map(item => item.label));
    const choice = items.find(item => item.label === label)?.value;
    if (!choice) return;

    if (choice === "running") {
      await showRunningAgents(ctx);
      await showAgentsMenu(ctx);
    } else if (choice === "types") {
      await showAllAgentsList(ctx);
      await showAgentsMenu(ctx);
    } else if (choice === "schedules") {
      await showSchedulesMenu(ctx, scheduler);
      await showAgentsMenu(ctx);
    } else if (choice === "workflows") {
      await showWorkflowsMenu(ctx, workflowMenuDeps);
      await showAgentsMenu(ctx);
    } else if (choice === "create") {
      await showCreateWizard(ctx);
    } else if (choice === "settings") {
      await showSettings(ctx);
      await showAgentsMenu(ctx);
    }
  }

  /**
   * The package that provided an agent, for display only. Undefined for every
   * other source, and for a package path no currently-admitted package owns —
   * which is what a stale `sourcePath` looks like after the gate narrows.
   */
  function packageNameOf(cfg: AgentConfig | undefined): string | undefined {
    if (cfg?.source !== "package" || !cfg.sourcePath) return undefined;
    return packageNameForPath(cfg.sourcePath, process.cwd());
  }

  async function showAllAgentsList(ctx: ExtensionCommandContext) {
    const allNames = getAllTypes();
    if (allNames.length === 0) {
      ctx.ui.notify("No agents.", "info");
      return;
    }

    const configs = allNames.map(name => getAgentConfig(name));

    // One row per agent (name in the left column, model on the right); the
    // full description renders below the highlighted row via SettingsList,
    // exactly like the Settings menu — so long descriptions never wrap the list.
    // A package agent's description is prefixed with the package that provided
    // it: the `▪` badge says a package won, not which one.
    const items: SettingItem[] = allNames.map((name, i) => {
      const cfg = configs[i];
      const model = getModelLabel(name, ctx.modelRegistry);
      return {
        id: name,
        label: `${sourceIndicator(cfg)}${name}`,
        currentValue: model,
        description: rowDescription(name, cfg, packageNameOf(cfg)),
        // Single-value list so Enter "activates" the row (fires onChange with the
        // agent's id) without offering anything to actually cycle.
        values: [model],
      };
    });

    const legend = sourceLegend(configs);

    const selected = await ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
      const slTheme = getSettingsListTheme();
      const list = new SettingsList(
        items,
        Math.min(items.length, 12),
        slTheme,
        id => done(id), // Enter/Space on a row → return that agent's name
        () => done(undefined), // Esc → cancel
      );
      const container = new Container();
      container.addChild(new Text("Agent types", 0, 0));
      if (legend) container.addChild(new Text(slTheme.hint(legend), 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(list);
      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => list.handleInput?.(data),
      };
    });

    if (selected && getAgentConfig(selected)) {
      await showAgentDetail(ctx, selected);
      await showAllAgentsList(ctx);
    }
  }

  /**
   * The session's agents plus their nested children, as a tree (newest
   * top-level first). Nested children are listed here as in FleetView: this
   * list keeps finished agents until eviction, so it is where a finished child
   * stays reachable. Workflow agents stay in the workflow inspector.
   */
  function runningAgentsRoster() {
    return agentTree(manager.listAgents().filter(a => a.workflowId === undefined));
  }

  async function showRunningAgents(ctx: ExtensionCommandContext) {
    const rows = runningAgentsRoster();
    if (rows.length === 0) {
      ctx.ui.notify("No agents.", "info");
      return;
    }

    // Numbered + item-paired. Two same-type agents spawned together with the
    // same description render identically here, and resolving the choice by
    // string match would open whichever came first.
    const row = await selectItem(ctx.ui, "Running agents", rows, ({ record: a, prefix }) => {
      const dn = getDisplayName(a.type);
      const dur = formatDuration(a.startedAt, a.completedAt);
      return `${prefix}${dn} (${a.description}) · ${a.toolUses} tools · ${a.status} · ${dur}`;
    });
    if (!row) return;
    const record = row.record;

    await viewAgentConversation(ctx, record);
    // Back-navigation: re-show the list
    await showRunningAgents(ctx);
  }

  async function showAgentDetail(ctx: ExtensionCommandContext, name: string) {
    const cfg = getAgentConfig(name);
    if (!cfg) {
      ctx.ui.notify(`Agent config not found for "${name}".`, "warning");
      return;
    }

    const isPackage = cfg.source === "package";
    const file = locateAgentFile(name, cfg.sourcePath, undefined, cfg.source);
    const isDefault = cfg.isDefault === true;
    const disabled = cfg.enabled === false;

    let menuOptions: string[];
    if (isPackage) {
      // Read-only: nothing here may write inside pi's install root. `Disable`
      // still appears because it writes a *local* stub that shadows the package
      // agent, and `Enable` never does — a package agent that reads as disabled
      // was disabled by its own author's `enabled: false`, which only the
      // package can take back. Eject is the way out of that: the copy it writes
      // carries no `enabled:` line, so the ejected agent is on.
      menuOptions = disabled
        ? ["Eject (export as .md)", "Back"]
        : ["Eject (export as .md)", "Disable", "Back"];
    } else if (disabled && file) {
      // Disabled agent with a file — offer Enable
      menuOptions = isDefault
        ? ["Enable", "Edit", "Reset to default", "Delete", "Back"]
        : ["Enable", "Edit", "Delete", "Back"];
    } else if (isDefault && !file) {
      // Default agent with no .md override
      menuOptions = ["Eject (export as .md)", "Disable", "Back"];
    } else if (isDefault && file) {
      // Default agent with .md override (ejected)
      menuOptions = ["Edit", "Disable", "Reset to default", "Delete", "Back"];
    } else {
      // User-defined agent
      menuOptions = ["Edit", "Disable", "Delete", "Back"];
    }

    // Name the package in the title: this menu's options are the read-only set,
    // and "which package do I have to uninstall or allowlist away" is the
    // question they raise.
    const pkgName = packageNameOf(cfg);
    const choice = await ctx.ui.select(pkgName ? `${name} — ${pkgName}` : name, menuOptions);
    if (!choice || choice === "Back") return;

    if (choice === "Edit" && file) {
      const content = readFileSync(file.path, "utf-8");
      const edited = await ctx.ui.editor(`Edit ${name}`, content);
      if (edited !== undefined && edited !== content) {
        writeFileSync(file.path, edited, "utf-8");
        reloadCustomAgents();
        ctx.ui.notify(`Updated ${file.path}`, "info");
      }
    } else if (choice === "Delete") {
      if (file) {
        const confirmed = await ctx.ui.confirm("Delete agent", `Delete ${name} from ${file.location} (${file.path})?`);
        if (confirmed) {
          unlinkSync(file.path);
          reloadCustomAgents();
          ctx.ui.notify(`Deleted ${file.path}`, "info");
        }
      }
    } else if (choice === "Reset to default" && file) {
      const confirmed = await ctx.ui.confirm("Reset to default", `Delete override ${file.path} and restore embedded default?`);
      if (confirmed) {
        unlinkSync(file.path);
        reloadCustomAgents();
        ctx.ui.notify(`Restored default ${name}`, "info");
      }
    } else if (choice.startsWith("Eject")) {
      await ejectAgent(ctx, name, cfg);
    } else if (choice === "Disable") {
      await disableAgent(ctx, name);
    } else if (choice === "Enable") {
      await enableAgent(ctx, name);
    }
  }

  /** Eject a default agent: write its embedded config as a .md file. */
  async function ejectAgent(ctx: ExtensionCommandContext, name: string, cfg: AgentConfig) {
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
      if (!overwrite) return;
    }

    const content = serializeAgentFile(cfg);

    writeFileSync(targetPath, content, "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Ejected ${name} to ${targetPath}`, "info");
  }

  /** Disable an agent: set enabled: false in its .md file, or create a stub for built-in defaults. */
  async function disableAgent(ctx: ExtensionCommandContext, name: string) {
    const cfg = getAgentConfig(name);
    // `locateAgentFile` refuses a package agent's own path, so this is either the
    // local stub already shadowing it or nothing — never a file inside pi's
    // install root. An unshadowed package agent therefore falls to the stub
    // branch below, which writes `enabled: false` at project or personal scope.
    const file = locateAgentFile(name, cfg?.sourcePath, undefined, cfg?.source);
    if (file) {
      // Existing file — set enabled: false in frontmatter (idempotent)
      const content = readFileSync(file.path, "utf-8");
      const { content: updated, outcome } = disableInContent(content);
      if (outcome === "already-disabled") {
        ctx.ui.notify(`${name} is already disabled.`, "info");
        return;
      }
      if (outcome === "no-frontmatter") {
        // Nothing to edit — say so rather than rewriting the file unchanged and
        // reporting success for a change that never happened.
        ctx.ui.notify(`Cannot disable ${name}: ${file.path} has no frontmatter block.`, "error");
        return;
      }
      writeFileSync(file.path, updated, "utf-8");
      reloadCustomAgents();
      ctx.ui.notify(`Disabled ${name} (${file.path})`, "info");
      return;
    }

    // No editable file (a built-in default, or a package-provided agent) —
    // create a stub that shadows it.
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    writeFileSync(targetPath, "---\nenabled: false\n---\n", "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Disabled ${name} (${targetPath})`, "info");
  }

  /** Enable a disabled agent by removing enabled: false from its frontmatter. */
  async function enableAgent(ctx: ExtensionCommandContext, name: string) {
    const cfg = getAgentConfig(name);
    const file = locateAgentFile(name, cfg?.sourcePath, undefined, cfg?.source);
    if (!file) return;

    const content = readFileSync(file.path, "utf-8");
    const { content: updated, changed } = enableInContent(content);
    if (!changed && !isEmptyStub(updated)) {
      // The file carries no `enabled: false` to remove, so it was never disabled
      // by us — reporting success here would hide a no-op.
      ctx.ui.notify(`${name} is not disabled in ${file.path}.`, "info");
      return;
    }

    // If the file was just a stub ("---\n---\n"), delete it to restore the built-in default
    if (isEmptyStub(updated)) {
      unlinkSync(file.path);
      reloadCustomAgents();
      ctx.ui.notify(`Enabled ${name} (removed ${file.path})`, "info");
    } else {
      writeFileSync(file.path, updated, "utf-8");
      reloadCustomAgents();
      ctx.ui.notify(`Enabled ${name} (${file.path})`, "info");
    }
  }

  async function showCreateWizard(ctx: ExtensionCommandContext) {
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();

    const method = await ctx.ui.select("Creation method", [
      "Generate with Claude (recommended)",
      "Manual configuration",
    ]);
    if (!method) return;

    if (method.startsWith("Generate")) {
      await showGenerateWizard(ctx, targetDir);
    } else {
      await showManualWizard(ctx, targetDir);
    }
  }

  async function showGenerateWizard(ctx: ExtensionCommandContext, targetDir: string) {
    const description = await ctx.ui.input("Describe what this agent should do");
    if (!description) return;

    const name = await ctx.ui.input("Agent name (filename, no spaces)");
    if (!name) return;

    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
      if (!overwrite) return;
    }

    ctx.ui.notify("Generating agent definition...", "info");

    const generatePrompt = `Create a custom pi sub-agent definition file based on this description: "${description}"

Write a markdown file to: ${targetPath}

The file format is a markdown file with YAML frontmatter and a system prompt body:

\`\`\`markdown
---
description: <one-line description shown in UI>
color: <optional agent name badge color: red, blue, green, yellow, purple, orange, pink, cyan, an Agency Agents alias, or quoted "#RRGGBB">
tools: <comma-separated built-in tools: read, bash, edit, write, grep, find, ls. Use "none" for no tools. Omit for all tools>
model: <optional model as "provider/modelId", e.g. "anthropic/claude-haiku-4-5". Omit to inherit parent model>
thinking: <optional thinking level: ${THINKING_LEVELS.join(", ")}. Omit to inherit>
max_turns: <optional max agentic turns. 0 or omit for unlimited (default)>
prompt_mode: <"replace" (body IS the full system prompt) or "append" (body is appended to default prompt). Default: replace>
extensions: <true (inherit all MCP/extension tools), false (none), or comma-separated names. Default: true>
skills: <true (inherit all), false (none), or comma-separated skill names to preload into prompt. Default: true>
disallowed_tools: <comma-separated tool names to block, even if otherwise available. Omit for none>
inherit_context: <true to fork parent conversation into agent so it sees chat history. Default: false>
run_in_background: <pin this agent to background (true) or foreground (false). Omit to follow the backgroundByDefault setting, which is background>
output_transcript: <false to write no transcript file or path for this agent. Independent of persist_session. Default: true>
isolated: <true for no extension/MCP tools, only built-in tools. Default: false>
memory: <"user" (global), "project" (per-project), or "local" (gitignored per-project) for persistent memory. Omit for none>${
      // Offering the field on a project that turned worktrees off would bake a
      // request that is refused at spawn time into a file that outlives the
      // session — the #231 pathology (models fill the fields they are shown)
      // one layer up. Built per invocation, so this read is live.
      isWorktreeIsolationEnabled()
        ? `\nisolation: <"worktree" to run in isolated git worktree; "off" to refuse one even when the caller asks. Omit for normal>`
        : ""
    }
---

<system prompt body — instructions for the agent>
\`\`\`

Guidelines for choosing settings:
- For read-only tasks (review, analysis): tools: read, bash, grep, find, ls
- For code modification tasks: include edit, write
- Use prompt_mode: append if the agent should keep the default system prompt and add specialization on top
- Use prompt_mode: replace for fully custom agents with their own personality/instructions
- Set inherit_context: true if the agent needs to know what was discussed in the parent conversation
- Set isolated: true if the agent should NOT have access to MCP servers or other extensions
- Set output_transcript: false to skip writing this agent's transcript; this alone doesn't keep the run off disk (persist_session, isolation: worktree commits, and memory still write) — set those too if that's the goal
- Only include frontmatter fields that differ from defaults — omit fields where the default is fine

Write the file using the write tool. Only write the file, nothing else.`;

    const { record } = await manager.spawnAndWait(pi, ctx, "general-purpose", generatePrompt, {
      description: `Generate ${name} agent`,
      maxTurns: 5,
      // Exempt from maxConcurrentForeground. This runs from a modal wizard, not
      // a tool call: it passes no signal, and Esc in `ctx.ui` never reaches the
      // manager — so a user waiting behind a full pool would have no way to
      // cancel at all. It is also one human action that cannot fan out, which
      // is what the limit exists to bound. It still counts once started.
      bypassQueue: true,
    });

    if (record.status === "error") {
      ctx.ui.notify(`Generation failed: ${record.error}`, "warning");
      return;
    }

    reloadCustomAgents();

    if (existsSync(targetPath)) {
      ctx.ui.notify(`Created ${targetPath}`, "info");
    } else {
      ctx.ui.notify("Agent generation completed but file was not created. Check the agent output.", "warning");
    }
  }

  async function showManualWizard(ctx: ExtensionCommandContext, targetDir: string) {
    // 1. Name
    const name = await ctx.ui.input("Agent name (filename, no spaces)");
    if (!name) return;

    // 2. Description
    const description = await ctx.ui.input("Description (one line)");
    if (!description) return;

    // 3. Tools
    const toolChoice = await ctx.ui.select("Tools", ["all", "none", "read-only (read, bash, grep, find, ls)", "custom..."]);
    if (!toolChoice) return;

    let tools: string;
    if (toolChoice === "all") {
      tools = BUILTIN_TOOL_NAMES.join(", ");
    } else if (toolChoice === "none") {
      tools = "none";
    } else if (toolChoice.startsWith("read-only")) {
      tools = "read, bash, grep, find, ls";
    } else {
      const customTools = await ctx.ui.input("Tools (comma-separated)", BUILTIN_TOOL_NAMES.join(", "));
      if (!customTools) return;
      tools = customTools;
    }

    // 4. Model
    const modelChoice = await ctx.ui.select("Model", [
      "inherit (parent model)",
      "haiku",
      "sonnet",
      "opus",
      "custom...",
    ]);
    if (!modelChoice) return;

    let model: string | undefined;
    if (modelChoice === "haiku") model = "anthropic/claude-haiku-4-5";
    else if (modelChoice === "sonnet") model = "anthropic/claude-sonnet-4-6";
    else if (modelChoice === "opus") model = "anthropic/claude-opus-4-6";
    else if (modelChoice === "custom...") {
      model = (await ctx.ui.input("Model (provider/modelId)")) || undefined;
    }

    // 5. Thinking
    // "inherit" is a UI-only pseudo-choice (omit the field); the rest mirror pi.
    const thinkingChoice = await ctx.ui.select("Thinking level", ["inherit", ...THINKING_LEVELS]);
    if (!thinkingChoice) return;

    // 6. System prompt
    const systemPrompt = await ctx.ui.editor("System prompt", "");
    if (systemPrompt === undefined) return;

    const content = buildNewAgentFile({
      description,
      tools,
      model,
      thinking: thinkingChoice === "inherit" ? undefined : thinkingChoice,
      systemPrompt,
    });

    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, `${name}.md`);

    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
      if (!overwrite) return;
    }

    writeFileSync(targetPath, content, "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Created ${targetPath}`, "info");
  }

  return { showAgentsMenu };
}
