/**
 * schedule-menu.ts — Interactive sub-menu under `/agents` for managing
 * scheduled subagent jobs. View / Add / Toggle / Remove / Cleanup.
 *
 * Mirrors the menu shape of pi-cron-schedule's `/schedule-prompt` command,
 * but uses the same `ctx.ui.*` patterns already used by `showAgentsMenu`
 * and `showCreateWizard` in src/index.ts.
 */

import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { SubagentScheduler } from "../schedule.js";
import type { ScheduledSubagent, SubagentType } from "../types.js";

/** Format an ISO timestamp as relative time ("in 4h 12m", "yesterday", "—"). */
function relTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = t - now;
  const abs = Math.abs(diff);
  const future = diff > 0;
  if (abs < 60_000) return future ? "in <1m" : "<1m ago";
  const m = Math.round(abs / 60_000);
  if (m < 60) return future ? `in ${m}m` : `${m}m ago`;
  const h = Math.round(abs / 3_600_000);
  if (h < 24) return future ? `in ${h}h` : `${h}h ago`;
  const d = Math.round(abs / 86_400_000);
  return future ? `in ${d}d` : `${d}d ago`;
}

/** One-line status icon. */
function statusIcon(j: ScheduledSubagent): string {
  if (!j.enabled) return "✗";
  if (j.lastStatus === "error") return "!";
  if (j.lastStatus === "running") return "⋯";
  return "✓";
}

/** Compact line for the listing — name, schedule, agent type, next/last run, count. */
function formatJob(j: ScheduledSubagent, scheduler: SubagentScheduler): string {
  const next = scheduler.getNextRun(j.id);
  const fields = [
    statusIcon(j),
    j.name.padEnd(18).slice(0, 18),
    j.schedule.padEnd(14).slice(0, 14),
    `[${j.subagent_type}]`,
    `next ${relTime(next)}`,
    `last ${relTime(j.lastRun)}`,
    `runs ${j.runCount}`,
  ];
  return fields.join("  ");
}

export async function showSchedulesMenu(
  ctx: ExtensionCommandContext,
  scheduler: SubagentScheduler,
  agentTypes: readonly string[],
): Promise<void> {
  if (!scheduler.isActive()) {
    ctx.ui.notify("Scheduler is not active in this session.", "warning");
    return;
  }

  const jobs = scheduler.list();
  const summary = jobs.length === 0
    ? "No scheduled jobs."
    : `${jobs.length} job${jobs.length === 1 ? "" : "s"}`;

  const options = [
    `View all jobs (${jobs.length})`,
    "Add new job",
  ];
  if (jobs.length > 0) {
    options.push("Toggle enabled");
    options.push("Remove job");
    if (jobs.some(j => !j.enabled)) options.push("Cleanup disabled");
  }

  const choice = await ctx.ui.select(`Scheduled jobs — ${summary}`, options);
  if (!choice) return;

  if (choice.startsWith("View all jobs")) {
    await viewJobs(ctx, scheduler);
    await showSchedulesMenu(ctx, scheduler, agentTypes);
  } else if (choice === "Add new job") {
    await addJobWizard(ctx, scheduler, agentTypes);
    await showSchedulesMenu(ctx, scheduler, agentTypes);
  } else if (choice === "Toggle enabled") {
    await toggleJob(ctx, scheduler);
    await showSchedulesMenu(ctx, scheduler, agentTypes);
  } else if (choice === "Remove job") {
    await removeJob(ctx, scheduler);
    await showSchedulesMenu(ctx, scheduler, agentTypes);
  } else if (choice === "Cleanup disabled") {
    const removed = scheduler.cleanupDisabled();
    ctx.ui.notify(`Removed ${removed} disabled job${removed === 1 ? "" : "s"}.`, "info");
    await showSchedulesMenu(ctx, scheduler, agentTypes);
  }
}

