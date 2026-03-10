import type { Map as MaplibreMap } from "maplibre-gl";
import type { Polygon } from "geojson";
import * as turf from "@turf/turf";
import type { AvalancheResult, ElevationPoint } from "@/types";
import { findHighestPoint } from "@/lib/geo/elevation";
import { computeAverageSlope } from "@/lib/geo/slope";
import { computeFallLineDirection } from "./fall-line";
import { extractElevationProfile } from "./profile";
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
 * Run the full avalanche path computation pipeline.
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

  // 2. Compute fall-line direction
  const fallLineAzimuth = computeFallLineDirection(map, crown.lngLat);

  // 3. Extract elevation profile along the fall-line
  const profile = extractElevationProfile(
    map,
    crown.lngLat,
    fallLineAzimuth,
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
          azimuth: fallLineAzimuth,
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
  const runoutPoint = findRunoutPoint(profile, crownPoint, alphaAngle, betaPoint);
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
  const slopeAreaFactor = 1 / Math.cos(slopeRad || 1);
  const effectiveArea = areaSqMeters * slopeAreaFactor;
  const volume = computeVolume(effectiveArea, snowDepthCm);
  const destructiveSize = classifyDestructiveSize(volume);

  // 9. Distances
  const horizontalRunout = runoutPoint.distanceFromCrown;
  const verticalDrop = crownPoint.elevation - runoutPoint.elevation;
  const trackLength = Math.sqrt(
    horizontalRunout * horizontalRunout + verticalDrop * verticalDrop
  );

  return {
    ok: true,
    result: {
      computedSlopeAngle,
      path: {
        crownPoint,
        betaPoint,
        runoutPoint,
        fallLineAzimuth,
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
    },
  };
}
