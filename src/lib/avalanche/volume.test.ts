import { describe, it, expect } from "vitest";
import { computeVolume } from "./volume";

describe("computeVolume", () => {
  it("computes area × depth × entrainment factor", () => {
    // 1000 m² × 1m depth × 2.0 entrainment = 2000 m³
    expect(computeVolume(1000, 100)).toBe(2000);
  });

  it("converts cm to meters", () => {
    // 500 m² × 0.5m (50cm) × 2.0 = 500 m³
    expect(computeVolume(500, 50)).toBe(500);
  });

  it("accepts custom entrainment factor", () => {
    // 1000 m² × 1m × 1.0 = 1000 m³
    expect(computeVolume(1000, 100, 1.0)).toBe(1000);
  });

  it("returns 0 for zero area or depth", () => {
    expect(computeVolume(0, 100)).toBe(0);
    expect(computeVolume(1000, 0)).toBe(0);
  });
});
