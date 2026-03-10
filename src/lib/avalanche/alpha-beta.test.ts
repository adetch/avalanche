import { describe, it, expect } from "vitest";
import type { ElevationPoint } from "@/types";
import {
  findBetaPoint,
  computeBetaAngle,
  computeAlphaAngle,
  computeAlphaConfidence,
  findRunoutPoint,
} from "./alpha-beta";

/** Helper to create a profile point */
function pt(dist: number, elev: number): ElevationPoint {
  return { lngLat: [0, 0], elevation: elev, distanceFromCrown: dist };
}

describe("computeAlphaAngle", () => {
  it("applies the Lied & Bakkehoi regression: α = 0.96β − 1.4", () => {
    expect(computeAlphaAngle(20)).toBeCloseTo(0.96 * 20 - 1.4, 5);
    expect(computeAlphaAngle(30)).toBeCloseTo(0.96 * 30 - 1.4, 5);
  });

  it("clamps to minimum of 1°", () => {
    expect(computeAlphaAngle(0)).toBe(1);
    expect(computeAlphaAngle(1)).toBe(1);
    expect(computeAlphaAngle(2)).toBe(1);
  });

  it("alpha is always less than beta for typical avalanche angles", () => {
    for (const beta of [15, 20, 25, 30, 35, 40]) {
      expect(computeAlphaAngle(beta)).toBeLessThan(beta);
    }
  });
});

describe("computeBetaAngle", () => {
  it("computes arctan(drop / distance)", () => {
    const crown = pt(0, 3000);
    const beta = pt(1000, 2800);
    // drop = 200, distance = 1000 → arctan(200/1000) ≈ 11.31°
    expect(computeBetaAngle(crown, beta)).toBeCloseTo(11.31, 1);
  });

  it("returns 0 when horizontal distance is zero", () => {
    const crown = pt(0, 3000);
    const same = pt(0, 2800);
    expect(computeBetaAngle(crown, same)).toBe(0);
  });

  it("returns 45° for equal drop and distance", () => {
    expect(computeBetaAngle(pt(0, 1000), pt(500, 500))).toBeCloseTo(45, 5);
  });
});

describe("findBetaPoint", () => {
  it("returns null for a profile that is too short", () => {
    expect(findBetaPoint([pt(0, 100), pt(10, 90)])).toBeNull();
  });

  it("finds the beta point where slope drops below 10° for 3 consecutive points", () => {
    // Steep section (30° ≈ tan(30°) = 0.577, so drop ~5.77m per 10m step)
    const profile: ElevationPoint[] = [
      pt(0, 1000),
      pt(10, 994), // ~31°
      pt(20, 988), // ~31°
      pt(30, 982), // ~31°
      pt(40, 976), // ~31°
      // Transition to gentle (5° ≈ tan(5°) = 0.0875, drop ~0.875m per 10m)
      pt(50, 975.1), // ~5°
      pt(60, 974.2), // ~5°
      pt(70, 973.3), // ~5°
      pt(80, 972.4), // ~5°
    ];
    const beta = findBetaPoint(profile);
    expect(beta).not.toBeNull();
    // Beta is the first point whose slope to the next point is < 10° (index 4, dist=40)
    expect(beta!.distanceFromCrown).toBe(40);
  });

  it("returns null when slope never drops below 10°", () => {
    // Consistently steep profile
    const profile: ElevationPoint[] = [];
    for (let i = 0; i < 20; i++) {
      profile.push(pt(i * 10, 1000 - i * 6)); // ~31° throughout
    }
    expect(findBetaPoint(profile)).toBeNull();
  });

  it("ignores brief dips below 10° that don't persist for 3 points", () => {
    const profile: ElevationPoint[] = [
      pt(0, 1000),
      pt(10, 994), // steep
      pt(20, 988), // steep
      pt(30, 987.5), // brief flat
      pt(40, 987.0), // brief flat (only 2 consecutive)
      pt(50, 981), // steep again
      pt(60, 975),
      pt(70, 974.5), // now gently for 3+
      pt(80, 974.0),
      pt(90, 973.5),
      pt(100, 973.0),
    ];
    const beta = findBetaPoint(profile);
    expect(beta).not.toBeNull();
    // Should skip the brief dip and find the sustained gentle section (index 6, dist=60)
    expect(beta!.distanceFromCrown).toBe(60);
  });
});

