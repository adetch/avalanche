import type { ElevationPoint, RegionCoefficients } from "@/types";
import { computeSlopeAngle } from "@/lib/geo/slope";

const BETA_SLOPE_THRESHOLD = 10; // degrees
const BETA_WINDOW_SIZE = 3; // consecutive points below threshold needed

/**
 * Regional coefficient sets for the alpha-beta model.
 * α = a·β + b, with standard deviation σ.
 *
 * Sources:
 * - Lied & Bakkehøi (1980), Bakkehøi et al. (1983)
 * - McClung & Mears (1991)
 * - Mears (1989, 1992)
 * - Jóhannesson (1998)
 */
export const REGION_COEFFICIENTS: RegionCoefficients[] = [
  { id: "norway", label: "Norway", a: 0.96, b: -1.4, sigma: 2.3, source: "Lied & Bakkehøi (1980)" },
  { id: "canadian-rockies", label: "Canadian Rockies", a: 0.93, b: -0.1, sigma: 2.5, source: "McClung & Mears (1991)" },
  { id: "colorado", label: "Colorado", a: 0.92, b: 0.3, sigma: 2.2, source: "Mears (1989)" },
  { id: "iceland", label: "Iceland", a: 0.91, b: -0.7, sigma: 2.0, source: "Jóhannesson (1998)" },
  { id: "sierra-nevada", label: "Sierra Nevada", a: 0.91, b: 1.2, sigma: 2.3, source: "Mears (1992)" },
];

export const DEFAULT_REGION = REGION_COEFFICIENTS[0]; // Norway

export function findRegion(id: string): RegionCoefficients | undefined {
  return REGION_COEFFICIENTS.find((r) => r.id === id);
}

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
 * Compute alpha angle using regional regression coefficients:
 * α = a·β + b
 * Clamped to a minimum of 1° to avoid nonsensical results on gentle terrain.
 */
export function computeAlphaAngle(
  betaAngle: number,
  region: RegionCoefficients = DEFAULT_REGION
): number {
  return Math.max(region.a * betaAngle + region.b, 1);
}

/**
 * Compute alpha angle confidence bands using regional regression coefficients.
 *
 * - low: α − 1σ → longer runout (~84th percentile, conservative)
 * - mid: α (mean)
 * - high: α + 1σ → shorter runout (~16th percentile)
 *
 * Lower alpha angles mean the avalanche travels further.
 */
export function computeAlphaConfidence(
  betaAngle: number,
  region: RegionCoefficients = DEFAULT_REGION
): AlphaConfidence {
  const mid = computeAlphaAngle(betaAngle, region);
  return {
    low: Math.max(mid - region.sigma, 1),
    mid,
    high: mid + region.sigma,
  };
}

/**
 * Fit a quadratic z = a*s² + b*s + c to the profile using least squares.
 * Returns { zpp: 2a (second derivative / curvature), H0: vertical range of fit }.
 *
 * Used by the extended AvaFrame alpha-beta equation:
 *   α = k1*β + k2*z'' + k3*H0 + k4
 *
 * Positive z'' = concave (bowl), negative = convex (ridge).
 */
export function fitQuadraticProfile(
  profile: ElevationPoint[]
): { zpp: number; H0: number } | null {
  const n = profile.length;
  if (n < 5) return null;

  // Normalize s to [0, 1] for numerical stability
  const sMax = profile[n - 1].distanceFromCrown;
  if (sMax <= 0) return null;

  // Least squares: z = a*s² + b*s + c
  // Normal equations: [S4 S3 S2] [a]   [Sz2]
  //                   [S3 S2 S1] [b] = [Sz1]
  //                   [S2 S1 S0] [c]   [Sz0]
  let S0 = 0, S1 = 0, S2 = 0, S3 = 0, S4 = 0;
  let Sz0 = 0, Sz1 = 0, Sz2 = 0;

  for (let i = 0; i < n; i++) {
    const s = profile[i].distanceFromCrown / sMax;
    const z = profile[i].elevation;
    const s2 = s * s;
    S0 += 1;
    S1 += s;
    S2 += s2;
    S3 += s2 * s;
    S4 += s2 * s2;
    Sz0 += z;
    Sz1 += z * s;
    Sz2 += z * s2;
  }

  // Solve 3×3 system using Cramer's rule
  const det =
    S4 * (S2 * S0 - S1 * S1) -
    S3 * (S3 * S0 - S1 * S2) +
    S2 * (S3 * S1 - S2 * S2);

  if (Math.abs(det) < 1e-12) return null;

  const a =
    (Sz2 * (S2 * S0 - S1 * S1) -
     S3 * (Sz1 * S0 - S1 * Sz0) +
     S2 * (Sz1 * S1 - S2 * Sz0)) / det;

  // z'' = 2a, but we need to un-normalize: actual z'' = 2a / sMax²
  const zpp = (2 * a) / (sMax * sMax);

  // H0: vertical range of the quadratic fit
  // Evaluate at s=0 and s=1 (crown and end)
  const b =
    (S4 * (Sz1 * S0 - S1 * Sz0) -
     Sz2 * (S3 * S0 - S1 * S2) +
     S2 * (S3 * Sz0 - Sz1 * S2)) / det;
  const c =
    (S4 * (S2 * Sz0 - Sz1 * S1) -
     S3 * (S3 * Sz0 - Sz1 * S2) +
     Sz2 * (S3 * S1 - S2 * S2)) / det;

  // Sample the polynomial to find actual range
  let zMin = Infinity, zMax = -Infinity;
  for (let i = 0; i <= 20; i++) {
    const s = i / 20;
    const z = a * s * s + b * s + c;
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
  }
  const H0 = zMax - zMin;

  return { zpp, H0 };
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
