import { beforeEach, describe, expect, it } from "vitest";
import {
  getDefaultMaxTurns,
  getGraceTurns,
  normalizeMaxTurns,
  setDefaultMaxTurns,
  setGraceTurns,
} from "../src/agent-runner.js";

describe("setDefaultMaxTurns / getDefaultMaxTurns", () => {
  beforeEach(() => {
    setDefaultMaxTurns(undefined);
  });

  it("defaults to undefined (unlimited)", () => {
    expect(getDefaultMaxTurns()).toBeUndefined();
  });

  it("stores a positive integer", () => {
    setDefaultMaxTurns(30);
    expect(getDefaultMaxTurns()).toBe(30);
  });

  it("accepts boundary value 1", () => {
    setDefaultMaxTurns(1);
    expect(getDefaultMaxTurns()).toBe(1);
  });

  it("treats 0 as unlimited", () => {
    setDefaultMaxTurns(0);
    expect(getDefaultMaxTurns()).toBeUndefined();
  });

  it("clamps negative values to 1", () => {
    setDefaultMaxTurns(-10);
    expect(getDefaultMaxTurns()).toBe(1);
  });

  it("undefined resets to unlimited after being set", () => {
    setDefaultMaxTurns(50);
    expect(getDefaultMaxTurns()).toBe(50);
    setDefaultMaxTurns(undefined);
    expect(getDefaultMaxTurns()).toBeUndefined();
  });
});

describe("normalizeMaxTurns", () => {
  it("treats undefined as unlimited", () => {
    expect(normalizeMaxTurns(undefined)).toBeUndefined();
  });

  it("treats 0 as unlimited", () => {
    expect(normalizeMaxTurns(0)).toBeUndefined();
  });

  it("keeps positive values", () => {
    expect(normalizeMaxTurns(7)).toBe(7);
  });

  it("clamps negative values to 1", () => {
    expect(normalizeMaxTurns(-3)).toBe(1);
  });
});

describe("setGraceTurns / getGraceTurns", () => {
  beforeEach(() => {
    setGraceTurns(5);
  });

  it("defaults to 5", () => {
    expect(getGraceTurns()).toBe(5);
  });

  it("stores a positive integer", () => {
    setGraceTurns(10);
    expect(getGraceTurns()).toBe(10);
  });

  it("accepts boundary value 1", () => {
    setGraceTurns(1);
    expect(getGraceTurns()).toBe(1);
  });

  it("clamps 0 to 1", () => {
    setGraceTurns(0);
    expect(getGraceTurns()).toBe(1);
  });

  it("clamps negative values to 1", () => {
    setGraceTurns(-5);
    expect(getGraceTurns()).toBe(1);
  });
});