describe("findRunoutPoint", () => {
  it("finds where terrain crosses back above the alpha line", () => {
    const crown = pt(0, 1000);
    const alphaAngle = 10; // tan(10°) ≈ 0.1763
    const betaPoint = pt(200, 900);

    // Profile: terrain drops below alpha line then rises back
    const profile: ElevationPoint[] = [];
    for (let d = 0; d <= 500; d += 10) {
      // Alpha line elevation at d: 1000 - tan(10°)*d
      const alphaElev = 1000 - Math.tan((10 * Math.PI) / 180) * d;
      // Terrain: starts above alpha, dips below around 250-400, rises back
      let terrain: number;
      if (d <= 200) {
        terrain = 1000 - d * 0.5; // 26.5° — steep, above alpha
      } else if (d <= 400) {
        terrain = alphaElev - 5; // 5m below alpha line
      } else {
        terrain = alphaElev + 5; // back above alpha line
      }
      profile.push(pt(d, terrain));
    }

    const runout = findRunoutPoint(profile, crown, alphaAngle, betaPoint);
    expect(runout).not.toBeNull();
    // Should find the crossing around d=400+
    expect(runout!.distanceFromCrown).toBeGreaterThanOrEqual(400);
  });

  it("returns last profile point when alpha line never intersects", () => {
    const crown = pt(0, 1000);
    const betaPoint = pt(100, 950);
    // Very gentle alpha angle — terrain always below
    const profile: ElevationPoint[] = [];
    for (let d = 0; d <= 300; d += 10) {
      profile.push(pt(d, 1000 - d * 2)); // Much steeper than alpha
    }
    const runout = findRunoutPoint(profile, crown, 5, betaPoint);
    expect(runout).not.toBeNull();
    expect(runout!.distanceFromCrown).toBe(300);
  });

  it("returns null for empty profile", () => {
    expect(findRunoutPoint([], pt(0, 100), 10, pt(50, 90))).toBeNull();
  });

  it("returns closest approach on gentle terrain where terrain stays above alpha line", () => {
    const crown = pt(0, 1000);
    const alphaAngle = 10; // tan(10°) ≈ 0.1763
    const betaPoint = pt(100, 985);

    // Terrain drops gently (slope < alpha angle), so terrain stays ABOVE the alpha line.
    // Alpha line at d: 1000 - tan(10°)*d = 1000 - 0.1763*d
    // Terrain at d:    1000 - 0.01*d  (very gentle ~0.6° slope)
    // Gap = terrain - alpha_line = 0.1663*d  (gap grows with distance)
    // BUT we add a dip near d=200 so closest approach is there
    const profile: ElevationPoint[] = [];
    for (let d = 0; d <= 500; d += 10) {
      const alphaElev = 1000 - Math.tan((10 * Math.PI) / 180) * d;
      // Base terrain gently slopes, stays above alpha, with a dip toward it near 200m
      const dip = d >= 180 && d <= 220 ? 15 : 0;
      const terrain = 1000 - 0.01 * d - dip;
      // Ensure terrain stays above alpha line even with the dip
      profile.push(pt(d, Math.max(terrain, alphaElev + 1)));
    }

    const runout = findRunoutPoint(profile, crown, alphaAngle, betaPoint);
    expect(runout).not.toBeNull();
    // Should be near the dip (d≈200), not at end of profile (d=500)
    expect(runout!.distanceFromCrown).toBeLessThanOrEqual(300);
  });
});

describe("computeAlphaConfidence", () => {
  it("returns low < mid < high", () => {
    const conf = computeAlphaConfidence(25);
    expect(conf.low).toBeLessThan(conf.mid);
    expect(conf.mid).toBeLessThan(conf.high);
  });

  it("mid matches computeAlphaAngle", () => {
    const conf = computeAlphaConfidence(25);
    expect(conf.mid).toBeCloseTo(computeAlphaAngle(25), 5);
  });

  it("bands are separated by the standard deviation (2.3°)", () => {
    const conf = computeAlphaConfidence(25);
    expect(conf.mid - conf.low).toBeCloseTo(2.3, 5);
    expect(conf.high - conf.mid).toBeCloseTo(2.3, 5);
  });

  it("low is clamped to minimum 1°", () => {
    const conf = computeAlphaConfidence(5);
    expect(conf.low).toBeGreaterThanOrEqual(1);
  });
});
