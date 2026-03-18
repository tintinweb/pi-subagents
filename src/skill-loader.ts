/**
 * skill-loader.ts — Preload specific skill files and inject their content into the system prompt.
 *
 * When skills is a string[], reads each named skill from .pi/skills/ or ~/.pi/skills/
 * and returns their content for injection into the agent's system prompt.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { isUnsafeName, safeReadFile } from "./memory.js";

export interface PreloadedSkill {
  name: string;
  content: string;
}

/**
 * Attempt to load named skills from project and global skill directories.
 * Looks for: <dir>/<name>.md, <dir>/<name>.txt, <dir>/<name>
 *
 * @param skillNames  List of skill names to preload.
 * @param cwd         Working directory for project-level skills.
 * @returns Array of loaded skills (missing skills are skipped with a warning comment).
 */
export function preloadSkills(skillNames: string[], cwd: string): PreloadedSkill[] {
  const results: PreloadedSkill[] = [];

  for (const name of skillNames) {
    // Unlike memory (which throws on unsafe names because it's part of agent setup),
    // skills are optional — skip gracefully to avoid blocking agent startup.
    if (isUnsafeName(name)) {
      results.push({ name, content: `(Skill "${name}" skipped: name contains path traversal characters)` });
      continue;
    }
    const content = findAndReadSkill(name, cwd);
    if (content !== undefined) {
      results.push({ name, content });
    } else {
      // Include a note about missing skills so the agent knows it was requested but not found
      results.push({ name, content: `(Skill "${name}" not found in .pi/skills/ or ~/.pi/skills/)` });
    }
  }

  return results;
}

/**
 * Search for a skill file in project and global directories.
 * Project-level takes priority over global.
 */
function findAndReadSkill(name: string, cwd: string): string | undefined {
  const projectDir = join(cwd, ".pi", "skills");
  const globalDir = join(homedir(), ".pi", "skills");

  // Try project first, then global
  for (const dir of [projectDir, globalDir]) {
    const content = tryReadSkillFile(dir, name);
    if (content !== undefined) return content;
  }

  return undefined;
}

/**
 * Try to read a skill file from a directory.
 * Tries extensions in order: .md, .txt, (no extension)
 */
function tryReadSkillFile(dir: string, name: string): string | undefined {
  const extensions = [".md", ".txt", ""];

  for (const ext of extensions) {
    const path = join(dir, name + ext);
    // safeReadFile rejects symlinks to prevent reading arbitrary files
    const content = safeReadFile(path);
    if (content !== undefined) return content.trim();
  }

  return undefined;
}
