/**
 * agent-guards.ts — Lightweight safety checks for agent dispatch.
 *
 * Provides read-only detection, concurrent-activity warnings, and file-overlap
 * detection for parallel dispatch.  These were extracted from the now-removed
 * the original I/O module so the core dispatch path can use them standalone.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemberFileDecl {
  memberIndex: number;
  displayName: string;
  files: string[];
}

export interface FileOverlap {
  file: string;
  members: Array<{ index: number; displayName: string }>;
}

// ---------------------------------------------------------------------------
// isAgentReadOnly
// ---------------------------------------------------------------------------

/**
 * Return true if the agent is considered read-only based on its explicit tool list.
 *
 * Detection rule:
 *  - If `builtinToolNames` is undefined (no explicit list) → assume writable → false.
 *  - If `builtinToolNames` is set but includes neither "edit" nor "write" → read-only → true.
 *  - Otherwise → writable → false.
 */
export function isAgentReadOnly(
  builtinToolNames: string[] | undefined,
  disallowedTools?: string[],
): boolean {
  const denied = disallowedTools
    ? new Set(disallowedTools.map((t) => t.toLowerCase()))
    : undefined;

  if (!builtinToolNames) {
    // No explicit allowlist ⟹ all tools are available by default.
    // The agent is only read-only if both edit AND write are explicitly denied.
    if (!denied) return false;
    return denied.has("edit") && denied.has("write");
  }

  // Start from the explicit allowlist, then remove denylisted tools.
  const effective = new Set(builtinToolNames.map((t) => t.toLowerCase()));
  if (denied) {
    for (const t of denied) effective.delete(t);
  }
  return !effective.has("edit") && !effective.has("write");
}

// ---------------------------------------------------------------------------
// formatConcurrentActivityNote
// ---------------------------------------------------------------------------

/**
 * Note appended to a step's prompt when other writable, non-worktree-isolated
 * agents are active concurrently elsewhere (e.g. a sibling top-level `Agent`
 * call, not a co-dispatched sibling).
 */
export function formatConcurrentActivityNote(count: number): string {
  const plural = count === 1 ? "agent is" : "agents are";
  return (
    `Note: ${count} other writable ${plural} currently active in this working tree without worktree isolation. ` +
    `If \`git diff\`/\`git status\` or a build/test run shows changes or failures outside your assigned scope, ` +
    `they likely belong to that concurrent work — do not flag them as issues in this task unless they fall within your assigned files.`
  );
}

// ---------------------------------------------------------------------------
// findOverlappingMemberFiles
// ---------------------------------------------------------------------------

/**
 * Given an array of member file declarations, find every file claimed by more
 * than one member. Only reports the first two claimants per file — additional
 * claimants beyond the second are not enumerated (the overlap is already
 * flagged).
 */
export function findOverlappingMemberFiles(members: MemberFileDecl[]): FileOverlap[] {
  const ownerOf = new Map<string, { index: number; displayName: string }>();
  const overlaps = new Map<string, FileOverlap>();

  for (const member of members) {
    for (const file of member.files) {
      const owner = ownerOf.get(file);
      if (owner === undefined) {
        ownerOf.set(file, { index: member.memberIndex, displayName: member.displayName });
      } else {
        let overlap = overlaps.get(file);
        if (!overlap) {
          overlap = { file, members: [owner, { index: member.memberIndex, displayName: member.displayName }] };
          overlaps.set(file, overlap);
        } else {
          // Already flagged — don't add duplicate member pairs.
          const alreadyFlagged = overlap.members.some(
            (m) => m.index === member.memberIndex,
          );
          if (!alreadyFlagged) {
            overlap.members.push({ index: member.memberIndex, displayName: member.displayName });
          }
        }
      }
    }
  }

  return [...overlaps.values()];
}
