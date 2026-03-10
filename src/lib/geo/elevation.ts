import type { Map as MaplibreMap } from "maplibre-gl";
import * as turf from "@turf/turf";
import type { ElevationPoint } from "@/types";

/**
 * Query terrain elevation at a single point.
 * Returns meters above sea level, or null if terrain isn't loaded.
 */
export function queryElevation(
  map: MaplibreMap,
  lngLat: [number, number]
): number | null {
  try {
    const elev = map.queryTerrainElevation({ lng: lngLat[0], lat: lngLat[1] });
    return elev;
  } catch {
    return null;
  }
}

/**
 * Sample elevations along a line from `start` in direction `bearing`
 * for up to `maxDistanceMeters`, every `stepMeters`.
 */
export function queryElevationsAlongLine(
  map: MaplibreMap,
  start: [number, number],
  bearing: number,
  maxDistanceMeters: number,
  stepMeters: number = 10
): ElevationPoint[] {
  const points: ElevationPoint[] = [];
  const steps = Math.floor(maxDistanceMeters / stepMeters);

  for (let i = 0; i <= steps; i++) {
    const dist = i * stepMeters;
    const dest = turf.destination(start, dist / 1000, bearing, {
      units: "kilometers",
    });
    const coord = dest.geometry.coordinates as [number, number];
    const elev = queryElevation(map, coord);

    if (elev === null) continue;

    points.push({
      lngLat: coord,
      elevation: elev,
      distanceFromCrown: dist,
    });
  }

  return points;
}

/**
 * Find the highest elevation point among a set of coordinates.
 */
export function findHighestPoint(
  map: MaplibreMap,
  coords: [number, number][]
): { lngLat: [number, number]; elevation: number } | null {
  let best: { lngLat: [number, number]; elevation: number } | null = null;

  for (const coord of coords) {
    const elev = queryElevation(map, coord);
    if (elev !== null && (best === null || elev > best.elevation)) {
      best = { lngLat: coord, elevation: elev };
    }
  }

  return best;
}
