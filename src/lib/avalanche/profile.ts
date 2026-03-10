import type { Map as MaplibreMap } from "maplibre-gl";
import { queryElevationsAlongLine } from "@/lib/geo/elevation";
import { computeSlopeAngle } from "@/lib/geo/slope";
import type { ElevationPoint } from "@/types";

/**
 * Extract an elevation profile along the fall-line from the crown point.
 * Stops when the terrain starts going uphill or reaches maxDistance.
 */
export function extractElevationProfile(
  map: MaplibreMap,
  crownPoint: [number, number],
  fallLineBearing: number,
  maxDistanceMeters: number = 3000,
  stepMeters: number = 10
): ElevationPoint[] {
  const raw = queryElevationsAlongLine(
    map,
    crownPoint,
    fallLineBearing,
    maxDistanceMeters,
    stepMeters
  );

  if (raw.length < 2) return raw;

  // Trim: stop when terrain reverses (going uphill for 3+ consecutive points)
  const filtered: ElevationPoint[] = [raw[0]];
  let uphillCount = 0;

  for (let i = 1; i < raw.length; i++) {
    const slope = computeSlopeAngle(raw[i - 1], raw[i]);
    if (slope < 0) {
      // Going uphill
      uphillCount++;
      if (uphillCount >= 3) break;
    } else {
      uphillCount = 0;
    }
    filtered.push(raw[i]);
  }

  return filtered;
}
