// Boots the REAL extension (src/index.ts) against a pi package that declares
// subagents, so the wiring between pi's settings, `session_start`'s project-trust
// read, and the `Agent` tool's type list is exercised end to end.
//
// The unit tests cover discovery and precedence directly; what only shows up
// here is the ordering problem the extension actually has — agents are
// registered at activation, hundreds of lines before any context exists, so the
// trust answer that decides whether a project's `packages[]` is visible arrives
// afterwards.

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentConfig, getAllTypes } from "../src/agent-types.js";
import { packageNameForPath, resetPackageState } from "../src/package-resources.js";
import { type BootedPi, ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

const AGENT = "---\nname: pkg-researcher\ndescription: From a package\ntools: read, grep\n---\nYou research.\n";

describe("package-provided agents, wired through the extension", () => {
  let env: Hermetic;
  let booted: BootedPi;

  beforeEach(() => {
    resetPackageState();
  });

  afterEach(() => {
    env?.restore();
    resetPackageState();
    vi.restoreAllMocks();
  });

  /** Build a package on disk under the hermetic dir and return its root. */
  function makePackage(name = "demo-subagents"): string {
    const root = join(env.dir, "packages", name);
    mkdirSync(join(root, "agents"), { recursive: true });
    mkdirSync(join(root, "workflows"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name,
        version: "1.0.0",
        pi: { subagents: { agents: ["./agents"], workflows: ["./workflows"] } },
      }),
    );
    writeFileSync(join(root, "agents", "pkg-researcher.md"), AGENT);
    writeFileSync(
      join(root, "workflows", "pkg-flow.js"),
      "export const meta = { name: 'pkg-flow', description: 'shipped in a package' }\nreturn 'ok'\n",
    );
    return root;
  }

  /** A package that excludes one of the files inside a directory it includes. */
  function makeExcludingPackage(name = "excluding-subagents"): string {
    const root = join(env.dir, "packages", name);
    mkdirSync(join(root, "agents"), { recursive: true });
    mkdirSync(join(root, "workflows"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name,
        version: "1.0.0",
        pi: {
          subagents: {
            agents: ["./agents", "!./agents/wip.md"],
            workflows: ["./workflows", "!./workflows/wip-flow.js"],
          },
        },
      }),
    );
    writeFileSync(join(root, "agents", "pkg-researcher.md"), AGENT);
    writeFileSync(join(root, "agents", "wip.md"), "---\nname: pkg-wip\ndescription: unfinished\n---\nWIP.\n");
    const meta = (n: string) => `export const meta = { name: '${n}', description: 'd' }\n`;
    writeFileSync(join(root, "workflows", "pkg-flow.js"), meta("pkg-flow"));
    writeFileSync(join(root, "workflows", "wip-flow.js"), meta("wip-flow"));
    return root;
  }

  /** Write pi's own settings (not ours) at the given scope. */
  function writePiSettings(scope: "user" | "project", packages: string[]): void {
    const path = scope === "user"
      ? join(process.env.PI_CODING_AGENT_DIR as string, "settings.json")
      : join(env.dir, ".pi", "settings.json");
    mkdirSync(join(path, "..").toString(), { recursive: true });
    writeFileSync(path, JSON.stringify({ packages }));
  }

  /** Activate the extension, without starting a session. */
  async function activate(): Promise<void> {
    booted = makePi();
    const factory = (await import("../src/index.js")).default;
    factory(booted.pi);
  }

  /** Activate the extension and run its `session_start` handler. */
  async function boot(projectTrusted: boolean): Promise<void> {
    await activate();
    await booted.lifecycle.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      ctx({ isProjectTrusted: () => projectTrusted }),
    );
  }

  it("registers an agent from a package in pi's user settings", async () => {
    env = hermeticDir();
    writePiSettings("user", [makePackage()]);

    await boot(false);
    expect(getAllTypes()).toContain("pkg-researcher");
  });

  it("traces the loaded agent back to the package that declared it", async () => {
    // `/agents` names the package by mapping the loaded `sourcePath` onto a
    // package root. Nothing in the loader guarantees that relationship, so it is
    // asserted end to end rather than assumed: if the loader ever canonicalized
    // or rewrote the paths it walks, the badge would lose its name silently.
    env = hermeticDir();
    const root = makePackage();
    writePiSettings("user", [root]);

    await boot(false);
    const cfg = getAgentConfig("pkg-researcher");
    expect(cfg?.source).toBe("package");
    expect(cfg?.sourcePath).toBeDefined();
    expect(packageNameForPath(cfg?.sourcePath ?? "", process.cwd())).toBe("demo-subagents");
  });

  it("offers it to the model in the Agent tool's type list", async () => {
    env = hermeticDir();
    writePiSettings("user", [makePackage()]);

    await boot(false);
    const agentTool = booted.tools.get("Agent");
    const spec = JSON.stringify(agentTool?.description ?? "") + JSON.stringify(agentTool?.parameters ?? {});
    expect(spec).toContain("pkg-researcher");
  });

  it("does not register one from an untrusted project's settings", async () => {
    env = hermeticDir();
    writePiSettings("project", [makePackage()]);

    await boot(false);
    expect(getAllTypes()).not.toContain("pkg-researcher");
  });

  it("registers one from a trusted project's settings, after session_start", async () => {
    env = hermeticDir();
    writePiSettings("project", [makePackage()]);

    // Activation runs before any context exists, so the trust answer only
    // arrives with `session_start` — the agent must appear on that reload, not
    // stay missing until the next `Agent` call.
    await boot(true);
    expect(getAllTypes()).toContain("pkg-researcher");
  });

  it("honours packageAgents: false from our own settings", async () => {
    env = hermeticDir({ settings: { packageAgents: false } });
    writePiSettings("user", [makePackage()]);

    await boot(false);
    expect(getAllTypes()).not.toContain("pkg-researcher");
  });

  it("honours an allowlist that names a different package", async () => {
    env = hermeticDir({ settings: { packageAgents: ["something-else"] } });
    writePiSettings("user", [makePackage()]);

    await boot(false);
    expect(getAllTypes()).not.toContain("pkg-researcher");
  });

  it("honours an allowlist that names this package by its short name", async () => {
    env = hermeticDir({ settings: { packageAgents: ["demo-subagents"] } });
    writePiSettings("user", [makePackage()]);

    await boot(false);
    expect(getAllTypes()).toContain("pkg-researcher");
  });

  // The gates are read from settings twice: once directly at boot, and again
  // through `applyAndEmitLoaded`'s appliers. The second read is too late for the
  // registration that happens at activation, which is what these two pin.
  describe("the gate applies to the activation-time load, not just the first session", () => {
    it("keeps package agents out of the registry before any session starts", async () => {
      env = hermeticDir({ settings: { packageAgents: false } });
      writePiSettings("user", [makePackage()]);

      await activate();
      expect(getAllTypes()).not.toContain("pkg-researcher");
    });

    it("does not abort a strict activation over a package file it was told to ignore", async () => {
      // `strictAgentFiles` makes an unparseable agent file throw at activation,
      // by design — a checked-in `.pi/agents/` should fail loudly. A package the
      // user switched off is not theirs to fix, so it must not be read at all.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        env = hermeticDir({ settings: { strictAgentFiles: true, packageAgents: false } });
        const root = makePackage();
        writeFileSync(join(root, "agents", "broken.md"), "---\nname: [unclosed\n---\nBody.");
        writePiSettings("user", [root]);

        await expect(activate()).resolves.toBeUndefined();
      } finally {
        warn.mockRestore();
      }
    });
  });

  // The workflow resolver reads the `packageWorkflows` gate out of the module
  // state this extension sets at boot, rather than taking it as a parameter
  // through four call layers. That only holds while there is exactly one module
  // instance — which is what booting the real extension here checks.
  describe("workflows", () => {
    it("resolves a saved name against a package's declared directory", async () => {
      env = hermeticDir();
      writePiSettings("user", [makePackage()]);

      await boot(false);
      const { listSavedWorkflows, readSavedWorkflow } = await import("../src/workflow/saved.js");
      expect(listSavedWorkflows(env.dir)).toContain("pkg-flow");
      expect(readSavedWorkflow("pkg-flow", env.dir).ok).toBe(true);
    });

    it("stops resolving it once packageWorkflows is off", async () => {
      env = hermeticDir({ settings: { packageWorkflows: false } });
      writePiSettings("user", [makePackage()]);

      await boot(false);
      const { listSavedWorkflows, readSavedWorkflow } = await import("../src/workflow/saved.js");
      expect(listSavedWorkflows(env.dir)).not.toContain("pkg-flow");
      expect(readSavedWorkflow("pkg-flow", env.dir).ok).toBe(false);
    });

    it("gates workflows separately from agents", async () => {
      env = hermeticDir({ settings: { packageAgents: true, packageWorkflows: false } });
      writePiSettings("user", [makePackage()]);

      await boot(false);
      const { listSavedWorkflows } = await import("../src/workflow/saved.js");
      expect(getAllTypes()).toContain("pkg-researcher");
      expect(listSavedWorkflows(env.dir)).not.toContain("pkg-flow");
    });
  });

  // `!` is only useful as a per-file exclusion: excluding a whole entry is the
  // same as not listing it. The file it names lives inside a directory that is
  // not enumerated until load time, so the exclusion has to survive that far.
  describe("! manifest exclusions", () => {
    it("keeps an excluded agent out while its siblings load", async () => {
      env = hermeticDir();
      writePiSettings("user", [makeExcludingPackage()]);

      await boot(false);
      expect(getAllTypes()).toContain("pkg-researcher");
      expect(getAllTypes()).not.toContain("pkg-wip");
    });

    it("keeps an excluded workflow from resolving by name", async () => {
      env = hermeticDir();
      writePiSettings("user", [makeExcludingPackage()]);

      await boot(false);
      const { listSavedWorkflows, readSavedWorkflow } = await import("../src/workflow/saved.js");
      expect(listSavedWorkflows(env.dir)).toContain("pkg-flow");
      expect(listSavedWorkflows(env.dir)).not.toContain("wip-flow");
      expect(readSavedWorkflow("wip-flow", env.dir).ok).toBe(false);
    });

    it("does not let one package's exclusion reach another's files", async () => {
      // Exclusions are absolute paths, so they can only match inside the package
      // that wrote them — but they share one set across packages, so check it.
      env = hermeticDir();
      writePiSettings("user", [makeExcludingPackage(), makePackage("other-subagents")]);

      await boot(false);
      const { listSavedWorkflows } = await import("../src/workflow/saved.js");
      expect(listSavedWorkflows(env.dir)).toContain("pkg-flow");
      expect(getAllTypes()).toContain("pkg-researcher");
    });
  });

  // A declared workflow *file* has no directory for a name lookup. Standing its
  // parent in as a root would make every sibling `.js` resolvable, which is the
  // opposite of the rule the feature rests on: a package contributes what it
  // names, and nothing else.
  describe("a workflow declared as a single file", () => {
    /** A package declaring one workflow file, with an undeclared one beside it. */
    function makeFileDeclaringPackage(): string {
      const root = join(env.dir, "packages", "file-decl");
      mkdirSync(root, { recursive: true });
      const meta = (n: string) => `export const meta = { name: '${n}', description: 'd' }\n`;
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "file-decl", version: "1.0.0", pi: { subagents: { workflows: ["./declared.js"] } } }),
      );
      writeFileSync(join(root, "declared.js"), meta("declared"));
      writeFileSync(join(root, "internal.js"), meta("internal"));
      return root;
    }

    it("resolves the declared file by name", async () => {
      env = hermeticDir();
      writePiSettings("user", [makeFileDeclaringPackage()]);

      await boot(false);
      const { readSavedWorkflow } = await import("../src/workflow/saved.js");
      expect(readSavedWorkflow("declared", env.dir).ok).toBe(true);
    });

    it("leaves the undeclared sibling unreachable", async () => {
      env = hermeticDir();
      writePiSettings("user", [makeFileDeclaringPackage()]);

      await boot(false);
      const { listSavedWorkflows, readSavedWorkflow } = await import("../src/workflow/saved.js");
      expect(listSavedWorkflows(env.dir)).toEqual(["declared"]);
      expect(readSavedWorkflow("internal", env.dir).ok).toBe(false);
    });

    it("still loses the name to a local script", async () => {
      env = hermeticDir();
      writePiSettings("user", [makeFileDeclaringPackage()]);
      mkdirSync(join(env.dir, ".pi", "workflows"), { recursive: true });
      writeFileSync(
        join(env.dir, ".pi", "workflows", "declared.js"),
        "export const meta = { name: 'declared', description: 'mine' }\n",
      );

      await boot(false);
      const { readSavedWorkflow } = await import("../src/workflow/saved.js");
      const found = readSavedWorkflow("declared", env.dir);
      expect(found.ok && found.path).toBe(join(env.dir, ".pi", "workflows", "declared.js"));
    });

    it("is gated by packageWorkflows like any other package script", async () => {
      env = hermeticDir({ settings: { packageWorkflows: false } });
      writePiSettings("user", [makeFileDeclaringPackage()]);

      await boot(false);
      const { readSavedWorkflow } = await import("../src/workflow/saved.js");
      expect(readSavedWorkflow("declared", env.dir).ok).toBe(false);
    });
  });

  // The `Agent` tool's description — the list of types the model is told about —
  // is built once at activation, before any session context exists. Correcting
  // project trust on `session_start` is therefore too late for it: the agent
  // would be dispatchable but never advertised. `seedProjectTrust` reads pi's
  // saved decision so the common case is right from the first turn.
  describe("a trusted project's package reaches the model, not just the dispatcher", () => {
    /** A project-scoped package, plus whatever trust state the case needs. */
    function setupProjectPackage(opts: { savedTrust?: boolean; defaultTrust?: string } = {}): void {
      const root = join(env.dir, "packages", "project-scoped");
      mkdirSync(join(root, "agents"), { recursive: true });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "project-scoped", version: "1.0.0", pi: { subagents: { agents: ["./agents"] } } }),
      );
      writeFileSync(join(root, "agents", "pkg-researcher.md"), AGENT);
      writePiSettings("project", [root]);

      const agentDir = process.env.PI_CODING_AGENT_DIR as string;
      if (opts.savedTrust !== undefined) {
        writeFileSync(
          join(agentDir, "trust.json"),
          JSON.stringify({ [realpathSync(env.dir)]: opts.savedTrust }),
        );
      }
      if (opts.defaultTrust) {
        writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: opts.defaultTrust }));
      }
    }

    const typeList = () => String(booted.tools.get("Agent")?.description ?? "");

    it("advertises it when pi has already saved a trust decision", async () => {
      env = hermeticDir();
      setupProjectPackage({ savedTrust: true });

      await boot(true);
      expect(typeList()).toContain("- pkg-researcher:");
    });

    it("advertises it under defaultProjectTrust: always, with no saved decision", async () => {
      env = hermeticDir();
      setupProjectPackage({ defaultTrust: "always" });

      await boot(true);
      expect(typeList()).toContain("- pkg-researcher:");
    });

    it("keeps it out entirely when the saved decision is distrust", async () => {
      env = hermeticDir();
      setupProjectPackage({ savedTrust: false });

      await boot(false);
      expect(getAllTypes()).not.toContain("pkg-researcher");
      expect(typeList()).not.toContain("- pkg-researcher:");
    });

    it("lets an explicit distrust beat a permissive global default", async () => {
      // `defaultProjectTrust` is only the fallback for a project with no saved
      // answer. A repo the user explicitly declined stays declined, even on a
      // machine that trusts everything else by default.
      env = hermeticDir();
      setupProjectPackage({ savedTrust: false, defaultTrust: "always" });

      await boot(false);
      expect(getAllTypes()).not.toContain("pkg-researcher");
      // The type list is the assertion that bites: a seed that read the global
      // default over the saved answer would advertise an agent to the model that
      // dispatch then refuses, which is worse than never advertising it.
      expect(typeList()).not.toContain("- pkg-researcher:");
    });

    it("registers but does not yet advertise it on the very first session", async () => {
      // No saved decision and `defaultProjectTrust: "ask"` — the user answers the
      // prompt interactively, after the tool description was built. Dispatch
      // accepts the agent; the type list catches up next session. Pinned because
      // it is the one case the seed cannot reach, not because it is desirable.
      env = hermeticDir();
      setupProjectPackage({});

      await boot(true);
      expect(getAllTypes()).toContain("pkg-researcher");
      expect(typeList()).not.toContain("- pkg-researcher:");
    });
  });

  it("lets a project agent file take the name from the package", async () => {
    env = hermeticDir({
      agentFiles: { "pkg-researcher": "---\nname: pkg-researcher\ndescription: Mine\n---\nLocal.\n" },
    });
    writePiSettings("user", [makePackage()]);

    await boot(false);
    const { getAgentConfig } = await import("../src/agent-types.js");
    expect(getAgentConfig("pkg-researcher")?.source).toBe("project");
    expect(getAgentConfig("pkg-researcher")?.description).toBe("Mine");
  });
});
