import { describe, it, expect } from "vitest";
import { runVoellmy1D } from "./voellmy";
import type { ElevationPoint, SnowProfile } from "@/types";

function pt(dist: number, elev: number): ElevationPoint {
  return { lngLat: [0, 0], elevation: elev, distanceFromCrown: dist };
}

const drySlab: SnowProfile = {
  id: "dry-slab",
  label: "Dry Slab",
  density: 250,
  entrainmentFactor: 2.0,
  frictionMu: 0.3,
  frictionXi: 1500,
};

describe("runVoellmy1D", () => {
  it("returns zero velocity for a flat profile", () => {
    const profile = Array.from({ length: 50 }, (_, i) =>
      pt(i * 10, 1000) // flat terrain at 1000m
    );
    const result = runVoellmy1D(profile, drySlab, 1.0);
    expect(result.maxVelocity).toBeLessThan(1);
  });

  it("produces positive velocity on a steep slope", () => {
    // 35° slope: drop = tan(35°)*10 ≈ 7m per 10m step
    const profile = Array.from({ length: 100 }, (_, i) =>
      pt(i * 10, 2000 - i * 7)
    );
    const result = runVoellmy1D(profile, drySlab, 1.0);
    expect(result.maxVelocity).toBeGreaterThan(10);
    expect(result.dynamicRunout).toBeGreaterThan(0);
  });

  it("velocity increases on steep section and stops on flat runout", () => {
    // Steep for 500m then flat
    const profile: ElevationPoint[] = [];
    for (let i = 0; i < 50; i++) {
      profile.push(pt(i * 10, 2000 - i * 7)); // ~35°
    }
    for (let i = 50; i < 150; i++) {
      profile.push(pt(i * 10, 2000 - 50 * 7)); // flat
    }
    const result = runVoellmy1D(profile, drySlab, 1.0);
    expect(result.maxVelocity).toBeGreaterThan(10);
    // Should stop somewhere on the flat section
    expect(result.dynamicRunout).toBeLessThan(1500);
  });

  it("higher friction (mu) produces shorter runout", () => {
    const profile = Array.from({ length: 100 }, (_, i) =>
      pt(i * 10, 2000 - i * 5)
    );
    const lowFriction = { ...drySlab, frictionMu: 0.2 };
    const highFriction = { ...drySlab, frictionMu: 0.5 };
    const r1 = runVoellmy1D(profile, lowFriction, 1.0);
    const r2 = runVoellmy1D(profile, highFriction, 1.0);
    expect(r1.dynamicRunout).toBeGreaterThan(r2.dynamicRunout);
  });

  it("returns impact pressure proportional to velocity squared", () => {
    const profile = Array.from({ length: 100 }, (_, i) =>
      pt(i * 10, 2000 - i * 7)
    );
    const result = runVoellmy1D(profile, drySlab, 1.0);
    // P = 0.5 * density * v² / 1000 (kPa)
    const expectedMaxP = (0.5 * drySlab.density * result.maxVelocity ** 2) / 1000;
    expect(result.maxPressure).toBeCloseTo(expectedMaxP, 0);
  });

  it("handles very short profiles gracefully", () => {
    const profile = [pt(0, 1000), pt(10, 990)];
    const result = runVoellmy1D(profile, drySlab, 1.0);
    expect(result.maxVelocity).toBeGreaterThanOrEqual(0);
    expect(result.velocity.length).toBe(2);
  });
});
