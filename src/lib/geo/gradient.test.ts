import { describe, it, expect } from "vitest";
import { blendBearings, bearingToCardinal } from "./gradient";

describe("blendBearings", () => {
  it("returns bearing1 when weight1 is 1", () => {
    expect(blendBearings(90, 270, 1)).toBeCloseTo(90, 1);
  });

  it("returns bearing2 when weight1 is 0", () => {
    expect(blendBearings(90, 270, 0)).toBeCloseTo(270, 1);
  });

  it("blends two nearby bearings", () => {
    // 50/50 blend of 80° and 100° should be ~90°
    expect(blendBearings(80, 100, 0.5)).toBeCloseTo(90, 1);
  });

  it("handles wrap-around at 0°/360°", () => {
    // 50/50 blend of 350° and 10° should be ~0° (or 360°, which is equivalent)
    const result = blendBearings(350, 10, 0.5);
    expect(result % 360).toBeCloseTo(0, 0);
  });

  it("handles opposite bearings with weighted blend", () => {
    // 70/30 blend of 0° and 180° — should lean toward 0°
    const result = blendBearings(0, 180, 0.7);
    // Vector: 0.7*sin(0)+0.3*sin(180) ≈ 0, 0.7*cos(0)+0.3*cos(180) = 0.4 → 0°
    expect(result).toBeCloseTo(0, 0);
  });

  it("applies momentum smoothing correctly", () => {
    // Simulating: previous bearing 200°, new gradient says 210°, weight 0.7 for new
    const blended = blendBearings(210, 200, 0.7);
    expect(blended).toBeGreaterThan(200);
    expect(blended).toBeLessThan(210);
    expect(blended).toBeCloseTo(207, 0);
  });
});

describe("bearingToCardinal", () => {
  it("maps 0° to N", () => {
    expect(bearingToCardinal(0)).toBe("N");
  });

  it("maps 90° to E", () => {
    expect(bearingToCardinal(90)).toBe("E");
  });

  it("maps 180° to S", () => {
    expect(bearingToCardinal(180)).toBe("S");
  });

  it("maps 270° to W", () => {
    expect(bearingToCardinal(270)).toBe("W");
  });

  it("maps 203° to SSW", () => {
    expect(bearingToCardinal(203)).toBe("SSW");
  });

  it("maps 360° to N (wrap)", () => {
    expect(bearingToCardinal(360)).toBe("N");
  });

  it("handles negative bearings", () => {
    expect(bearingToCardinal(-90)).toBe("W");
  });

  it("maps 45° to NE", () => {
    expect(bearingToCardinal(45)).toBe("NE");
  });
});
