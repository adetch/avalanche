import { describe, it, expect } from "vitest";
import type { ElevationPoint } from "@/types";
import {
  computeSlopeAngle,
  computeLocalSlopes,
  computeAverageSlope,
} from "./slope";

function pt(dist: number, elev: number): ElevationPoint {
  return { lngLat: [0, 0], elevation: elev, distanceFromCrown: dist };
}

describe("computeSlopeAngle", () => {
  it("returns 45° for equal horizontal and vertical distance", () => {
    expect(computeSlopeAngle(pt(0, 100), pt(100, 0))).toBeCloseTo(45, 5);
  });

  it("returns ~26.6° for 1:2 rise/run", () => {
    expect(computeSlopeAngle(pt(0, 100), pt(200, 0))).toBeCloseTo(26.57, 1);
  });

  it("returns 0 for flat terrain", () => {
    expect(computeSlopeAngle(pt(0, 100), pt(100, 100))).toBeCloseTo(0, 5);
  });

  it("returns negative for uphill", () => {
    expect(computeSlopeAngle(pt(0, 100), pt(100, 200))).toBeLessThan(0);
  });

  it("returns 0 when points are at same distance", () => {
    expect(computeSlopeAngle(pt(0, 100), pt(0, 50))).toBe(0);
  });
});

describe("computeAverageSlope", () => {
  it("returns slope from first to last point", () => {
    const profile = [pt(0, 1000), pt(50, 975), pt(100, 950)];
    // 50m drop over 100m → ~26.6°
    expect(computeAverageSlope(profile)).toBeCloseTo(26.57, 1);
  });

  it("returns 0 for single point", () => {
    expect(computeAverageSlope([pt(0, 100)])).toBe(0);
  });
});

describe("computeLocalSlopes", () => {
  it("returns array of same length as input", () => {
    const profile = [pt(0, 100), pt(10, 95), pt(20, 90)];
    expect(computeLocalSlopes(profile)).toHaveLength(3);
  });

  it("uniform slope gives consistent values", () => {
    const profile = [pt(0, 100), pt(10, 95), pt(20, 90), pt(30, 85)];
    const slopes = computeLocalSlopes(profile);
    // All segments have the same slope, so all local slopes should match
    const expected = computeSlopeAngle(pt(0, 100), pt(10, 95));
    for (const s of slopes) {
      expect(s).toBeCloseTo(expected, 5);
    }
  });
});
