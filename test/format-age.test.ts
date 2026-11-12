// formatAge — the coarse age get_subagent_result's saved-record answer prints (#436).
import { describe, expect, it } from "vitest";
import { formatAge } from "../src/ui/agent-widget.js";

const now = 1_800_000_000_000;
const MIN = 60_000;

describe("formatAge", () => {
  it("floors to the largest whole unit", () => {
    expect(formatAge(now - 59_999, now)).toBe("<1m");
    expect(formatAge(now - MIN, now)).toBe("1m");
    expect(formatAge(now - 59 * MIN, now)).toBe("59m");
    expect(formatAge(now - 60 * MIN, now)).toBe("1h");
    expect(formatAge(now - (24 * 60 - 1) * MIN, now)).toBe("23h");
    expect(formatAge(now - 24 * 60 * MIN, now)).toBe("1d");
    expect(formatAge(now - 51 * 60 * MIN, now)).toBe("2d");
  });
});
