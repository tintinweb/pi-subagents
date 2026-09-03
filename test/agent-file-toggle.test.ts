// The `/agents` enable/disable operations edit an agent .md file's frontmatter.
// The LOAD side (src/custom-agents.ts) parses that frontmatter with a real YAML
// parser, so `enabled: false` is honored wherever it appears in the block. The
// WRITE side here must agree — README.md documents `enabled: false` as a field
// users hand-write, and a hand-authored file puts it wherever the author likes.
//
// These live in src/agent-file-toggle.ts rather than inside the `/agents`
// command closure because `registerCommand` is mocked in every wiring test,
// which is why none of this had coverage.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildNewAgentFile,
  disableInContent,
  enableInContent,
  findAgentFile,
  isDisabledContent,
  isEmptyStub,
  locateAgentFile,
} from "../src/agent-file-toggle.js";
import { parseAgentFrontmatter } from "../src/custom-agents.js";

/** What the loader concludes about a file, via the same parser it really uses. */
function loaderSeesDisabled(content: string): boolean {
  return parseFrontmatter<Record<string, unknown>>(content).frontmatter.enabled === false;
}

const HAND_AUTHORED_DISABLED = "---\ndescription: Scout the repo\nenabled: false\n---\n\nYou are a scout.\n";
const EXTENSION_WRITTEN_DISABLED = "---\nenabled: false\ndescription: Scout the repo\n---\n\nYou are a scout.\n";
const ENABLED = "---\ndescription: Scout the repo\n---\n\nYou are a scout.\n";

describe("enableInContent", () => {
  it("strips enabled: false when it is the first frontmatter line", () => {
    const { content, changed } = enableInContent(EXTENSION_WRITTEN_DISABLED);
    expect(changed).toBe(true);
    expect(loaderSeesDisabled(content)).toBe(false);
  });

  it("strips enabled: false when another key precedes it", () => {
    // The shape a user gets by following README.md — `description` first.
    const { content, changed } = enableInContent(HAND_AUTHORED_DISABLED);
    expect(changed).toBe(true);
    expect(loaderSeesDisabled(content)).toBe(false);
  });

  it("strips enabled: false when it is the last frontmatter line", () => {
    const src = "---\ndescription: Scout\ndisplay_name: Scout\nenabled: false\n---\n\nBody.\n";
    const { content, changed } = enableInContent(src);
    expect(changed).toBe(true);
    expect(loaderSeesDisabled(content)).toBe(false);
  });

  it("reports changed: false when there is nothing to strip", () => {
    const { content, changed } = enableInContent(ENABLED);
    expect(changed).toBe(false);
    expect(content).toBe(ENABLED);
  });

  it("leaves the body and other frontmatter keys untouched", () => {
    const src = "---\ndescription: Scout\nenabled: false\n# a comment\nmodel: haiku\n---\n\nLine 1.\n\nLine 2.\n";
    const { content } = enableInContent(src);
    expect(content).toContain("# a comment");
    expect(content).toContain("model: haiku");
    expect(content).toContain("Line 1.\n\nLine 2.\n");
    expect(loaderSeesDisabled(content)).toBe(false);
  });

  it("handles CRLF line endings", () => {
    const src = "---\r\ndescription: Scout\r\nenabled: false\r\n---\r\n\r\nBody.\r\n";
    const { content, changed } = enableInContent(src);
    expect(changed).toBe(true);
    expect(loaderSeesDisabled(content)).toBe(false);
  });
});

