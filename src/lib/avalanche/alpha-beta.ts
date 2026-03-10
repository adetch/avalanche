import type { ElevationPoint } from "@/types";
import { computeSlopeAngle } from "@/lib/geo/slope";

const BETA_SLOPE_THRESHOLD = 10; // degrees

/**
 * Find the beta point: where local slope first drops below 10 degrees.
 */
export function findBetaPoint(
  profile: ElevationPoint[]
): ElevationPoint | null {
  if (profile.length < 3) return null;

  for (let i = 1; i < profile.length - 1; i++) {
    const localSlope = computeSlopeAngle(profile[i], profile[i + 1]);
    if (localSlope < BETA_SLOPE_THRESHOLD) {
      return profile[i];
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
 */
export function computeAlphaAngle(betaAngle: number): number {
  return 0.96 * betaAngle - 1.4;
}

/**
 * Find the runout point where the terrain profile crosses
 * the alpha-angle line drawn from the crown point.
 *
 * The alpha line represents: elevation = crown.elevation - tan(alpha) * distance
 * The runout is where the terrain is at or above this line.
 */
export function findRunoutPoint(
  profile: ElevationPoint[],
  crown: ElevationPoint,
  alphaAngle: number
): ElevationPoint | null {
  if (profile.length < 2 || alphaAngle <= 0) return null;

  const tanAlpha = Math.tan((alphaAngle * Math.PI) / 180);

  // Walk from the crown outward; the runout point is where
  // the terrain elevation rises above the alpha line.
  // (i.e. terrain is higher than predicted by alpha angle)
  for (let i = 1; i < profile.length; i++) {
    const dist = profile[i].distanceFromCrown - crown.distanceFromCrown;
    const alphaLineElev = crown.elevation - tanAlpha * dist;

    if (profile[i].elevation >= alphaLineElev && dist > 0) {
      return profile[i];
    }
  }

  // If no crossing found, use the end of the profile
  return profile[profile.length - 1];
}
