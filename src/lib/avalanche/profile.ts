import type { Map as MaplibreMap } from "maplibre-gl";
import * as turf from "@turf/turf";
import { queryElevation } from "@/lib/geo/elevation";
import { computeLocalGradient, blendBearings } from "@/lib/geo/gradient";
import type { ElevationPoint } from "@/types";

/** How much the current gradient is weighted vs previous bearing (momentum) */
const GRADIENT_WEIGHT = 0.7;
/** Minimum slope (degrees) before we consider terrain effectively flat */
const FLAT_SLOPE_THRESHOLD = 1.5;
/** How many consecutive uphill steps before we stop */
const MAX_UPHILL_STEPS = 3;
/** Gradient sample radius in meters */
const GRADIENT_SAMPLE_RADIUS_M = 30;

/**
 * Extract an elevation profile by following the steepest descent from the crown.
 *
 * Instead of sampling along a fixed bearing, this computes the local terrain
 * gradient at each step and follows the steepest descent direction. The path
 * naturally curves to follow gullies, wrap around ridges, and track aspect changes.
 *
 * Momentum smoothing (70% gradient / 30% previous bearing) dampens DEM noise.
 */
export function extractGradientProfile(
  map: MaplibreMap,
  crownPoint: [number, number],
  initialBearing: number,
  maxDistanceMeters: number = 3000,
  stepMeters: number = 10
): ElevationPoint[] {
  const crownElev = queryElevation(map, crownPoint);
  if (crownElev === null) return [];

  const profile: ElevationPoint[] = [
    { lngLat: crownPoint, elevation: crownElev, distanceFromCrown: 0 },
  ];

  let currentPos = crownPoint;
  let previousBearing = initialBearing;
  let totalDistance = 0;
  let uphillCount = 0;

  while (totalDistance < maxDistanceMeters) {
    // Compute gradient at current position
    const gradient = computeLocalGradient(
      map,
      currentPos,
      GRADIENT_SAMPLE_RADIUS_M
    );

    let stepBearing: number;

    if (gradient && gradient.slopeDeg > FLAT_SLOPE_THRESHOLD) {
      // Blend gradient direction with momentum from previous bearing
      stepBearing = blendBearings(
        gradient.aspectDeg,
        previousBearing,
        GRADIENT_WEIGHT
      );
    } else {
      // Flat or no gradient data — continue in previous direction
      stepBearing = previousBearing;
    }

    // Take a step
    const next = turf.destination(currentPos, stepMeters / 1000, stepBearing, {
      units: "kilometers",
    });
    const nextPos = next.geometry.coordinates as [number, number];
    const nextElev = queryElevation(map, nextPos);

    if (nextElev === null) break;

    totalDistance += stepMeters;

    const prevElev = profile[profile.length - 1].elevation;

    // Track uphill steps
    if (nextElev > prevElev + 0.5) {
      uphillCount++;
      if (uphillCount >= MAX_UPHILL_STEPS) break;
    } else {
      uphillCount = 0;
    }

    profile.push({
      lngLat: nextPos,
      elevation: nextElev,
      distanceFromCrown: totalDistance,
    });

    previousBearing = stepBearing;
    currentPos = nextPos;
  }

  return profile;
}