describe("disableInContent", () => {
  it("inserts enabled: false into a normal frontmatter block", () => {
    const { content, outcome } = disableInContent(ENABLED);
    expect(outcome).toBe("disabled");
    expect(loaderSeesDisabled(content)).toBe(true);
  });

  it("is idempotent when the key is already first", () => {
    expect(disableInContent(EXTENSION_WRITTEN_DISABLED).outcome).toBe("already-disabled");
  });

  it("is idempotent when the key is already present mid-block", () => {
    expect(disableInContent(HAND_AUTHORED_DISABLED).outcome).toBe("already-disabled");
  });

  // The previous guard was `content.includes("\nenabled: false\n")`, which a
  // trailing space defeats. It then inserted a SECOND `enabled: false`, and
  // duplicate map keys make the whole file unparseable — so an agent the user
  // asked to disable disappeared from `/agents` entirely (since #212 an
  // unparseable agent file is skipped, not surfaced).
  it("never writes a file the loader cannot parse", () => {
    for (const src of [
      "---\ndescription: x\nenabled: false  \n---\nbody\n",
      "---\ndescription: x\nenabled: false\t\n---\nbody\n",
      HAND_AUTHORED_DISABLED,
      EXTENSION_WRITTEN_DISABLED,
      ENABLED,
    ]) {
      const { content } = disableInContent(src);
      expect(() => parseFrontmatter(content), JSON.stringify(src)).not.toThrow();
      expect(loaderSeesDisabled(content), JSON.stringify(src)).toBe(true);
    }
  });

  it("reports no-frontmatter rather than claiming success on a fence-less file", () => {
    const src = "Just a body, no frontmatter at all.\n";
    const { content, outcome } = disableInContent(src);
    expect(outcome).toBe("no-frontmatter");
    expect(content).toBe(src);
  });

  it("disables a CRLF file instead of misreporting it as frontmatter-less", () => {
    const src = "---\r\ndescription: Scout\r\n---\r\n\r\nBody.\r\n";
    const { content, outcome } = disableInContent(src);
    expect(outcome).toBe("disabled");
    expect(loaderSeesDisabled(content)).toBe(true);
  });

  it("toggles a BOM-prefixed file, and leaves the BOM where it found it", () => {
    // Editors across the Windows/CJK world emit UTF-8 with a BOM by default, so
    // an agent file written in one is ordinary input, not a curiosity. The read
    // side normalises the BOM away (see parseAgentFrontmatter), so the write
    // side must edit the block rather than refuse it — and must not strip the
    // BOM from the user's file while doing so.
    const src = "﻿---\ndescription: 侦察\n---\n\n本文。\n";

    const { content, outcome } = disableInContent(src);

    expect(outcome).toBe("disabled");
    expect(isDisabledContent(content)).toBe(true);
    expect(content.startsWith("﻿")).toBe(true);
    expect(enableInContent(content).content).toBe(src);
  });
});

describe("parseAgentFrontmatter", () => {
  it("reads a BOM-prefixed file's fields instead of dropping them", () => {
    // The bug this guards: an unnormalised BOM made the fence miss, so the
    // frontmatter came back empty and the *whole file* became the body. `tools`
    // going missing is the sharp edge — the agent then registers with the
    // default toolset, a wider grant than its author wrote.
    const src = "﻿---\ndescription: 侦察\ntools: none\n---\n\n本文。\n";

    const { frontmatter, body } = parseAgentFrontmatter<Record<string, unknown>>(src);

    expect(frontmatter).toEqual({ description: "侦察", tools: "none" });
    expect(body).toBe("本文。");
  });

  it("leaves a file without a BOM exactly as the parser reads it", () => {
    const src = "---\ndescription: Scout\n---\n\nBody.\n";

    expect(parseAgentFrontmatter<Record<string, unknown>>(src))
      .toEqual(parseFrontmatter<Record<string, unknown>>(src));
  });
});

