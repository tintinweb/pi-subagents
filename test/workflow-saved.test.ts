// Disk discovery for saved workflows: the roots, their precedence, the guards
// that keep a model-supplied `name` from becoming a path, and the `export const
// meta =` filter that decides what counts as a workflow at all.
//
// The rest of the workflow suite stubs past this resolver (workflow-runtime.ts
// serves saved workflows out of a map), so everything here is otherwise
// unexercised.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetPackageState,
  setPackageWorkflowsGate,
  setProjectTrusted,
} from "../src/package-resources.js";
import {
  listSavedWorkflows,
  readSavedWorkflow,
  resolveWorkflowScript,
  resolveWorkflowSource,
  savedWorkflowRoots,
} from "../src/workflow/saved.js";

const SCRIPT = "export const meta = { name: 'demo', description: 'A demo' }\nreturn 1\n";

describe("saved workflows on disk", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevAgentDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-wf-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-wf-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    resetPackageState();
  });

  afterEach(() => {
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    resetPackageState();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  /** Write `name.js` into one of the local roots. */
  function write(root: string, name: string, source = SCRIPT): string {
    mkdirSync(root, { recursive: true });
    const path = join(root, `${name}.js`);
    writeFileSync(path, source);
    return path;
  }

  const projectRoot = () => join(tmpDir, ".pi", "workflows");
  const workspaceRoot = () => join(tmpDir, ".agents", "workflows");
  const personalRoot = () => join(agentDir, "workflows");

  /**
   * Build a pi package that declares workflows and register it in pi's user
   * settings, which is what makes it visible to `savedWorkflowRoots`.
   */
  function installPackage(name: string, ...workflowNames: string[]): string {
    const root = join(tmpDir, "packages", name);
    const wfDir = join(root, "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name, version: "1.0.0", pi: { subagents: { workflows: ["./workflows"] } } }),
    );
    for (const wf of workflowNames) {
      writeFileSync(join(wfDir, `${wf}.js`), `export const meta = { name: '${wf}', description: 'from ${name}' }\n`);
    }
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [root] }));
    resetPackageState();
    return wfDir;
  }

  describe("savedWorkflowRoots", () => {
    it("orders project, workspace, then personal", () => {
      expect(savedWorkflowRoots(tmpDir)).toEqual([projectRoot(), workspaceRoot(), personalRoot()]);
    });

    it("appends package roots after every local one", () => {
      const pkgDir = installPackage("demo-flows", "shipped");
      expect(savedWorkflowRoots(tmpDir)).toEqual([
        projectRoot(),
        workspaceRoot(),
        personalRoot(),
        pkgDir,
      ]);
    });

    it("contributes no package root when packageWorkflows is off", () => {
      installPackage("demo-flows", "shipped");
      setPackageWorkflowsGate(false);
      expect(savedWorkflowRoots(tmpDir)).toHaveLength(3);
    });
  });

  describe("readSavedWorkflow", () => {
    it("reads a workflow from the project root", () => {
      write(projectRoot(), "demo");
      const result = readSavedWorkflow("demo", tmpDir);
      expect(result).toMatchObject({ ok: true, script: SCRIPT, path: join(projectRoot(), "demo.js") });
    });

    it("resolves each root in turn, project first", () => {
      write(personalRoot(), "demo", "export const meta = { name: 'demo', description: 'personal' }\n");
      write(workspaceRoot(), "demo", "export const meta = { name: 'demo', description: 'workspace' }\n");
      write(projectRoot(), "demo", "export const meta = { name: 'demo', description: 'project' }\n");

      expect(readSavedWorkflow("demo", tmpDir)).toMatchObject({ path: join(projectRoot(), "demo.js") });

      rmSync(join(projectRoot(), "demo.js"));
      expect(readSavedWorkflow("demo", tmpDir)).toMatchObject({ path: join(workspaceRoot(), "demo.js") });

      rmSync(join(workspaceRoot(), "demo.js"));
      expect(readSavedWorkflow("demo", tmpDir)).toMatchObject({ path: join(personalRoot(), "demo.js") });
    });

    it("finds a package workflow when no local root claims the name", () => {
      const pkgDir = installPackage("demo-flows", "shipped");
      expect(readSavedWorkflow("shipped", tmpDir)).toMatchObject({
        ok: true,
        path: join(pkgDir, "shipped.js"),
      });
    });

    it("lets a local workflow take the name back from a package", () => {
      installPackage("demo-flows", "shipped");
      write(projectRoot(), "shipped", "export const meta = { name: 'shipped', description: 'mine' }\n");

      const result = readSavedWorkflow("shipped", tmpDir);
      expect(result).toMatchObject({ ok: true, path: join(projectRoot(), "shipped.js") });
    });

    it("does not reach a package workflow when the gate is off", () => {
      installPackage("demo-flows", "shipped");
      setPackageWorkflowsGate(false);
      expect(readSavedWorkflow("shipped", tmpDir).ok).toBe(false);
    });

    it("ignores a package configured only by an untrusted project", () => {
      const root = join(tmpDir, "packages", "proj-flows");
      mkdirSync(join(root, "workflows"), { recursive: true });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "proj-flows", pi: { subagents: { workflows: ["./workflows"] } } }),
      );
      writeFileSync(join(root, "workflows", "shipped.js"), SCRIPT);
      mkdirSync(join(tmpDir, ".pi"), { recursive: true });
      writeFileSync(join(tmpDir, ".pi", "settings.json"), JSON.stringify({ packages: [root] }));
      resetPackageState();

      setProjectTrusted(false);
      expect(savedWorkflowRoots(tmpDir)).toHaveLength(3);

      setProjectTrusted(true);
      expect(savedWorkflowRoots(tmpDir)).toContain(join(root, "workflows"));
    });

    it("refuses a name that is a path rather than a name", () => {
      // `name` arrives from a model, so it is whitelisted before it is ever
      // joined to a root.
      for (const bad of ["../../etc/passwd", "a/b", "..", ".hidden", "with space"]) {
        const result = readSavedWorkflow(bad, tmpDir);
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.message).toContain("not a usable workflow name");
      }
    });

    it("rejects a symlinked root entirely", () => {
      const real = mkdtempSync(join(tmpdir(), "pi-wf-real-"));
      writeFileSync(join(real, "demo.js"), SCRIPT);
      try {
        mkdirSync(join(tmpDir, ".pi"), { recursive: true });
        symlinkSync(real, projectRoot(), "dir");
        expect(readSavedWorkflow("demo", tmpDir).ok).toBe(false);
      } finally {
        rmSync(real, { recursive: true, force: true });
      }
    });

    it("reports a shadowing file that is not a workflow instead of reaching past it", () => {
      write(personalRoot(), "demo");
      write(projectRoot(), "demo", "module.exports = 1\n");

      const result = readSavedWorkflow("demo", tmpDir);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.message).toContain("is not a workflow script");
    });

    it("names the roots it searched, and the workflows that do exist", () => {
      write(projectRoot(), "other");
      const result = readSavedWorkflow("demo", tmpDir);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.message).toContain(projectRoot());
      expect(result.ok === false && result.message).toContain("Available: other.");
    });
  });

  describe("listSavedWorkflows", () => {
    it("de-duplicates across roots and sorts", () => {
      write(projectRoot(), "beta");
      write(personalRoot(), "beta");
      write(personalRoot(), "alpha");
      expect(listSavedWorkflows(tmpDir)).toEqual(["alpha", "beta"]);
    });

    it("includes package workflows", () => {
      installPackage("demo-flows", "shipped");
      write(projectRoot(), "local");
      expect(listSavedWorkflows(tmpDir)).toEqual(["local", "shipped"]);
    });

    it("omits a .js file with no meta declaration", () => {
      write(projectRoot(), "real");
      write(projectRoot(), "utils", "export function helper() {}\n");
      expect(listSavedWorkflows(tmpDir)).toEqual(["real"]);
    });

    it("omits non-.js files and unsafe names", () => {
      mkdirSync(projectRoot(), { recursive: true });
      writeFileSync(join(projectRoot(), "notes.md"), SCRIPT);
      writeFileSync(join(projectRoot(), ".hidden.js"), SCRIPT);
      expect(listSavedWorkflows(tmpDir)).toEqual([]);
    });

    it("returns an empty list when no root exists", () => {
      expect(listSavedWorkflows(tmpDir)).toEqual([]);
    });
  });

  describe("resolveWorkflowSource", () => {
    it("reads an absolute scriptPath as-is", () => {
      const path = write(join(tmpDir, "elsewhere"), "script");
      expect(resolveWorkflowSource({ scriptPath: path }, tmpDir)).toMatchObject({ ok: true, path });
    });

    it("resolves a relative scriptPath against cwd", () => {
      write(join(tmpDir, "scripts"), "demo");
      expect(resolveWorkflowSource({ scriptPath: "scripts/demo.js" }, tmpDir))
        .toMatchObject({ ok: true, path: join(tmpDir, "scripts", "demo.js") });
    });

    it("does not require a meta declaration on an explicit scriptPath", () => {
      // Unlike a saved name, a path is the caller pointing at a specific file;
      // `extractMeta` at the call site is what rejects a bad one, with a parser
      // error rather than a discovery error.
      const path = write(join(tmpDir, "elsewhere"), "plain", "module.exports = 1\n");
      expect(resolveWorkflowSource({ scriptPath: path }, tmpDir).ok).toBe(true);
    });

    it("reports an unreadable scriptPath", () => {
      const result = resolveWorkflowSource({ scriptPath: join(tmpDir, "missing.js") }, tmpDir);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.message).toContain("Could not read workflow script");
    });

    it("needs a name or a scriptPath", () => {
      expect(resolveWorkflowSource({}, tmpDir)).toMatchObject({ ok: false });
      expect(resolveWorkflowSource({ name: "  " }, tmpDir)).toMatchObject({ ok: false });
    });
  });

  describe("resolveWorkflowScript precedence", () => {
    it("prefers scriptPath, then script, then name", () => {
      const path = write(join(tmpDir, "elsewhere"), "from-path", "export const meta = { name: 'p', description: 'p' }\n");
      write(projectRoot(), "saved", "export const meta = { name: 's', description: 's' }\n");

      expect(resolveWorkflowScript({ scriptPath: path, script: "inline", name: "saved" }, tmpDir))
        .toMatchObject({ ok: true, scriptPath: path });
      expect(resolveWorkflowScript({ script: "inline", name: "saved" }, tmpDir))
        .toEqual({ ok: true, script: "inline" });
      expect(resolveWorkflowScript({ name: "saved" }, tmpDir))
        .toMatchObject({ ok: true, scriptPath: join(projectRoot(), "saved.js") });
    });

    it("lists the saved workflows when nothing was provided", () => {
      write(projectRoot(), "demo");
      const result = resolveWorkflowScript({}, tmpDir);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.message).toContain("Saved workflows: demo.");
    });
  });
});
