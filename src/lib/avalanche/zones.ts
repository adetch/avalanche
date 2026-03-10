import * as turf from "@turf/turf";
import type { Polygon } from "geojson";
import type { ElevationPoint } from "@/types";
import type { PathResult } from "@/types";

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
 * Build a zone polygon from the envelope of multiple path profiles.
 *
 * The alpha-beta model is strictly 1D (fall-line runout distance only) and
 * has no lateral component.  Rather than fake 2D zones with ad-hoc cross-
 * slope heuristics, we use the multi-path ensemble to define lateral extent:
 *
 * - Collect all profile coordinates from all paths within the given
 *   distance range (crown→beta for track, beta→runout for runout).
 * - Compute the convex hull of those points.
 * - Apply a small buffer to smooth the polygon.
 *
 * Where paths converge (confined terrain), the hull is narrow.
 * Where paths diverge (open slopes), the hull is wide.
 * Lateral extent emerges naturally from the ensemble — no invented parameters.
 */
function buildEnvelopeZone(
  allPaths: PathResult[],
  minDist: number,
  maxDist: number,
  bufferM: number = 30
): Polygon | null {
  const coords: [number, number][] = [];

  for (const path of allPaths) {
    for (const pt of path.profile) {
      if (pt.distanceFromCrown >= minDist && pt.distanceFromCrown <= maxDist) {
        coords.push(pt.lngLat);
      }
    }
  }

  if (coords.length < 3) return null;

  const points = turf.featureCollection(
    coords.map((c) => turf.point(c))
  );
  const hull = turf.convex(points);
  if (!hull) return null;

  // Small buffer to smooth jagged edges from discrete sample points
  const buffered = turf.buffer(hull, bufferM / 1000, {
    units: "kilometers",
    steps: 8,
  });
  if (!buffered) return hull.geometry as Polygon;

  const geom = buffered.geometry;
  if (geom.type === "MultiPolygon") {
    // Take the largest polygon
    let largest: Polygon | null = null;
    let largestArea = 0;
    for (const polyCoords of geom.coordinates) {
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
 * Build a simple buffered zone for a single path segment.
 * Used as fallback when there's only one path in the ensemble.
 */
function buildSinglePathZone(
  profile: ElevationPoint[],
  startIdx: number,
  endIdx: number,
  bufferM: number
): Polygon | null {
  const slice = profile.slice(startIdx, endIdx + 1);
  if (slice.length < 2) return null;

  const coords = slice.map((p) => p.lngLat);
  const line = turf.lineString(coords);
  const buffered = turf.buffer(line, bufferM / 1000, {
    units: "kilometers",
    steps: 8,
  });
  if (!buffered) return null;

  const geom = buffered.geometry;
  if (geom.type === "MultiPolygon") {
    let largest: Polygon | null = null;
    let largestArea = 0;
    for (const polyCoords of geom.coordinates) {
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
 * Generate track and runout zone polygons from the path ensemble.
 *
 * With multiple paths: zones are the convex hull of all profile points
 * in the relevant distance range, giving terrain-aware lateral extent.
 *
 * With a single path: falls back to a modest buffer (~30m track, ~50m runout).
 */
export function generateZones(
  allPaths: PathResult[],
  primary: PathResult
): { trackZone: Polygon | null; runoutZone: Polygon | null } {
  const betaDist = primary.betaPoint.distanceFromCrown;
  const runoutDist = primary.runoutPoint.distanceFromCrown;

  if (allPaths.length >= 2) {
    // Multi-path: use the envelope of all paths
    const trackZone = buildEnvelopeZone(allPaths, 0, betaDist, 30);
    const runoutZone = buildEnvelopeZone(allPaths, betaDist, runoutDist, 50);
    return { trackZone, runoutZone };
  }

  // Single path: modest fixed buffer
  const betaIdx = findProfileIndex(primary.profile, primary.betaPoint);
  const runoutIdx = findProfileIndex(primary.profile, primary.runoutPoint);
  const trackStart = Math.min(5, betaIdx);

  const trackZone = buildSinglePathZone(primary.profile, trackStart, betaIdx, 30);
  const runoutZone = buildSinglePathZone(primary.profile, betaIdx, runoutIdx, 50);
  return { trackZone, runoutZone };
}
