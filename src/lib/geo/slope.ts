import type { ElevationPoint } from "@/types";

/**
 * Compute slope angle in degrees between two elevation points.
 */
export function computeSlopeAngle(
  p1: ElevationPoint,
  p2: ElevationPoint
): number {
  const horizontalDist = p2.distanceFromCrown - p1.distanceFromCrown;
  if (horizontalDist === 0) return 0;
  const verticalDist = p1.elevation - p2.elevation;
  return (Math.atan2(verticalDist, horizontalDist) * 180) / Math.PI;
}

/**
 * Compute the local slope angle at each point in a profile
 * by averaging the slope to the previous and next points.
 */
export function computeLocalSlopes(profile: ElevationPoint[]): number[] {
  return profile.map((point, i) => {
    if (i === 0 && profile.length > 1) {
      return computeSlopeAngle(point, profile[1]);
    }
    if (i === profile.length - 1 && profile.length > 1) {
      return computeSlopeAngle(profile[i - 1], point);
    }
    if (profile.length < 3) return 0;
    const before = computeSlopeAngle(profile[i - 1], point);
    const after = computeSlopeAngle(point, profile[i + 1]);
    return (before + after) / 2;
  });
}

/**
 * Compute average slope over an entire profile.
 */
export function computeAverageSlope(profile: ElevationPoint[]): number {
  if (profile.length < 2) return 0;
  const first = profile[0];
  const last = profile[profile.length - 1];
  return computeSlopeAngle(first, last);
}
