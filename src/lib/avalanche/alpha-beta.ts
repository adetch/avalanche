import type { ElevationPoint } from "@/types";
import { computeSlopeAngle } from "@/lib/geo/slope";

const BETA_SLOPE_THRESHOLD = 10; // degrees
const BETA_WINDOW_SIZE = 3; // consecutive points below threshold needed

/**
 * Find the beta point: where local slope drops below 10 degrees
 * for BETA_WINDOW_SIZE consecutive points (avoids DEM noise false positives).
 */
export function findBetaPoint(
  profile: ElevationPoint[]
): ElevationPoint | null {
  if (profile.length < BETA_WINDOW_SIZE + 2) return null;

  let belowCount = 0;
  let firstBelowIdx = -1;

  for (let i = 1; i < profile.length - 1; i++) {
    const localSlope = computeSlopeAngle(profile[i], profile[i + 1]);
    if (localSlope < BETA_SLOPE_THRESHOLD) {
      if (belowCount === 0) firstBelowIdx = i;
      belowCount++;
      if (belowCount >= BETA_WINDOW_SIZE) {
        return profile[firstBelowIdx];
      }
    } else {
      belowCount = 0;
      firstBelowIdx = -1;
    }
  }

  return null;
}

/**
 * Compute the beta angle from crown to beta point.
 * Beta angle = arctan(elevation_drop / horizontal_distance)
 */
export function computeBetaAngle(
  crown: ElevationPoint,
  betaPoint: ElevationPoint
): number {
  const elevDrop = crown.elevation - betaPoint.elevation;
  const horizDist = betaPoint.distanceFromCrown - crown.distanceFromCrown;
  if (horizDist <= 0) return 0;
  return (Math.atan2(elevDrop, horizDist) * 180) / Math.PI;
}

/**
 * Compute alpha angle using the Lied & Bakkehoi (1980) regression:
 * alpha = 0.96 * beta - 1.4
 * Clamped to a minimum of 1° to avoid nonsensical results on gentle terrain.
 */
export function computeAlphaAngle(betaAngle: number): number {
  return Math.max(0.96 * betaAngle - 1.4, 1);
}

/**
 * Find the runout point where the terrain profile crosses
 * the alpha-angle line drawn from the crown point.
 *
 * The alpha line represents: elevation = crown.elevation - tan(alpha) * distance
 * Searches only past the beta point, looking for where terrain crosses
 * back above the alpha line after being below it.
 */
export function findRunoutPoint(
  profile: ElevationPoint[],
  crown: ElevationPoint,
  alphaAngle: number,
  betaPoint: ElevationPoint
): ElevationPoint | null {
  if (profile.length < 2 || alphaAngle <= 0) return null;

  const tanAlpha = Math.tan((alphaAngle * Math.PI) / 180);

  // Start searching from the beta point onward
  let startIdx = 1;
  for (let i = 0; i < profile.length; i++) {
    if (profile[i].distanceFromCrown >= betaPoint.distanceFromCrown) {
      startIdx = i;
      break;
    }
  }

  // Look for where terrain crosses back above the alpha line after being below
  let wasBelow = false;
  for (let i = startIdx; i < profile.length; i++) {
    const dist = profile[i].distanceFromCrown - crown.distanceFromCrown;
    const alphaLineElev = crown.elevation - tanAlpha * dist;

    if (profile[i].elevation < alphaLineElev) {
      wasBelow = true;
    }

    if (wasBelow && profile[i].elevation >= alphaLineElev) {
      return profile[i];
    }
  }

  // If no crossing found, use the end of the profile
  return profile[profile.length - 1];
}
