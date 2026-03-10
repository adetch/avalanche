import type { Map as MaplibreMap } from "maplibre-gl";
import { computeLocalGradient } from "@/lib/geo/gradient";
import type { TerrainGradient } from "@/lib/geo/gradient";

/**
 * Compute the fall-line direction (azimuth of steepest descent)
 * at the crown point using the central-difference gradient method.
 *
 * Returns the gradient result including aspect (descent direction)
 * and slope magnitude. Returns null if elevation data is unavailable.
 */
export function computeFallLineDirection(
  map: MaplibreMap,
  crownPoint: [number, number],
  sampleRadiusMeters: number = 50
): TerrainGradient | null {
  return computeLocalGradient(map, crownPoint, sampleRadiusMeters);
}
