import type { Map as MaplibreMap } from "maplibre-gl";
import type { Polygon } from "geojson";
import * as turf from "@turf/turf";
import type { AvalancheResult, ElevationPoint } from "@/types";
import { findHighestPoint } from "@/lib/geo/elevation";
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

/**
 * Run the full avalanche path computation pipeline.
 */
export function computeAvalanchePath(
  map: MaplibreMap,
  startingZone: Polygon,
  slopeAngle: number,
  snowDepthCm: number
): AvalancheResult | null {
  // 1. Get polygon coordinates and find crown (highest) point
  const coords = startingZone.coordinates[0].map(
    (c) => [c[0], c[1]] as [number, number]
  );
  const crown = findHighestPoint(map, coords);
  if (!crown) return null;

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
  if (profile.length < 5) return null;

  const crownPoint: ElevationPoint = {
    lngLat: crown.lngLat,
    elevation: crown.elevation,
    distanceFromCrown: 0,
  };

  // 4. Find beta point
  const betaPoint = findBetaPoint(profile);
  if (!betaPoint) return null;

  // 5. Compute alpha angle and runout
  const betaAngle = computeBetaAngle(crownPoint, betaPoint);
  const alphaAngle = computeAlphaAngle(betaAngle);
  const runoutPoint = findRunoutPoint(profile, crownPoint, alphaAngle);
  if (!runoutPoint) return null;

  // 6. Generate zone geometries
  const zoneWidth = estimateStartingZoneWidth(startingZone);
  const betaIdx = findProfileIndex(profile, betaPoint);
  const runoutIdx = findProfileIndex(profile, runoutPoint);

  // Track: from a few points into the profile to the beta point
  const trackStart = Math.min(5, betaIdx);
  const trackZone = generateTrackZone(profile, trackStart, betaIdx, zoneWidth);
  const runoutZone = generateRunoutZone(
    profile,
    betaIdx,
    runoutIdx,
    zoneWidth
  );

  // If zone generation failed, still return with the starting zone
  const trackPoly = trackZone ?? startingZone;
  const runoutPoly = runoutZone ?? startingZone;

  // 7. Compute volume and destructive size
  const areaSqMeters = turf.area(startingZone);
  const volume = computeVolume(areaSqMeters, snowDepthCm);
  const destructiveSize = classifyDestructiveSize(volume);

  // 8. Distances
  const horizontalRunout = runoutPoint.distanceFromCrown;
  const verticalDrop = crownPoint.elevation - runoutPoint.elevation;
  const trackLength = Math.sqrt(
    horizontalRunout * horizontalRunout + verticalDrop * verticalDrop
  );

  return {
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
  };
}
