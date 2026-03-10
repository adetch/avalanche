import type { Map as MaplibreMap } from "maplibre-gl";
import type { Polygon } from "geojson";
import * as turf from "@turf/turf";
import { queryElevation } from "@/lib/geo/elevation";
import { computeLocalGradient } from "@/lib/geo/gradient";

export interface ReleasePoint {
  lngLat: [number, number];
  elevation: number;
  slopeDeg: number;
  aspectDeg: number;
}

/**
 * Sample release points within a starting zone polygon.
 *
 * Strategy:
 * 1. Generate a grid of candidate points inside the polygon
 * 2. Query elevation and gradient at each
 * 3. Filter to points with plausible avalanche slopes (>25°)
 * 4. Sort by elevation (highest first) — higher points produce longer runout
 * 5. Return up to maxPoints, ensuring spatial diversity
 *
 * The highest point is always included as the primary (conservative) release point.
 */
export function sampleReleasePoints(
  map: MaplibreMap,
  polygon: Polygon,
  maxPoints: number = 7
): ReleasePoint[] {
  const bbox = turf.bbox(polygon);
  const bboxWidth = turf.distance([bbox[0], bbox[1]], [bbox[2], bbox[1]], {
    units: "meters",
  });
  const bboxHeight = turf.distance([bbox[0], bbox[1]], [bbox[0], bbox[3]], {
    units: "meters",
  });

  // Grid spacing: aim for ~20m, but adapt to polygon size
  const spacing = Math.max(15, Math.min(30, Math.min(bboxWidth, bboxHeight) / 5));
  const spacingKm = spacing / 1000;

  // Generate candidate points inside the polygon
  const grid = turf.pointGrid(bbox, spacingKm, {
    units: "kilometers",
    mask: turf.feature(polygon),
  });

  // Also include polygon vertices as candidates
  const vertexCoords = polygon.coordinates[0].map(
    (c) => [c[0], c[1]] as [number, number]
  );

  const candidates: ReleasePoint[] = [];

  // Process grid points
  for (const pt of grid.features) {
    const lngLat = pt.geometry.coordinates as [number, number];
    const elev = queryElevation(map, lngLat);
    if (elev === null) continue;

    const gradient = computeLocalGradient(map, lngLat, 30);
    if (!gradient) continue;

    candidates.push({
      lngLat,
      elevation: elev,
      slopeDeg: gradient.slopeDeg,
      aspectDeg: gradient.aspectDeg,
    });
  }

  // Process vertices
  for (const lngLat of vertexCoords) {
    const elev = queryElevation(map, lngLat);
    if (elev === null) continue;

    const gradient = computeLocalGradient(map, lngLat, 30);
    if (!gradient) continue;

    candidates.push({
      lngLat,
      elevation: elev,
      slopeDeg: gradient.slopeDeg,
      aspectDeg: gradient.aspectDeg,
    });
  }

  if (candidates.length === 0) return [];

  // Sort by elevation descending — highest points first (conservative for alpha-beta)
  candidates.sort((a, b) => b.elevation - a.elevation);

  // Always include the highest point
  const selected: ReleasePoint[] = [candidates[0]];

  // Select remaining points ensuring spatial diversity
  const minSeparationM = spacing * 0.8;
  for (const candidate of candidates.slice(1)) {
    if (selected.length >= maxPoints) break;

    // Skip points too close to already-selected ones
    const tooClose = selected.some((s) => {
      const dist = turf.distance(s.lngLat, candidate.lngLat, {
        units: "meters",
      });
      return dist < minSeparationM;
    });
    if (tooClose) continue;

    selected.push(candidate);
  }

  return selected;
}
