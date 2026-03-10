import * as turf from "@turf/turf";
import type { Polygon, MultiPolygon, Feature } from "geojson";
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
 * Extract the largest Polygon from a geometry that may be Polygon or MultiPolygon.
 */
function extractLargestPolygon(
  geom: Polygon | MultiPolygon
): Polygon | null {
  if (geom.type === "Polygon") return geom;
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

/**
 * Buffer a path segment (slice of profile points) into a polygon.
 */
function bufferPathSegment(
  profile: ElevationPoint[],
  startIdx: number,
  endIdx: number,
  bufferM: number
): Feature<Polygon | MultiPolygon> | null {
  const slice = profile.slice(startIdx, endIdx + 1);
  if (slice.length < 2) return null;

  const coords = slice.map((p) => p.lngLat);
  const line = turf.lineString(coords);
  return turf.buffer(line, bufferM / 1000, {
    units: "kilometers",
    steps: 8,
  }) ?? null;
}

/**
 * Build a zone polygon by buffering each path individually then unioning.
 *
 * This avoids the convex-hull problem where paths on different sides of a
 * ridge create a zone that bridges across terrain the avalanche would never
 * cross.  Each path gets its own buffer that hugs its fall line; the union
 * merges paths that overlap (same gully) while keeping separate paths that
 * diverge onto different aspects.
 */
function buildUnionedZone(
  allPaths: PathResult[],
  minDist: number,
  maxDist: number,
  bufferM: number
): Polygon | null {
  const buffered: Feature<Polygon | MultiPolygon>[] = [];

  for (const path of allPaths) {
    // Find profile indices within the distance range
    let startIdx = -1;
    let endIdx = -1;
    for (let i = 0; i < path.profile.length; i++) {
      const d = path.profile[i].distanceFromCrown;
      if (d >= minDist && startIdx === -1) startIdx = i;
      if (d <= maxDist) endIdx = i;
    }
    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) continue;

    const buf = bufferPathSegment(path.profile, startIdx, endIdx, bufferM);
    if (buf) buffered.push(buf);
  }

  if (buffered.length === 0) return null;
  if (buffered.length === 1) {
    return extractLargestPolygon(buffered[0].geometry);
  }

  // Union all individual buffers
  let merged = buffered[0];
  for (let i = 1; i < buffered.length; i++) {
    try {
      const u = turf.union(
        turf.featureCollection([merged as Feature<Polygon | MultiPolygon>, buffered[i] as Feature<Polygon | MultiPolygon>])
      );
      if (u) merged = u as Feature<Polygon | MultiPolygon>;
    } catch {
      // Union can fail on degenerate geometries — skip this path
    }
  }

  return extractLargestPolygon(merged.geometry);
}

/**
 * Filter paths to those whose initial bearing is within maxDeviation degrees
 * of the primary path. Prevents wildly divergent paths from inflating zones.
 */
function filterCoherentPaths(
  allPaths: PathResult[],
  primary: PathResult,
  maxDeviation: number = 45
): PathResult[] {
  const primaryBearing = primary.fallLineAzimuth;
  return allPaths.filter((p) => {
    let diff = Math.abs(p.fallLineAzimuth - primaryBearing);
    if (diff > 180) diff = 360 - diff;
    return diff <= maxDeviation;
  });
}

/**
 * Generate track and runout zone polygons from the path ensemble.
 *
 * Each path is individually buffered then unioned together.  Paths on
 * the same aspect merge into one zone; paths on different aspects stay
 * separate (no bridging across ridges).  Paths diverging >45° from the
 * primary are excluded from zone generation to prevent unnatural bulging.
 *
 * @param confinementMultiplier - Scales buffer width based on terrain
 *   confinement: 1.0 for channelized (gully), 1.5 partly confined, 2.0 open.
 */
export function generateZones(
  allPaths: PathResult[],
  primary: PathResult,
  confinementMultiplier: number = 1.0
): { trackZone: Polygon | null; runoutZone: Polygon | null } {
  const coherentPaths = filterCoherentPaths(allPaths, primary, 45);
  const betaDist = primary.betaPoint.distanceFromCrown;
  const runoutDist = primary.runoutPoint.distanceFromCrown;

  const trackBuffer = 30 * confinementMultiplier;
  const runoutBuffer = 50 * confinementMultiplier;
  const trackZone = buildUnionedZone(coherentPaths, 0, betaDist, trackBuffer);
  const runoutZone = buildUnionedZone(coherentPaths, betaDist, runoutDist, runoutBuffer);

  return { trackZone, runoutZone };
}
