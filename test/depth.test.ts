import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetForTesting,
  canNest,
  forgetSessionDepth,
  getSessionDepth,
  MAX_NESTING_DEPTH,
  recordSessionDepth,
} from "../src/depth.js";

describe("depth", () => {
  beforeEach(() => _resetForTesting());

  it("defaults unknown sessions to depth 0", () => {
    expect(getSessionDepth("unknown")).toBe(0);
  });

  it("records and reads back a session depth", () => {
    recordSessionDepth("child-1", 1);
    expect(getSessionDepth("child-1")).toBe(1);
  });

  it("forgets a session depth", () => {
    recordSessionDepth("child-1", 1);
    forgetSessionDepth("child-1");
    expect(getSessionDepth("child-1")).toBe(0);
  });

  it("allows nesting below the cap and blocks at/above it", () => {
    expect(canNest(0)).toBe(true);
    expect(canNest(MAX_NESTING_DEPTH - 1)).toBe(true);
    expect(canNest(MAX_NESTING_DEPTH)).toBe(false);
    expect(canNest(MAX_NESTING_DEPTH + 1)).toBe(false);
  });

  it("ignores empty session ids when recording", () => {
    recordSessionDepth("", 1);
    expect(getSessionDepth("")).toBe(0);
  });
});
