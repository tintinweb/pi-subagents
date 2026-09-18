import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

describe("Agent focus parameter", () => {
  let hermetic: Hermetic | undefined;

  afterEach(() => {
    hermetic?.restore();
    hermetic = undefined;
    vi.mocked(runAgent).mockReset();
  });

  it("publishes and forwards the explicit focus selector", async () => {
    hermetic = hermeticDir();
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() },
      aborted: false,
      steered: false,
    } as any);
    const tool = tools.get("Agent");

    expect(tool.parameters.properties.focus.properties).toMatchObject({
      focusId: expect.any(Object),
      subfocusId: expect.any(Object),
    });
    expect(tool.parameters.properties.focus.required).toEqual(["focusId"]);

    await tool.execute(
      "tc",
      {
        prompt: "go",
        description: "focused child",
        subagent_type: "general-purpose",
        run_in_background: false,
        focus: { focusId: "pi-focus", subfocusId: "startup" },
      },
      undefined,
      undefined,
      ctx(),
    );

    expect(runAgent).toHaveBeenCalledWith(
      expect.anything(),
      "general-purpose",
      "go",
      expect.objectContaining({ focus: { focusId: "pi-focus", subfocusId: "startup" } }),
    );
  });

  it("rejects combining a focus selector with resume", async () => {
    hermetic = hermeticDir();
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const result = await tools.get("Agent").execute(
      "tc",
      {
        prompt: "continue",
        description: "conflicting resume",
        subagent_type: "general-purpose",
        resume: "old-agent",
        focus: { focusId: "pi-focus" },
      },
      undefined,
      undefined,
      ctx(),
    );

    expect(textOf(result)).toMatch(/cannot combine.*focus.*resume/i);
    expect(runAgent).not.toHaveBeenCalled();
  });
});
