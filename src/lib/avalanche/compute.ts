import type { Map as MaplibreMap } from "maplibre-gl";
import type { Polygon } from "geojson";
import * as turf from "@turf/turf";
import type {
  AvalancheResult,
  AvalanchePath,
  ElevationPoint,
  PathResult,
} from "@/types";
import { findHighestPoint } from "@/lib/geo/elevation";
import { computeAverageSlope } from "@/lib/geo/slope";
import { computeLocalGradient } from "@/lib/geo/gradient";
import { extractGradientProfile } from "./profile";
import {
  findBetaPoint,
  computeBetaAngle,
  computeAlphaAngle,
  computeAlphaConfidence,
  findRunoutPoint,
} from "./alpha-beta";
import { computeVolume } from "./volume";
import { classifyDestructiveSize } from "./destructive-size";
import {
  generateTrackZone,
  generateRunoutZone,
  findProfileIndex,
  estimateStartingZoneWidth,
} from "./zones";
import { sampleReleasePoints } from "./release-points";
import type { ReleasePoint } from "./release-points";

export interface ComputeFailure {
  reason: string;
  step: string;
  details: Record<string, unknown>;
}

type ComputeResult =
  | { ok: true; result: AvalancheResult }
  | { ok: false; failure: ComputeFailure };

/**
 * Compute the bearing from one profile point to the next.
 */
function bearingBetween(a: ElevationPoint, b: ElevationPoint): number {
  return turf.bearing(turf.point(a.lngLat), turf.point(b.lngLat));
}

/**
 * Normalize a bearing to 0-360 range.
 */
function normalizeBearing(b: number): number {
  return ((b % 360) + 360) % 360;
}

/**
 * Get the aspect (facing direction) at a profile point.
 */
function aspectAtProfilePoint(
  profile: ElevationPoint[],
  index: number
): number {
  if (index < profile.length - 1) {
    return normalizeBearing(bearingBetween(profile[index], profile[index + 1]));
  }
  if (index > 0) {
    return normalizeBearing(
      bearingBetween(profile[index - 1], profile[index])
    );
  }
  return 0;
}

/**
 * Compute a single avalanche path from a given release point.
 * Returns the path result or null if computation fails at any step.
 */
function computeSinglePath(
  map: MaplibreMap,
  releasePoint: ReleasePoint
): PathResult | null {
  const { lngLat, elevation, aspectDeg: initialBearing } = releasePoint;

  // Extract elevation profile by following steepest descent
  const profile = extractGradientProfile(map, lngLat, initialBearing, 3000, 10);
  if (profile.length < 5) return null;

  const crownPoint: ElevationPoint = {
    lngLat,
    elevation,
    distanceFromCrown: 0,
  };

  // Compute slope from first ~100m of profile
  const slopeEnd = Math.min(10, Math.floor(profile.length / 3));
  const slopeProfile = profile.slice(0, Math.max(2, slopeEnd));
  const slopeAngle = Math.max(computeAverageSlope(slopeProfile), 0);

  // Find beta point
  const betaPoint = findBetaPoint(profile);
  if (!betaPoint) return null;

  // Compute alpha angle and runout
  const betaAngle = computeBetaAngle(crownPoint, betaPoint);
  const alphaAngle = computeAlphaAngle(betaAngle);
  const alphaConfidence = computeAlphaConfidence(betaAngle);
  const runoutPoint = findRunoutPoint(profile, crownPoint, alphaAngle, betaPoint);
  if (!runoutPoint) return null;

  // Distances
  const horizontalRunout = runoutPoint.distanceFromCrown;
  const verticalDrop = crownPoint.elevation - runoutPoint.elevation;

  // Aspect at key points
  const betaIdx = findProfileIndex(profile, betaPoint);
  const runoutIdx = findProfileIndex(profile, runoutPoint);
  const crownAspect = initialBearing;
  const betaAspect = aspectAtProfilePoint(profile, betaIdx);
  const runoutAspect = aspectAtProfilePoint(profile, runoutIdx);

  let bearingChange = Math.abs(runoutAspect - crownAspect);
  if (bearingChange > 180) bearingChange = 360 - bearingChange;

  return {
    crownPoint,
    betaPoint,
    runoutPoint,
    profile,
    fallLineAzimuth: initialBearing,
    betaAngle,
    alphaAngle,
    alphaConfidence,
    slopeAngle,
    horizontalRunout,
    verticalDrop,
    crownAspect,
    betaAspect,
    runoutAspect,
    bearingChange,
  };
}

/**
 * Run the full avalanche path computation pipeline with multi-path support.
 *
 * Samples multiple release points within the starting zone polygon and
 * computes independent paths from each. The primary result uses the path
 * with the longest runout (conservative). All paths are returned for
 * the ensemble visualization.
 */
