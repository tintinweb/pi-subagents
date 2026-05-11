import { describe, expect, it } from "vitest";
import { formatAgentConfigTag } from "../src/index.js";

describe("formatAgentConfigTag", () => {
  it("formats model and thinking as compact tag", () => {
    expect(formatAgentConfigTag("haiku", "medium")).toBe("haiku:medium");
  });

  it("falls back to model-only or thinking-only display", () => {
    expect(formatAgentConfigTag("haiku", undefined)).toBe("haiku");
    expect(formatAgentConfigTag(undefined, "medium")).toBe("thinking:medium");
    expect(formatAgentConfigTag(undefined, undefined)).toBeUndefined();
  });
});
