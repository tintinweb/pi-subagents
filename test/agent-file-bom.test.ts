/**
 * agent-file-bom.test.ts — agent files that begin with a UTF-8 BOM.
 *
 * Editors across the Windows/CJK world write UTF-8 with a BOM by default, so a
 * BOM-prefixed agent file is ordinary input rather than a curiosity. pi's parser
 * did not look past one before 0.84.3: the fence never matched, so frontmatter
 * came back empty and the whole file — YAML included — became the body. An agent
 * authored that way lost every field, and `tools: none` going missing meant it
 * registered with the DEFAULT toolset (bash, edit, write) instead of none — a
 * wider grant than its author wrote.
 *
 * These drive the real loader over a real file, which is what the string-level
 * tests in custom-agents/agent-file-toggle cannot reach.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { disableInContent, enableInContent } from "../src/agent-file-toggle.js";
import { loadCustomAgents } from "../src/custom-agents.js";

const BOM = "﻿";
const AGENT = `${BOM}---
description: 代码审查员
tools: none
model: anthropic/claude-haiku-4-5
---

你是一位资深的代码审查员。请仔细检查代码。`;

describe("BOM-prefixed agent files", () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalAgentDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-bom-"));
    originalHome = process.env.HOME;
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = tmpDir;
    delete process.env.PI_CODING_AGENT_DIR;
  });

  afterEach(() => {
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Write an agent file and return its path. */
  function writeAgent(name: string, content: string): string {
    const dir = join(tmpDir, ".agents", "agents");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${name}.md`);
    writeFileSync(path, content, "utf-8");
    return path;
  }

  it("loads every field, rather than dropping them behind the BOM", () => {
    writeAgent("审查员", AGENT);

    const agent = loadCustomAgents(tmpDir).get("审查员");

    expect(agent?.description).toBe("代码审查员");
    expect(agent?.model).toBe("anthropic/claude-haiku-4-5");
    expect(agent?.systemPrompt).toBe("你是一位资深的代码审查员。请仔细检查代码。");
    // The YAML must not survive into the prompt — the symptom of the fence miss.
    expect(agent?.systemPrompt).not.toContain("---");
  });

  it("honours `tools: none` instead of granting the default toolset", () => {
    writeAgent("审查员", AGENT);

    const agent = loadCustomAgents(tmpDir).get("审查员");

    // The sharp edge: dropped frontmatter used to leave this agent holding
    // bash, edit and write — the opposite of what the file asked for.
    expect(agent?.builtinToolNames).toEqual([]);
  });

  it("handles BOM + CRLF together, which is what a Windows editor writes", () => {
    // The combination, not either alone: the same editors that add a BOM also
    // write CRLF, so this is the likeliest shape of a real file — and the eol
    // detection reads lines[0], which is the line the BOM sits on.
    const crlf = `${BOM}---\r\ndescription: 代码审查员\r\ntools: none\r\n---\r\n\r\n你是审查员。\r\n`;
    const path = writeAgent("审查员", crlf);

    expect(loadCustomAgents(tmpDir).get("审查员")?.description).toBe("代码审查员");

    const { content, outcome } = disableInContent(readFileSync(path, "utf-8"));
    expect(outcome).toBe("disabled");
    expect(content.startsWith(BOM)).toBe(true);
    // No lone LF crept in — the file's line endings survive the edit.
    expect(/[^\r]\n/.test(content)).toBe(false);
    expect(enableInContent(content).content).toBe(crlf);
  });

  it("still refuses a BOM-prefixed file that has no frontmatter at all", () => {
    // The BOM must not be treated as licence to invent a block that isn't there.
    const { content, outcome } = disableInContent(`${BOM}没有前置数据。\n`);

    expect(outcome).toBe("no-frontmatter");
    expect(content).toBe(`${BOM}没有前置数据。\n`);
  });

  it("disables and re-enables on disk, leaving the file byte-identical", () => {
    const path = writeAgent("审查员", AGENT);

    writeFileSync(path, disableInContent(readFileSync(path, "utf-8")).content, "utf-8");
    expect(loadCustomAgents(tmpDir).get("审查员")?.enabled).toBe(false);
    expect(readFileSync(path, "utf-8").startsWith(BOM)).toBe(true);

    writeFileSync(path, enableInContent(readFileSync(path, "utf-8")).content, "utf-8");
    expect(loadCustomAgents(tmpDir).get("审查员")?.enabled).not.toBe(false);
    expect(readFileSync(path, "utf-8")).toBe(AGENT);
  });
});
