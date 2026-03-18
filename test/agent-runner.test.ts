import { describe, it, expect, afterEach } from "vitest";
import {
  getDefaultMaxTurns,
  setDefaultMaxTurns,
  getGraceTurns,
  setGraceTurns,
  resetDefaults,
} from "../src/agent-runner.js";

describe("agent-runner — resetDefaults", () => {
  afterEach(() => {
    resetDefaults();
  });

  it("getDefaultMaxTurns returns undefined initially (no turn limit)", () => {
    expect(getDefaultMaxTurns()).toBeUndefined();
  });

  it("setDefaultMaxTurns updates the value", () => {
    setDefaultMaxTurns(10);
    expect(getDefaultMaxTurns()).toBe(10);
  });

  it("setDefaultMaxTurns accepts undefined for unlimited", () => {
    setDefaultMaxTurns(10);
    setDefaultMaxTurns(undefined);
    expect(getDefaultMaxTurns()).toBeUndefined();
  });

  it("setDefaultMaxTurns clamps to minimum 1", () => {
    setDefaultMaxTurns(0);
    expect(getDefaultMaxTurns()).toBe(1);
    setDefaultMaxTurns(-5);
    expect(getDefaultMaxTurns()).toBe(1);
  });

  it("getGraceTurns returns 5 initially", () => {
    expect(getGraceTurns()).toBe(5);
  });

  it("setGraceTurns updates the value", () => {
    setGraceTurns(20);
    expect(getGraceTurns()).toBe(20);
  });

  it("setGraceTurns clamps to minimum 1", () => {
    setGraceTurns(0);
    expect(getGraceTurns()).toBe(1);
  });

  it("resetDefaults restores both values to initial", () => {
    setDefaultMaxTurns(999);
    setGraceTurns(777);
    expect(getDefaultMaxTurns()).toBe(999);
    expect(getGraceTurns()).toBe(777);

    resetDefaults();

    expect(getDefaultMaxTurns()).toBeUndefined();
    expect(getGraceTurns()).toBe(5);
  });
});