describe("isDisabledContent", () => {
  it("sees the key at the first frontmatter line", () => {
    expect(isDisabledContent(EXTENSION_WRITTEN_DISABLED)).toBe(true);
  });

  it("sees the key mid-block", () => {
    expect(isDisabledContent(HAND_AUTHORED_DISABLED)).toBe(true);
  });

  it("sees the key in a CRLF file", () => {
    expect(isDisabledContent("---\r\ndescription: Scout\r\nenabled: false\r\n---\r\n\r\nBody.\r\n")).toBe(true);
  });

  it("is false for an enabled file", () => {
    expect(isDisabledContent(ENABLED)).toBe(false);
  });

  // Detection is a read, so it asks the loader's parser instead of mirroring it.
  // A mirror has to be right about two independent things, and a regex was wrong
  // about both: YAML's other spellings of `false`, and pi's fence scan, which
  // closes the block at any line *starting* `---` — so `----` ends it early and
  // the keys after it are body text, not frontmatter. Getting that backwards told
  // a user their running agent was "already disabled".
  it.each([
    ["lowercase bare false", "---\ndescription: x\nenabled: false\n---\nbody\n", true],
    ["False", "---\ndescription: x\nenabled: False\n---\nbody\n", true],
    ["FALSE", "---\ndescription: x\nenabled: FALSE\n---\nbody\n", true],
    ["trailing comment", "---\ndescription: x\nenabled: false # off for now\n---\nbody\n", true],
    ["quoted key", '---\ndescription: x\n"enabled": false\n---\nbody\n', true],
    ["trailing whitespace", "---\ndescription: x\nenabled: false  \n---\nbody\n", true],
    ["'----' closes the block early", "---\ndescription: x\n----\nenabled: false\n---\nbody\n", false],
    ["'--- x' closes the block early", "---\ndescription: x\n--- x\nenabled: false\n---\nbody\n", false],
    ["quoted string, not a boolean", '---\ndescription: x\nenabled: "false"\n---\nbody\n', false],
    ["YAML 1.1 'no' is a string here", "---\ndescription: x\nenabled: no\n---\nbody\n", false],
    ["key only in the body", "---\ndescription: x\n---\nenabled: false\n", false],
  ])("agrees with the loader: %s", (_label, content, expected) => {
    expect(loaderSeesDisabled(content)).toBe(expected); // premise: what the loader concludes
    expect(isDisabledContent(content)).toBe(expected); // we must conclude the same
  });
});

// The defect, stated as an invariant rather than as a list of shapes: the two
// sides must never disagree about whether a file is disabled. Whatever the
// loader reads as disabled, `/agents → Enable` has to be able to re-enable.
describe("read and write paths agree", () => {
  const shapes: Array<[string, string]> = [
    ["key first", EXTENSION_WRITTEN_DISABLED],
    ["key after description", HAND_AUTHORED_DISABLED],
    ["key last", "---\ndescription: Scout\ndisplay_name: S\nenabled: false\n---\n\nBody.\n"],
    ["CRLF", "---\r\ndescription: Scout\r\nenabled: false\r\n---\r\n\r\nBody.\r\n"],
  ];

  for (const [label, content] of shapes) {
    it(`a file the loader reads as disabled can be enabled — ${label}`, () => {
      expect(loaderSeesDisabled(content)).toBe(true); // premise: the loader agrees it's disabled
      expect(enableInContent(content).changed).toBe(true);
    });
  }

  it("disable → enable round-trips to the original hand-authored file", () => {
    const disabled = disableInContent(ENABLED);
    expect(disabled.outcome).toBe("disabled");
    expect(enableInContent(disabled.content).content).toBe(ENABLED);
  });
});

describe("isEmptyStub", () => {
  it("recognises the stub behind a BOM", () => {
    // Correct today only because String.trim() counts U+FEFF as whitespace —
    // true, but nowhere stated, and this function eyeballs raw content instead
    // of going through parseAgentFrontmatter like every other reader.
    expect(isEmptyStub("\uFEFF---\n---")).toBe(true);
  });

  it("recognizes the stub /agents writes to disable a built-in default", () => {
    expect(isEmptyStub("---\n---\n")).toBe(true);
    expect(isEmptyStub(enableInContent("---\nenabled: false\n---\n").content)).toBe(true);
  });

  it("is false for a file with real frontmatter", () => {
    expect(isEmptyStub(ENABLED)).toBe(false);
  });
});

