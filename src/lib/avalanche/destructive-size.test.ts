import { describe, it, expect } from "vitest";
import { classifyDestructiveSize } from "./destructive-size";

describe("classifyDestructiveSize", () => {
  it("D1: < 100 m³", () => {
    expect(classifyDestructiveSize(0)).toBe(1);
    expect(classifyDestructiveSize(50)).toBe(1);
    expect(classifyDestructiveSize(99)).toBe(1);
  });

  it("D2: 100–1000 m³", () => {
    expect(classifyDestructiveSize(100)).toBe(2);
    expect(classifyDestructiveSize(500)).toBe(2);
    expect(classifyDestructiveSize(999)).toBe(2);
  });

  it("D3: 1k–10k m³", () => {
    expect(classifyDestructiveSize(1_000)).toBe(3);
    expect(classifyDestructiveSize(5_000)).toBe(3);
    expect(classifyDestructiveSize(9_999)).toBe(3);
  });

  it("D4: 10k–100k m³", () => {
    expect(classifyDestructiveSize(10_000)).toBe(4);
    expect(classifyDestructiveSize(50_000)).toBe(4);
    expect(classifyDestructiveSize(99_999)).toBe(4);
  });

  it("D5: > 100k m³", () => {
    expect(classifyDestructiveSize(100_000)).toBe(5);
    expect(classifyDestructiveSize(1_000_000)).toBe(5);
  });
});
