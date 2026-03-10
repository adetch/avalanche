import { describe, it, expect } from "vitest";
import { classifyDestructiveSize } from "./destructive-size";

describe("classifyDestructiveSize (mass-based, tonnes)", () => {
  it("D1: < 10 t", () => {
    expect(classifyDestructiveSize(0)).toBe(1);
    expect(classifyDestructiveSize(5)).toBe(1);
    expect(classifyDestructiveSize(9.9)).toBe(1);
  });

  it("D2: 10–100 t", () => {
    expect(classifyDestructiveSize(10)).toBe(2);
    expect(classifyDestructiveSize(50)).toBe(2);
    expect(classifyDestructiveSize(99)).toBe(2);
  });

  it("D3: 100–1,000 t", () => {
    expect(classifyDestructiveSize(100)).toBe(3);
    expect(classifyDestructiveSize(500)).toBe(3);
    expect(classifyDestructiveSize(999)).toBe(3);
  });

  it("D4: 1k–10k t", () => {
    expect(classifyDestructiveSize(1_000)).toBe(4);
    expect(classifyDestructiveSize(5_000)).toBe(4);
    expect(classifyDestructiveSize(9_999)).toBe(4);
  });

  it("D5: > 10k t", () => {
    expect(classifyDestructiveSize(10_000)).toBe(5);
    expect(classifyDestructiveSize(100_000)).toBe(5);
  });
});