describe("findAgentFile", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevAgentDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-toggle-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-toggle-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  function write(dir: string, name: string) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), ENABLED);
  }

  it("prefers .pi/agents over .agents/agents and the personal dir", () => {
    write(join(tmpDir, ".pi", "agents"), "scout");
    write(join(tmpDir, ".agents", "agents"), "scout");
    write(join(agentDir, "agents"), "scout");
    expect(findAgentFile("scout", tmpDir)).toEqual({
      path: join(tmpDir, ".pi", "agents", "scout.md"),
      location: "project",
    });
  });

  it("falls back to the workspace .agents/agents dir", () => {
    write(join(tmpDir, ".agents", "agents"), "scout");
    write(join(agentDir, "agents"), "scout");
    expect(findAgentFile("scout", tmpDir)).toEqual({
      path: join(tmpDir, ".agents", "agents", "scout.md"),
      location: "workspace",
    });
  });

  it("falls back to the personal agent dir", () => {
    write(join(agentDir, "agents"), "scout");
    expect(findAgentFile("scout", tmpDir)).toEqual({
      path: join(agentDir, "agents", "scout.md"),
      location: "personal",
    });
  });

  it("returns undefined when the agent has no file anywhere", () => {
    expect(findAgentFile("nope", tmpDir)).toBeUndefined();
  });

  // An agent's type comes from its frontmatter `name:` now, so `<type>.md` is a
  // guess. Getting it wrong is not a harmless miss: `/agents → Disable` takes
  // the no-file branch and writes a NEW stub, which loses to the real file on
  // load — so the agent stays enabled while the toast reports success.
  describe("locateAgentFile", () => {
    it("uses the file the loader read, whatever it is called", () => {
      write(join(tmpDir, ".pi", "agents"), "reviewer");
      const sourcePath = join(tmpDir, ".pi", "agents", "reviewer.md");

      expect(locateAgentFile("code-reviewer", sourcePath, tmpDir)).toEqual({
        path: sourcePath,
        location: "project",
      });
    });

    it("classifies a workspace and a personal source path", () => {
      write(join(tmpDir, ".agents", "agents"), "reviewer");
      write(join(agentDir, "agents"), "auditor");

      expect(locateAgentFile("code-reviewer", join(tmpDir, ".agents", "agents", "reviewer.md"), tmpDir))
        .toMatchObject({ location: "workspace" });
      expect(locateAgentFile("code-auditor", join(agentDir, "agents", "auditor.md"), tmpDir))
        .toMatchObject({ location: "personal" });
    });

    it("falls back to the <type>.md probe for a built-in with no source file", () => {
      write(join(tmpDir, ".pi", "agents"), "scout");

      expect(locateAgentFile("scout", undefined, tmpDir)).toEqual({
        path: join(tmpDir, ".pi", "agents", "scout.md"),
        location: "project",
      });
    });

    it("falls back when the recorded path has since been deleted", () => {
      write(join(tmpDir, ".pi", "agents"), "scout");

      expect(locateAgentFile("scout", join(tmpDir, ".pi", "agents", "gone.md"), tmpDir)).toEqual({
        path: join(tmpDir, ".pi", "agents", "scout.md"),
        location: "project",
      });
    });

    it("finds nothing when neither the source path nor the probe resolves", () => {
      expect(locateAgentFile("nope", join(tmpDir, ".pi", "agents", "gone.md"), tmpDir)).toBeUndefined();
    });

    // A package agent's file sits under pi's install root. Handing it back would
    // let `/agents → Edit` write somewhere `pi update` overwrites and `Delete`
    // remove a file `pi install` puts straight back.
    it("refuses a package agent's own file even though it exists", () => {
      const pkgAgents = join(tmpDir, "node_modules", "demo", "agents");
      write(pkgAgents, "researcher");

      expect(locateAgentFile("researcher", join(pkgAgents, "researcher.md"), tmpDir, "package"))
        .toBeUndefined();
    });

    it("returns the local stub shadowing a package agent, not the package file", () => {
      const pkgAgents = join(tmpDir, "node_modules", "demo", "agents");
      write(pkgAgents, "researcher");
      write(join(tmpDir, ".pi", "agents"), "researcher");

      expect(locateAgentFile("researcher", join(pkgAgents, "researcher.md"), tmpDir, "package"))
        .toEqual({ path: join(tmpDir, ".pi", "agents", "researcher.md"), location: "project" });
    });

    it("still honours a source path for every non-package source", () => {
      write(join(tmpDir, ".pi", "agents"), "reviewer");
      const sourcePath = join(tmpDir, ".pi", "agents", "reviewer.md");
      for (const source of ["project", "global", "default", undefined] as const) {
        expect(locateAgentFile("code-reviewer", sourcePath, tmpDir, source))
          .toEqual({ path: sourcePath, location: "project" });
      }
    });
  });
});

