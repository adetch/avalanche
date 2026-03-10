import type { Map as MaplibreMap } from "maplibre-gl";
import * as turf from "@turf/turf";
import { queryElevation } from "@/lib/geo/elevation";
import type { ElevationPoint } from "@/types";

export type ConfinementClass = "channelized" | "partly-confined" | "open";

export interface ConfinementResult {
  classification: ConfinementClass;
  /** Buffer multiplier: channelized=1.0, partly-confined=1.5, open=2.0 */
  bufferMultiplier: number;
  /** Cross-slope elevation rise on left side (meters) */
  leftRise: number;
  /** Cross-slope elevation rise on right side (meters) */
  rightRise: number;
}

/** Minimum rise on both sides to consider channelized (gully walls) */
const CHANNELIZED_RISE_M = 10;
/** Minimum rise on at least one side for partly confined */
const PARTLY_CONFINED_RISE_M = 5;
/** How far to sample cross-slope (meters) */
const CROSS_SLOPE_SAMPLE_DIST_M = 100;
/** Number of sample points per side */
const SAMPLES_PER_SIDE = 5;

/**
 * Detect path confinement by sampling cross-slope elevation at a profile point.
 *
 * Samples perpendicular to the flow direction. If terrain rises significantly
 * on both sides, the path is channelized (gully). If one side rises, partly
 * confined. If neither, open slope.
 */
export function detectConfinement(
  map: MaplibreMap,
  point: ElevationPoint,
  flowBearing: number
): ConfinementResult {
  const centerElev = point.elevation;
  const leftBearing = (flowBearing - 90 + 360) % 360;
  const rightBearing = (flowBearing + 90) % 360;

  const leftRise = sampleMaxRise(map, point.lngLat, centerElev, leftBearing);
  const rightRise = sampleMaxRise(map, point.lngLat, centerElev, rightBearing);

  let classification: ConfinementClass;
  let bufferMultiplier: number;

  if (leftRise >= CHANNELIZED_RISE_M && rightRise >= CHANNELIZED_RISE_M) {
    classification = "channelized";
    bufferMultiplier = 1.0;
  } else if (leftRise >= PARTLY_CONFINED_RISE_M || rightRise >= PARTLY_CONFINED_RISE_M) {
    classification = "partly-confined";
    bufferMultiplier = 1.5;
  } else {
    classification = "open";
    bufferMultiplier = 2.0;
  }

  return { classification, bufferMultiplier, leftRise, rightRise };
}

/**
 * Sample perpendicular cross-slope and return the maximum elevation rise
 * above the center point.
 */
function sampleMaxRise(
  map: MaplibreMap,
  center: [number, number],
  centerElev: number,
  bearing: number
): number {
  let maxRise = 0;
  const stepM = CROSS_SLOPE_SAMPLE_DIST_M / SAMPLES_PER_SIDE;

  for (let i = 1; i <= SAMPLES_PER_SIDE; i++) {
    const dist = stepM * i;
    const pt = turf.destination(center, dist / 1000, bearing, {
      units: "kilometers",
    });
    const coord = pt.geometry.coordinates as [number, number];
    const elev = queryElevation(map, coord);
    if (elev === null) continue;

    const rise = elev - centerElev;
    if (rise > maxRise) maxRise = rise;
  }

  return maxRise;
}

/**
 * Estimate average confinement along a path by sampling at multiple points.
 * Samples at 25%, 50%, and 75% of the track (between crown and beta).
 */
export function estimatePathConfinement(
  map: MaplibreMap,
  profile: ElevationPoint[],
  betaDist: number
): ConfinementResult {
  const sampleDists = [0.25, 0.5, 0.75].map((f) => f * betaDist);
  const results: ConfinementResult[] = [];

  for (const targetDist of sampleDists) {
    // Find closest profile point
    let bestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < profile.length; i++) {
      const diff = Math.abs(profile[i].distanceFromCrown - targetDist);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }

    // Compute flow bearing at this point
    const nextIdx = Math.min(bestIdx + 1, profile.length - 1);
    const bearing = turf.bearing(
      turf.point(profile[bestIdx].lngLat),
      turf.point(profile[nextIdx].lngLat)
    );

    results.push(detectConfinement(map, profile[bestIdx], bearing));
  }

  // Average the multipliers
  const avgMultiplier =
    results.reduce((sum, r) => sum + r.bufferMultiplier, 0) / results.length;
  const avgLeftRise =
    results.reduce((sum, r) => sum + r.leftRise, 0) / results.length;
  const avgRightRise =
    results.reduce((sum, r) => sum + r.rightRise, 0) / results.length;

  let classification: ConfinementClass;
  if (avgMultiplier <= 1.25) classification = "channelized";
  else if (avgMultiplier <= 1.75) classification = "partly-confined";
  else classification = "open";

  return {
    classification,
    bufferMultiplier: avgMultiplier,
    leftRise: avgLeftRise,
    rightRise: avgRightRise,
  };
}
