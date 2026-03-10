import type { ElevationPoint } from "@/types";
import { computeSlopeAngle } from "@/lib/geo/slope";

const BETA_SLOPE_THRESHOLD = 10; // degrees
const BETA_WINDOW_SIZE = 3; // consecutive points below threshold needed

/** Standard deviation for the Lied & Bakkehoi regression (degrees) */
const ALPHA_BETA_SD = 2.3;

export interface AlphaConfidence {
  /** Conservative runout (α − 1σ, ~84th percentile) */
  low: number;
  /** Mean runout (α) */
  mid: number;
  /** Liberal/short runout (α + 1σ, ~16th percentile) */
  high: number;
}

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
 * Compute alpha angle confidence bands using the regression standard deviation.
 *
 * - low: α − 1σ → longer runout (~84th percentile, conservative)
 * - mid: α (mean)
 * - high: α + 1σ → shorter runout (~16th percentile)
 *
 * Lower alpha angles mean the avalanche travels further.
 */
export function computeAlphaConfidence(betaAngle: number): AlphaConfidence {
  const mid = computeAlphaAngle(betaAngle);
  return {
    low: Math.max(mid - ALPHA_BETA_SD, 1),
    mid,
    high: mid + ALPHA_BETA_SD,
  };
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
  let closestApproachIdx = startIdx;
  let closestApproachGap = Infinity;

  for (let i = startIdx; i < profile.length; i++) {
    const dist = profile[i].distanceFromCrown - crown.distanceFromCrown;
    const alphaLineElev = crown.elevation - tanAlpha * dist;
    const gap = alphaLineElev - profile[i].elevation;

    if (profile[i].elevation < alphaLineElev) {
      wasBelow = true;
    }

    // Track closest approach for fallback
    if (gap >= 0 && gap < closestApproachGap) {
      closestApproachGap = gap;
      closestApproachIdx = i;
    }

    if (wasBelow && profile[i].elevation >= alphaLineElev) {
      return profile[i];
    }
  }

  // If terrain never dips below alpha line, use closest approach point
  // instead of blindly returning the profile end (fixes H4: gentle-terrain overestimation)
  if (!wasBelow) {
    return profile[closestApproachIdx];
  }

  // If terrain dipped below but never crossed back, use the end
  return profile[profile.length - 1];
}
