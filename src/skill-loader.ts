/**
 * skill-loader.ts — Preload specific skill files and inject their content into the system prompt.
 *
 * When skills is a string[], reads each named skill from Pi's filesystem skill locations
 * and returns their content for injection into the agent system prompt.
 */

import type { Dirent } from "node:fs";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { isSymlink, isUnsafeName, safeReadFile } from "./memory.js";

export interface PreloadedSkill {
  name: string;
  content: string;
}

interface SkillSearchDir {
  path: string;
  flatFiles: boolean;
}

/**
 * Attempt to load named skills from project and global skill directories.
 * Supports Pi's standard <name>/SKILL.md layout and legacy flat skill files.
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
      results.push({ name, content: `(Skill "${name}" not found in Pi filesystem skill locations)` });
    }
  }

  return results;
}

/**
 * Search for a skill file in project and global directories.
 * Project-level locations take priority over global locations.
 */
function findAndReadSkill(name: string, cwd: string): string | undefined {
  for (const dir of skillSearchDirs(cwd)) {
    const content = tryReadSkillFile(dir, name);
    if (content !== undefined) return content;
  }

  return undefined;
}

/** Return skill roots in Pi discovery precedence order. */
function skillSearchDirs(cwd: string): SkillSearchDir[] {
  const dirs: SkillSearchDir[] = [];
  for (const dir of ancestorDirs(cwd)) {
    dirs.push({ path: join(dir, ".pi", "skills"), flatFiles: true });
    dirs.push({ path: join(dir, ".agents", "skills"), flatFiles: false });
  }
  dirs.push({ path: join(getAgentDir(), "skills"), flatFiles: true });
  dirs.push({ path: join(homedir(), ".agents", "skills"), flatFiles: false });
  dirs.push({ path: join(homedir(), ".pi", "skills"), flatFiles: true }); // Backward-compatible legacy location.
  return dedupeDirs(dirs);
}

function ancestorDirs(cwd: string): string[] {
  const dirs: string[] = [];
  let current = cwd;
  while (true) {
    dirs.push(current);
    const parent = dirname(current);
    if (parent === current) return dirs;
    current = parent;
  }
}

function dedupeDirs(values: SkillSearchDir[]): SkillSearchDir[] {
  const seen = new Set<string>();
  const result: SkillSearchDir[] = [];
  for (const value of values) {
    if (seen.has(value.path)) continue;
    seen.add(value.path);
    result.push(value);
  }
  return result;
}

/**
 * Try to read a skill file from a root directory.
 * Tries standard directory skills before legacy flat files.
 */
function tryReadSkillFile(dir: SkillSearchDir, name: string): string | undefined {
  const directDirectorySkill = tryReadSkillDirectory(join(dir.path, name));
  if (directDirectorySkill !== undefined) return directDirectorySkill;

  if (dir.flatFiles) {
    const flatSkill = tryReadFlatSkill(dir.path, name);
    if (flatSkill !== undefined) return flatSkill;
  }

  for (const skillDir of recursiveSkillDirs(dir.path, name)) {
    const content = tryReadSkillDirectory(skillDir);
    if (content !== undefined) return content;
  }

  return undefined;
}

function tryReadSkillDirectory(skillDir: string): string | undefined {
  if (isSymlink(skillDir)) return undefined;
  return safeReadFile(join(skillDir, "SKILL.md"))?.trim();
}

function tryReadFlatSkill(dir: string, name: string): string | undefined {
  const candidates = [join(dir, `${name}.md`), join(dir, `${name}.txt`), join(dir, name)];

  for (const path of candidates) {
    // safeReadFile rejects symlinked files to prevent reading arbitrary files
    const content = safeReadFile(path);
    if (content !== undefined) return content.trim();
  }

  return undefined;
}

function recursiveSkillDirs(dir: string, name: string): string[] {
  if (!existsSync(dir)) return [];
  const candidates: string[] = [];
  const stack = [dir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;

    let entries: Dirent<string>[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(current, entry.name);
      if (entry.name === name) candidates.push(path);
      if (path !== join(dir, name)) stack.push(path);
    }
  }

  return candidates;
}
