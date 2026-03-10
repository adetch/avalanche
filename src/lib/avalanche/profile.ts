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

  // Trim: stop when terrain reverses (going uphill for 3+ consecutive points).
  // Buffer uphill points and only include them if the terrain resumes downhill.
  const filtered: ElevationPoint[] = [raw[0]];
  const uphillBuffer: ElevationPoint[] = [];

  for (let i = 1; i < raw.length; i++) {
    const slope = computeSlopeAngle(raw[i - 1], raw[i]);
    if (slope < 0) {
      uphillBuffer.push(raw[i]);
      if (uphillBuffer.length >= 3) break;
    } else {
      // Resumed downhill — flush buffered uphill points
      if (uphillBuffer.length > 0) {
        filtered.push(...uphillBuffer);
        uphillBuffer.length = 0;
      }
      filtered.push(raw[i]);
    }
  }

  return filtered;
}
