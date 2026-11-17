/**
 * mention.ts — the `@handle` grammar for messaging a subagent from the prompt.
 *
 * Claude Code lets you type `@code-review take another look` at the prompt and
 * routes the message to that agent instead of the main model. Its grammar is
 * reproduced here so the two behave identically:
 *
 *   - suggestions fire on `@` at the start of the input or after whitespace,
 *     followed by `[\w-]*` (so `@src/foo.ts` is a file, never an agent);
 *   - a send is recognized only at the START of the input, and only with a
 *     non-empty message after the handle. That is why a bare `@code-review`
 *     goes to the main model rather than anywhere near the agent.
 *
 * A record's own identity is a UUID plus a deliberately non-unique description,
 * neither of which is typeable, so the handle is derived from the agent type.
 * Colliding handles are numbered (`explore`, `explore-2`), which is also what
 * Claude Code's `allocateName` does — it recycles a name only once the task
 * behind it is gone. Its SendMessage prompt describes the *registry* as
 * latest-wins, which is a different thing and not how names are allocated.
 */

/**
 * Suggestion trigger: `@` at a token boundary plus the partial handle typed so
 * far, including CJK sentence-ending punctuation as a boundary.
 */
export const MENTION_TRIGGER = /(^|[\s。、？！])@([\w-]*)$/;

/** Send grammar: leading `@handle`, then a non-empty message. */
const MENTION_SEND = /^@([\w-]+)\s+([\s\S]+)$/;

/**
 * Upper bound on a handle. Nothing here generates
 * a name this long, but an agent type or a model-supplied name can be arbitrary
 * text, and an unbounded handle would wrap the suggestion popup.
 */
const MAX_HANDLE_LENGTH = 64;

/**
 * Handles that address something other than a subagent, and so can never be
 * allocated to one. This name is refused at spawn and routed to the main conversation instead.
 */
const RESERVED_HANDLES: ReadonlySet<string> = new Set(["main"]);

/** Whether `@handle` names the main conversation rather than any subagent. */
export function isReservedHandle(handle: string): boolean {
  return RESERVED_HANDLES.has(handle.toLowerCase());
}

/** Slug of an agent type or name, restricted to the `[\w-]` the grammar allows. */
export function handleBase(type: string): string {
  const slug = type.toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_HANDLE_LENGTH)
    // The slice can land mid-run and leave the trailing hyphen back.
    .replace(/-+$/, "");
  return slug || "agent";
}

/**
 * `base`, else `base-2`, `base-3`, … — the first form that is neither `taken`
 * nor reserved. Callers pass one shared `taken` set covering type-derived
 * handles and model-supplied aliases alike, so the two can never collide.
 */
export function assignHandle(base: string, taken: ReadonlySet<string>): string {
  let candidate = base;
  let n = 1;
  while (taken.has(candidate) || RESERVED_HANDLES.has(candidate)) {
    n++;
    candidate = `${base}-${n}`;
  }
  return candidate;
}

/**
 * Map a typed handle back to a registered agent type, so `@explore fix it`
 * reaches the Explore agent even when no instance has ever run. `handleBase` is
 * the single source of truth in both directions, so a type is addressable by
 * exactly the handle its instances would be given.
 */
export function resolveHandleToType(handle: string, types: readonly string[]): string | undefined {
  const wanted = handle.toLowerCase();
  // A type slugging to a reserved name is unaddressable rather than shadowing
  // it — `assignHandle` refuses that name too, so its instances never hold one.
  if (RESERVED_HANDLES.has(wanted)) return undefined;
  return types.find(type => handleBase(type) === wanted);
}

/**
 * Claude Code documents `@agent-<name>` as the form you type by hand when the
 * picker isn't involved. Accepted here as an exact synonym: the caller tries the
 * handle as written first, so an agent genuinely called `agent-foo` still wins
 * over `@agent-` + `foo`, and only falls back to this when that finds nothing.
 * Returns undefined when the prefix is absent or is the whole handle.
 */
export function stripAgentPrefix(handle: string): string | undefined {
  const rest = /^agent-(.+)$/i.exec(handle)?.[1];
  return rest || undefined;
}

/**
 * A spawn needs the short description every agent surface renders. A mention
 * carries no separate label, so the message itself becomes one: first line,
 * whitespace collapsed, clipped to roughly the 3-5 words the Agent tool asks of
 * the model.
 */
export function describeMention(message: string): string {
  const oneLine = message.split("\n", 1)[0].replace(/\s+/g, " ").trim();
  return oneLine.length > 40 ? `${oneLine.slice(0, 39).trimEnd()}…` : oneLine;
}

/**
 * What Claude Code sends the main model when a mention names an agent it could
 * start. Its `@agent-<type>` mention is not a spawn at all: it becomes an
 * `agent_mention` attachment, which renders to a synthetic `isMeta` user
 * message placed after the user's own untouched text — no tool forcing, no
 * allowed-tools narrowing, and the Task tool is not even named. The model reads
 * this and calls the tool itself.
 *
 * Fixed wording, trailing space before the closing newline
 * included, so the wording the model was trained
 * against is the wording it gets. The one substitution is ours: pi's equivalent
 * of Task is the `Agent` tool, and the agent listing that teaches valid
 * `subagent_type` values is the tool spec rather than a separate attachment.
 */
export function agentMentionReminder(type: string): string {
  return `<system-reminder>\nThe user has expressed a desire to invoke the agent "${type}". Please invoke the agent appropriately, passing in the required context to it. \n</system-reminder>`;
}

/**
 * Split `@handle message` into its parts, or null when the text isn't a send —
 * a bare handle, a leading file path, or a mention that isn't at the start.
 */
export function parseMention(text: string): { handle: string; message: string } | null {
  const match = MENTION_SEND.exec(text);
  if (!match) return null;
  const message = match[2].trim();
  return message ? { handle: match[1], message } : null;
}
