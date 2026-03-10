import type { Map as MaplibreMap } from "maplibre-gl";
import * as turf from "@turf/turf";
import { queryElevation } from "@/lib/geo/elevation";

/**
 * Compute the fall-line direction (azimuth of steepest descent)
 * by sampling 8 compass directions around the crown point.
 */
export function computeFallLineDirection(
  map: MaplibreMap,
  crownPoint: [number, number],
  sampleRadiusMeters: number = 50
): number {
  const crownElev = queryElevation(map, crownPoint);
  if (crownElev === null) return 180; // fallback: due south

  let steepestBearing = 180;
  let maxDrop = -Infinity;

  // Sample 16 directions for better accuracy
  for (let i = 0; i < 16; i++) {
    const bearing = i * 22.5;
    const dest = turf.destination(crownPoint, sampleRadiusMeters / 1000, bearing, {
      units: "kilometers",
    });
    const coord = dest.geometry.coordinates as [number, number];
    const elev = queryElevation(map, coord);

    if (elev === null) continue;

    const drop = crownElev - elev;
    if (drop > maxDrop) {
      maxDrop = drop;
      steepestBearing = bearing;
    }
  }

  return steepestBearing;
}