// `/agents → Create agent → Manual` writes an agent file from free-text prompts.
// The description is whatever the user typed into `ctx.ui.input("Description
// (one line)")` — no validation, no escaping — and it was interpolated straight
// into a YAML scalar.
//
// That matters more than a formatting nit because of how a broken agent file is
// handled since #212: it is SKIPPED with a warning (or aborts startup under
// strictAgentFiles). So the wizard reports "Created <path>", and the agent the
// user just built silently does not exist.
describe("buildNewAgentFile", () => {
  const base = { tools: "read, grep", systemPrompt: "Do the thing.", description: "Scout" };

  /** What the loader makes of the generated file. */
  const parse = (content: string) => parseFrontmatter<Record<string, unknown>>(content).frontmatter;

  it("round-trips an ordinary description", () => {
    expect(parse(buildNewAgentFile(base)).description).toBe("Scout");
  });

  it("survives a description containing a colon", () => {
    // "Scout: find things" is an entirely natural thing to type, and an
    // unquoted YAML scalar treats the colon as a nested mapping — the parser
    // throws and the whole file is unloadable.
    const content = buildNewAgentFile({ ...base, description: "Scout: find things" });
    expect(() => parse(content)).not.toThrow();
    expect(parse(content).description).toBe("Scout: find things");
  });

  it("keeps a description containing a # instead of truncating it", () => {
    // `#` opens a YAML comment, so "audit #security" silently becomes "audit".
    const content = buildNewAgentFile({ ...base, description: "audit #security" });
    expect(parse(content).description).toBe("audit #security");
  });

  it("leaves a `provider/model:thinking` suffix intact", () => {
    // Not a hazard on its own — YAML splits on ": " (colon then space), so a
    // bare `:high` suffix is a valid plain scalar either way. Pinned because
    // it's the shape most likely to be typed into the custom-model prompt, and
    // quoting must not mangle it.
    const content = buildNewAgentFile({ ...base, model: "anthropic/claude-sonnet-4-6:high" });
    expect(parse(content).model).toBe("anthropic/claude-sonnet-4-6:high");
  });

  it("survives a custom model containing a colon-space or a #", () => {
    // The custom-model prompt is free text with no validation, so it has the
    // same two hazards the description does.
    for (const model of ["anthropic/foo: bar", "anthropic/x #c"]) {
      const content = buildNewAgentFile({ ...base, model });
      expect(() => parse(content), model).not.toThrow();
      expect(parse(content).model, model).toBe(model);
    }
  });

  it("emits the fields the wizard collects, and omits the ones left on inherit", () => {
    const full = parse(buildNewAgentFile({ ...base, model: "anthropic/x", thinking: "high" }));
    expect(full).toMatchObject({ tools: "read, grep", model: "anthropic/x", thinking: "high", prompt_mode: "replace" });

    const minimal = parse(buildNewAgentFile(base));
    expect(minimal.model).toBeUndefined();
    expect(minimal.thinking).toBeUndefined();
  });

  it("keeps the system prompt as the body", () => {
    const content = buildNewAgentFile({ ...base, systemPrompt: "Line 1.\n\nLine 2." });
    expect(parseFrontmatter<Record<string, unknown>>(content).body).toBe("Line 1.\n\nLine 2.");
  });
});
