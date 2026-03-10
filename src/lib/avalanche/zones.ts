import * as turf from "@turf/turf";
import type { Polygon, MultiPolygon } from "geojson";
import type { ElevationPoint } from "@/types";

/**
 * Generate a zone polygon by buffering the fall-line segment
 * between two profile points with a given width.
 */
function buildZonePolygon(
  profileSlice: ElevationPoint[],
  widthMeters: number
): Polygon | null {
  if (profileSlice.length < 2) return null;

  const coords = profileSlice.map((p) => p.lngLat);
  const line = turf.lineString(coords);
  const buffered = turf.buffer(line, widthMeters / 1000, {
    units: "kilometers",
    steps: 4,
  });

  if (!buffered) return null;

  const geom = buffered.geometry;

  // turf.buffer can return MultiPolygon for complex geometries;
  // use only the largest polygon in that case
  if (geom.type === "MultiPolygon") {
    let largest: Polygon | null = null;
    let largestArea = 0;
    for (const polyCoords of (geom as MultiPolygon).coordinates) {
      const poly: Polygon = { type: "Polygon", coordinates: polyCoords };
      const a = turf.area(poly);
      if (a > largestArea) {
        largestArea = a;
        largest = poly;
      }
    }
    return largest;
  }

  return geom as Polygon;
}

/**
 * Generate the track zone polygon: from the bottom of the starting zone
 * to the beta point.
 */
export function generateTrackZone(
  profile: ElevationPoint[],
  startIndex: number,
  betaIndex: number,
  widthMeters: number
): Polygon | null {
  const slice = profile.slice(startIndex, betaIndex + 1);
  return buildZonePolygon(slice, widthMeters);
}

/**
 * Generate the runout zone polygon: from the beta point to the
 * computed runout point.
 */
export function generateRunoutZone(
  profile: ElevationPoint[],
  betaIndex: number,
  runoutIndex: number,
  widthMeters: number
): Polygon | null {
  const slice = profile.slice(betaIndex, runoutIndex + 1);
  // Runout zone widens as debris fans out
  return buildZonePolygon(slice, widthMeters * 1.5);
}

/**
 * Find the index of a point in the profile by matching distance.
 */
export function findProfileIndex(
  profile: ElevationPoint[],
  point: ElevationPoint
): number {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < profile.length; i++) {
    const diff = Math.abs(
      profile[i].distanceFromCrown - point.distanceFromCrown
    );
    if (diff < bestDist) {
      bestDist = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Estimate starting zone width from polygon.
 */
export function estimateStartingZoneWidth(
  polygon: Polygon
): number {
  const bbox = turf.bbox(polygon);
  // Rough width: distance between west and east edges at center latitude
  const west: [number, number] = [bbox[0], (bbox[1] + bbox[3]) / 2];
  const east: [number, number] = [bbox[2], (bbox[1] + bbox[3]) / 2];
  const dist = turf.distance(west, east, { units: "meters" });
  return Math.max(dist, 20); // minimum 20m
}