async function viewJobs(ctx: ExtensionCommandContext, scheduler: SubagentScheduler): Promise<void> {
  const jobs = scheduler.list();
  if (jobs.length === 0) {
    ctx.ui.notify("No scheduled jobs.", "info");
    return;
  }
  // Use a select to display the list — selection navigates to detail.
  const choice = await ctx.ui.select(
    "Scheduled jobs (select for details)",
    jobs.map(j => formatJob(j, scheduler)),
  );
  if (!choice) return;
  const idx = jobs.map(j => formatJob(j, scheduler)).indexOf(choice);
  if (idx < 0) return;
  const j = jobs[idx];
  const next = scheduler.getNextRun(j.id) ?? "—";
  const lines = [
    `id:        ${j.id}`,
    `name:      ${j.name}`,
    `desc:      ${j.description}`,
    `enabled:   ${j.enabled}`,
    `schedule:  ${j.schedule} (${j.scheduleType})`,
    `agent:     ${j.subagent_type}`,
    `prompt:    ${j.prompt.slice(0, 200)}${j.prompt.length > 200 ? "…" : ""}`,
    `model:     ${j.model ?? "(default)"}`,
    `isolation: ${j.isolation ?? "—"}`,
    `created:   ${j.createdAt}`,
    `last run:  ${j.lastRun ?? "—"} (${j.lastStatus ?? "—"})`,
    `next run:  ${next}`,
    `runs:      ${j.runCount}`,
  ];
  ctx.ui.notify(lines.join("\n"), "info");
}

async function addJobWizard(
  ctx: ExtensionCommandContext,
  scheduler: SubagentScheduler,
  agentTypes: readonly string[],
): Promise<void> {
  const name = await ctx.ui.input("Job name (must be unique)", "");
  if (!name) return;

  const description = await ctx.ui.input("Short description (3–5 words)", name);
  if (!description) return;

  if (agentTypes.length === 0) {
    ctx.ui.notify("No agent types available — create one first.", "warning");
    return;
  }
  const subagent_type = await ctx.ui.select("Agent type", [...agentTypes]) as SubagentType | undefined;
  if (!subagent_type) return;

  const prompt = await ctx.ui.input("Prompt for the agent", "");
  if (!prompt) return;

  const schedule = await ctx.ui.input(
    'Schedule — cron (e.g. "0 0 9 * * 1"), interval ("5m"), or one-shot ("+10m" / ISO)',
    "",
  );
  if (!schedule) return;

  try {
    const job = scheduler.addJob({ name, description, schedule, subagent_type, prompt });
    const next = scheduler.getNextRun(job.id);
    ctx.ui.notify(
      `Scheduled "${job.name}" (id: ${job.id}). Next run: ${next ? relTime(next) : "—"}.`,
      "info",
    );
  } catch (err) {
    ctx.ui.notify(err instanceof Error ? err.message : String(err), "warning");
  }
}

async function toggleJob(ctx: ExtensionCommandContext, scheduler: SubagentScheduler): Promise<void> {
  const jobs = scheduler.list();
  if (jobs.length === 0) return;
  const labels = jobs.map(j => `${j.enabled ? "✓" : "✗"} ${j.name} (${j.schedule})`);
  const choice = await ctx.ui.select("Toggle which job?", labels);
  if (!choice) return;
  const idx = labels.indexOf(choice);
  if (idx < 0) return;
  const j = jobs[idx];
  scheduler.updateJob(j.id, { enabled: !j.enabled });
  ctx.ui.notify(`${j.name} is now ${!j.enabled ? "enabled" : "disabled"}.`, "info");
}

async function removeJob(ctx: ExtensionCommandContext, scheduler: SubagentScheduler): Promise<void> {
  const jobs = scheduler.list();
  if (jobs.length === 0) return;
  const labels = jobs.map(j => `${j.name} (${j.schedule}) — ${j.subagent_type}`);
  const choice = await ctx.ui.select("Remove which job?", labels);
  if (!choice) return;
  const idx = labels.indexOf(choice);
  if (idx < 0) return;
  const j = jobs[idx];
  const ok = await ctx.ui.confirm("Remove scheduled job", `Remove "${j.name}"?`);
  if (!ok) return;
  scheduler.removeJob(j.id);
  ctx.ui.notify(`Removed "${j.name}".`, "info");
}
