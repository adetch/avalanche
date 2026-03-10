import type { Map as MaplibreMap } from "maplibre-gl";
import type { Polygon } from "geojson";
import * as turf from "@turf/turf";
import type { AvalancheResult, ElevationPoint } from "@/types";
import { findHighestPoint } from "@/lib/geo/elevation";
import { computeAverageSlope } from "@/lib/geo/slope";
import { computeLocalGradient, bearingToCardinal } from "@/lib/geo/gradient";
import { computeFallLineDirection } from "./fall-line";
import { extractGradientProfile } from "./profile";
import {
  findBetaPoint,
  computeBetaAngle,
  computeAlphaAngle,
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
 * Get the aspect (facing direction) at a profile point by looking at
 * the bearing to the next point. Falls back to gradient computation.
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
 * Run the full avalanche path computation pipeline.
 *
 * Uses gradient-following to trace the path along the steepest descent
 * from the crown point, naturally following terrain curvature.
 */
export function computeAvalanchePath(
  map: MaplibreMap,
  startingZone: Polygon,
  _slopeAngle: number,
  snowDepthCm: number
): ComputeResult {
  // 1. Get polygon coordinates and find crown (highest) point
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

  // 2. Compute initial fall-line direction at the crown using gradient
  const crownGradient = computeFallLineDirection(map, crown.lngLat);
  if (!crownGradient) {
    return {
      ok: false,
      failure: {
        reason:
          "Could not compute terrain gradient at crown point. Elevation data may be unavailable.",
        step: "fall_line",
        details: { crownLngLat: crown.lngLat, crownElev: crown.elevation },
      },
    };
  }

  const initialBearing = crownGradient.aspectDeg;

  // 3. Extract elevation profile by following the steepest descent
  const profile = extractGradientProfile(
    map,
    crown.lngLat,
    initialBearing,
    3000,
    10
  );
  if (profile.length < 5) {
    return {
      ok: false,
      failure: {
        reason: `Elevation profile too short (${profile.length} points). Terrain may be flat or elevation data unavailable.`,
        step: "extract_profile",
        details: {
          profileLength: profile.length,
          crownElev: crown.elevation,
          initialBearing,
        },
      },
    };
  }

  const crownPoint: ElevationPoint = {
    lngLat: crown.lngLat,
    elevation: crown.elevation,
    distanceFromCrown: 0,
  };

  // 4. Compute slope angle from the starting zone (first ~100m of profile)
  const slopeProfileEnd = Math.min(10, Math.floor(profile.length / 3));
  const slopeProfile = profile.slice(0, Math.max(2, slopeProfileEnd));
  const computedSlopeAngle = Math.max(computeAverageSlope(slopeProfile), 0);

  // 5. Find beta point
  const betaPoint = findBetaPoint(profile);
  if (!betaPoint) {
    return {
      ok: false,
      failure: {
        reason: `No beta point found — slope never drops below 10° for 3 consecutive samples. Terrain may be uniformly steep or profile too short.`,
        step: "find_beta",
        details: {
          profileLength: profile.length,
          profileDistM: profile[profile.length - 1].distanceFromCrown,
          crownElev: crown.elevation,
          endElev: profile[profile.length - 1].elevation,
          computedSlope: computedSlopeAngle,
        },
      },
    };
  }

  // 6. Compute alpha angle and runout
  const betaAngle = computeBetaAngle(crownPoint, betaPoint);
  const alphaAngle = computeAlphaAngle(betaAngle);
  const runoutPoint = findRunoutPoint(
    profile,
    crownPoint,
    alphaAngle,
    betaPoint
  );
  if (!runoutPoint) {
    return {
      ok: false,
      failure: {
        reason: `No runout point found — alpha line (${alphaAngle.toFixed(1)}°) never intersects terrain past beta point.`,
        step: "find_runout",
        details: {
          betaAngle,
          alphaAngle,
          betaDist: betaPoint.distanceFromCrown,
          betaElev: betaPoint.elevation,
          crownElev: crown.elevation,
          computedSlope: computedSlopeAngle,
        },
      },
    };
  }

  // 7. Generate zone geometries
  const zoneWidth = estimateStartingZoneWidth(startingZone);
  const betaIdx = findProfileIndex(profile, betaPoint);
  const runoutIdx = findProfileIndex(profile, runoutPoint);

  const trackStart = Math.min(5, betaIdx);
  const trackZone = generateTrackZone(profile, trackStart, betaIdx, zoneWidth);
  const runoutZone = generateRunoutZone(
    profile,
    betaIdx,
    runoutIdx,
    zoneWidth
  );

  const trackPoly = trackZone ?? startingZone;
  const runoutPoly = runoutZone ?? startingZone;

  // 8. Compute volume and destructive size
  const areaSqMeters = turf.area(startingZone);
  const slopeRad = (computedSlopeAngle * Math.PI) / 180;
  const slopeAreaFactor = 1 / Math.cos(slopeRad);
  const effectiveArea = areaSqMeters * slopeAreaFactor;
  const volume = computeVolume(effectiveArea, snowDepthCm);
  const destructiveSize = classifyDestructiveSize(volume);

  // 9. Distances
  const horizontalRunout = runoutPoint.distanceFromCrown;
  const verticalDrop = crownPoint.elevation - runoutPoint.elevation;
  const trackLength = Math.sqrt(
    horizontalRunout * horizontalRunout + verticalDrop * verticalDrop
  );

  // 10. Compute aspect at key points along the path
  const crownAspect = initialBearing;
  const betaProfileIdx = findProfileIndex(profile, betaPoint);
  const runoutProfileIdx = findProfileIndex(profile, runoutPoint);
  const betaAspect = aspectAtProfilePoint(profile, betaProfileIdx);
  const runoutAspect = aspectAtProfilePoint(profile, runoutProfileIdx);

  // Bearing change: total direction change from crown to runout
  let bearingChange = Math.abs(runoutAspect - crownAspect);
  if (bearingChange > 180) bearingChange = 360 - bearingChange;

  return {
    ok: true,
    result: {
      computedSlopeAngle,
      path: {
        crownPoint,
        betaPoint,
        runoutPoint,
        fallLineAzimuth: initialBearing,
        betaAngle,
        alphaAngle,
        profile,
        startingZone,
        trackZone: trackPoly,
        runoutZone: runoutPoly,
      },
      volume,
      destructiveSize,
      horizontalRunout,
      verticalDrop,
      trackLength,
      crownAspect,
      betaAspect,
      runoutAspect,
      bearingChange,
    },
  };
}
