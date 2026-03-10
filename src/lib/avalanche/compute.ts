import type { Map as MaplibreMap } from "maplibre-gl";
import type { Polygon } from "geojson";
import * as turf from "@turf/turf";
import type {
  AvalancheResult,
  AvalanchePath,
  ElevationPoint,
  PathResult,
  SnowProfile,
  RegionCoefficients,
} from "@/types";
import { findHighestPoint, clearElevationCache, getElevationCacheStats } from "@/lib/geo/elevation";
import { computeAverageSlope } from "@/lib/geo/slope";
import { computeLocalGradient } from "@/lib/geo/gradient";
import { extractGradientProfile } from "./profile";
import {
  findBetaPoint,
  computeBetaAngle,
  computeAlphaAngle,
  computeAlphaConfidence,
  findRunoutPoint,
  fitQuadraticProfile,
  DEFAULT_REGION,
} from "./alpha-beta";
import { computeVolume } from "./volume";
import { classifyDestructiveSize } from "./destructive-size";
import {
  generateZones,
  findProfileIndex,
} from "./zones";
import { sampleReleasePoints } from "./release-points";
import type { ReleasePoint } from "./release-points";
import { DEFAULT_SNOW_PROFILE } from "./snow-profiles";
import { estimatePathConfinement } from "./confinement";
import { runVoellmy1D } from "./voellmy";

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
  releasePoint: ReleasePoint,
  region: RegionCoefficients = DEFAULT_REGION
): PathResult | null {
  const { lngLat, elevation, aspectDeg: initialBearing } = releasePoint;

  // Extract elevation profile by following steepest descent
  const profile = extractGradientProfile(map, lngLat, initialBearing, 5000, 10);
  if (profile.length < 5) {
    console.log(`[avalanche] path failed: profile too short (${profile.length} pts) at [${lngLat}] elev=${elevation.toFixed(0)}m`);
    return null;
  }

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
  if (!betaPoint) {
    console.log(`[avalanche] path failed: no beta point at [${lngLat}] elev=${elevation.toFixed(0)}m profileLen=${profile.length}`);
    return null;
  }

  // Compute alpha angle and runout using regional coefficients
  const betaAngle = computeBetaAngle(crownPoint, betaPoint);
  const alphaAngle = computeAlphaAngle(betaAngle, region);
  const alphaConfidence = computeAlphaConfidence(betaAngle, region);
  const runoutPoint = findRunoutPoint(profile, crownPoint, alphaAngle, betaPoint);
  if (!runoutPoint) {
    console.log(`[avalanche] path failed: no runout point at [${lngLat}] beta=${betaAngle.toFixed(1)}° alpha=${alphaAngle.toFixed(1)}°`);
    return null;
  }

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

  // Quadratic profile fit for extended alpha-beta diagnostics
  const quadFit = fitQuadraticProfile(profile);

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
    profileCurvature: quadFit?.zpp ?? null,
    profileH0: quadFit?.H0 ?? null,
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
  snowDepthCm: number,
  snowProfile: SnowProfile = DEFAULT_SNOW_PROFILE,
  region: RegionCoefficients = DEFAULT_REGION
): ComputeResult {
  const t0 = performance.now();
  clearElevationCache();

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
  let failCount = 0;
  for (const rp of releasePoints) {
    const path = computeSinglePath(map, rp, region);
    if (path) {
      allPaths.push(path);
    } else {
      failCount++;
    }
  }
  console.log(
    `[avalanche] release points: ${releasePoints.length}, paths ok: ${allPaths.length}, failed: ${failCount}`
  );
  if (allPaths.length > 0) {
    allPaths.forEach((p, i) =>
      console.log(
        `[avalanche]   path[${i}]: runout=${p.horizontalRunout.toFixed(0)}m drop=${p.verticalDrop.toFixed(0)}m bearing=${p.fallLineAzimuth.toFixed(0)}°`
      )
    );
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

  const t1 = performance.now();

  // 3. Select primary path: longest runout (conservative)
  allPaths.sort((a, b) => b.horizontalRunout - a.horizontalRunout);
  const primary = allPaths[0];

  // 4. Detect path confinement (affects zone widths)
  const confinement = estimatePathConfinement(
    map,
    primary.profile,
    primary.betaPoint.distanceFromCrown
  );
  console.log(
    `[avalanche] confinement: ${confinement.classification} (×${confinement.bufferMultiplier.toFixed(1)}) L=${confinement.leftRise.toFixed(0)}m R=${confinement.rightRise.toFixed(0)}m`
  );

  // 5. Generate zone geometries from the path ensemble (using confinement)
  const { trackZone, runoutZone } = generateZones(
    allPaths,
    primary,
    confinement.bufferMultiplier
  );
  const t2 = performance.now();
  const cacheStats = getElevationCacheStats();
  console.log(
    `[avalanche] timing: paths=${(t1 - t0).toFixed(0)}ms zones=${(t2 - t1).toFixed(0)}ms total=${(t2 - t0).toFixed(0)}ms`
  );
  console.log(
    `[avalanche] elevation cache: ${cacheStats.size} entries, ${cacheStats.hits} hits, ${cacheStats.misses} misses (${cacheStats.hits + cacheStats.misses > 0 ? ((cacheStats.hits / (cacheStats.hits + cacheStats.misses)) * 100).toFixed(0) : 0}% hit rate)`
  );
  const trackPoly = trackZone ?? startingZone;
  const runoutPoly = runoutZone ?? startingZone;

  // 6. Compute volume, mass, and destructive size
  const areaSqMeters = turf.area(startingZone);
  const slopeRad = (primary.slopeAngle * Math.PI) / 180;
  const slopeAreaFactor = 1 / Math.cos(slopeRad);
  const effectiveArea = areaSqMeters * slopeAreaFactor;
  const volume = computeVolume(effectiveArea, snowDepthCm, snowProfile.entrainmentFactor);
  const massTonnes = (volume * snowProfile.density) / 1000; // kg → tonnes
  const destructiveSize = classifyDestructiveSize(massTonnes);

  // 7. Voellmy dynamic model
  const snowDepthM = snowDepthCm / 100;
  const voellmyResult = runVoellmy1D(
    primary.profile,
    snowProfile,
    snowDepthM
  );
  console.log(
    `[avalanche] voellmy: vMax=${voellmyResult.maxVelocity.toFixed(1)}m/s pMax=${voellmyResult.maxPressure.toFixed(0)}kPa dynRunout=${voellmyResult.dynamicRunout.toFixed(0)}m`
  );

  // 8. Track length
  const trackLength = Math.sqrt(
    primary.horizontalRunout * primary.horizontalRunout +
      primary.verticalDrop * primary.verticalDrop
  );

  // 9. Runout range across all paths
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
      mass: massTonnes,
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
      confinement: confinement.classification,
      voellmy: voellmyResult.maxVelocity > 0
        ? {
            maxVelocity: voellmyResult.maxVelocity,
            maxPressure: voellmyResult.maxPressure,
            dynamicRunout: voellmyResult.dynamicRunout,
          }
        : null,
    },
  };
}