export function computeAvalanchePath(
  map: MaplibreMap,
  startingZone: Polygon,
  _slopeAngle: number,
  snowDepthCm: number
): ComputeResult {
  // 1. Sample release points within the polygon
  const releasePoints = sampleReleasePoints(map, startingZone, 7);

  if (releasePoints.length === 0) {
    // Fallback: try the highest vertex
    const coords = startingZone.coordinates[0].map(
      (c) => [c[0], c[1]] as [number, number]
    );
    const crown = findHighestPoint(map, coords);
    if (!crown) {
      return {
        ok: false,
        failure: {
          reason: "Could not read terrain elevation at polygon vertices",
          step: "find_crown",
          details: { vertexCount: coords.length },
        },
      };
    }
    const gradient = computeLocalGradient(map, crown.lngLat, 50);
    if (gradient) {
      releasePoints.push({
        lngLat: crown.lngLat,
        elevation: crown.elevation,
        slopeDeg: gradient.slopeDeg,
        aspectDeg: gradient.aspectDeg,
      });
    }
  }

  if (releasePoints.length === 0) {
    return {
      ok: false,
      failure: {
        reason: "Could not compute terrain gradient at any point in the starting zone.",
        step: "release_points",
        details: {},
      },
    };
  }

  // 2. Compute paths from each release point
  const allPaths: PathResult[] = [];
  for (const rp of releasePoints) {
    const path = computeSinglePath(map, rp);
    if (path) allPaths.push(path);
  }

  if (allPaths.length === 0) {
    return {
      ok: false,
      failure: {
        reason: "No valid avalanche path found from any release point. Terrain may be too flat or too uniformly steep.",
        step: "compute_paths",
        details: {
          releasePointCount: releasePoints.length,
          highestElev: releasePoints[0].elevation,
        },
      },
    };
  }

  // 3. Select primary path: longest runout (conservative)
  allPaths.sort((a, b) => b.horizontalRunout - a.horizontalRunout);
  const primary = allPaths[0];

  // 4. Generate zone geometries from the primary path
  const zoneWidth = estimateStartingZoneWidth(startingZone);
  const betaIdx = findProfileIndex(primary.profile, primary.betaPoint);
  const runoutIdx = findProfileIndex(primary.profile, primary.runoutPoint);

  const trackStart = Math.min(5, betaIdx);
  const trackZone = generateTrackZone(
    primary.profile,
    trackStart,
    betaIdx,
    zoneWidth
  );
  const runoutZone = generateRunoutZone(
    primary.profile,
    betaIdx,
    runoutIdx,
    zoneWidth
  );

  const trackPoly = trackZone ?? startingZone;
  const runoutPoly = runoutZone ?? startingZone;

  // 5. Compute volume and destructive size
  const areaSqMeters = turf.area(startingZone);
  const slopeRad = (primary.slopeAngle * Math.PI) / 180;
  const slopeAreaFactor = 1 / Math.cos(slopeRad);
  const effectiveArea = areaSqMeters * slopeAreaFactor;
  const volume = computeVolume(effectiveArea, snowDepthCm);
  const destructiveSize = classifyDestructiveSize(volume);

  // 6. Track length
  const trackLength = Math.sqrt(
    primary.horizontalRunout * primary.horizontalRunout +
      primary.verticalDrop * primary.verticalDrop
  );

  // 7. Runout range across all paths
  const runoutDistances = allPaths.map((p) => p.horizontalRunout);
  const minRunout = Math.min(...runoutDistances);
  const maxRunout = Math.max(...runoutDistances);
  const medianRunout = runoutDistances.sort((a, b) => a - b)[
    Math.floor(runoutDistances.length / 2)
  ];

  return {
    ok: true,
    result: {
      computedSlopeAngle: primary.slopeAngle,
      path: {
        crownPoint: primary.crownPoint,
        betaPoint: primary.betaPoint,
        runoutPoint: primary.runoutPoint,
        fallLineAzimuth: primary.fallLineAzimuth,
        betaAngle: primary.betaAngle,
        alphaAngle: primary.alphaAngle,
        profile: primary.profile,
        startingZone,
        trackZone: trackPoly,
        runoutZone: runoutPoly,
      },
      volume,
      destructiveSize,
      horizontalRunout: primary.horizontalRunout,
      verticalDrop: primary.verticalDrop,
      trackLength,
      crownAspect: primary.crownAspect,
      betaAspect: primary.betaAspect,
      runoutAspect: primary.runoutAspect,
      bearingChange: primary.bearingChange,
      // Multi-path ensemble data
      allPaths,
      pathCount: allPaths.length,
      runoutRange: { min: minRunout, median: medianRunout, max: maxRunout },
    },
  };
}
