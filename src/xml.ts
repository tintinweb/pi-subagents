/**
 * xml.ts — escaping for the `<task-notification>` payloads.
 *
 * A module of its own because both notification builders need it and they sit
 * on opposite sides of a dependency edge: the agent one lives in `index.ts`,
 * which imports `workflow/task.ts`, so the workflow one cannot reach back for
 * it without a cycle.
 */

/** Escape XML special characters to prevent injection in structured notifications. */
export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
