/**
 * annotations.ts — Display-only text another extension attaches to an agent's
 * row (#441).
 *
 * Each annotation is owned by a caller-chosen key, so two extensions never
 * overwrite each other. The text lives on the record and only the row
 * renderers read it: it never reaches the model, a notification, a saved
 * record or an event, and it is dropped when the record is swept.
 */

import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentRecord } from "./types.js";

/** Theme tokens a caller may color its segment with — never raw ANSI. */
export const ANNOTATION_TONES = ["dim", "muted", "accent", "success", "warning", "error"] as const;
export type AnnotationTone = (typeof ANNOTATION_TONES)[number];

export interface Annotation {
  text: string;
  tone: AnnotationTone;
}

export const ANNOTATION_KEY_MAX = 32;
/** Columns per segment: a fleet row has little room, and the name must survive. */
export const ANNOTATION_TEXT_MAX = 48;

/**
 * The one write path for annotations: validates, sanitizes, caps, and deletes
 * the key on empty text. Throws with the message the caller sees.
 */
export function setAnnotation(record: AgentRecord, key: unknown, text: unknown, tone: unknown = "dim"): void {
  if (typeof key !== "string" || key.length === 0 || key.length > ANNOTATION_KEY_MAX) {
    throw new Error(`Annotation key must be a non-empty string of at most ${ANNOTATION_KEY_MAX} characters`);
  }
  if (typeof text !== "string") throw new Error("Annotation text must be a string");
  if (!ANNOTATION_TONES.includes(tone as AnnotationTone)) {
    throw new Error(`Annotation tone must be one of: ${ANNOTATION_TONES.join(", ")}`);
  }
  // A row is one line: escape sequences would corrupt its width math, and a
  // newline or other control character would break it in two.
  const clean = stripTerminalSequences(text).replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim();
  if (clean.length === 0) {
    record.annotations?.delete(key);
    return;
  }
  record.annotations ??= new Map();
  // Stripped again: truncation appends a style reset, and the stored text must
  // be plain so each renderer can color it.
  const capped = stripTerminalSequences(truncateToWidth(clean, ANNOTATION_TEXT_MAX, "…"));
  record.annotations.set(key, { text: capped, tone: tone as AnnotationTone });
}

/** The record's annotations in the order their keys were first set. */
export function annotationSegments(record: AgentRecord | undefined): Annotation[] {
  return record?.annotations ? [...record.annotations.values()] : [];
}
