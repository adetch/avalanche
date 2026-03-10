import type { Map as MaplibreMap } from "maplibre-gl";
import * as turf from "@turf/turf";
import { queryElevation } from "./elevation";

export interface TerrainGradient {
  /** Slope magnitude in degrees */
  slopeDeg: number;
  /** Steepest descent bearing in degrees (0=N, 90=E, 180=S, 270=W) */
  aspectDeg: number;
  /** Raw gradient components (m rise per m run) */
  dzdx: number;
  dzdy: number;
}

/**
 * Compute the local terrain gradient at a point using central differences.
 *
 * Samples elevation at 4 cardinal offsets (N, S, E, W) and computes
 * dz/dx and dz/dy. This is a simplified Horn (1981) method.
 *
 * @param sampleRadiusM Distance in meters for the offset samples (default 30m).
 *   Larger values smooth DEM noise; smaller values capture local detail.
 */
export function computeLocalGradient(
  map: MaplibreMap,
  lngLat: [number, number],
  sampleRadiusM: number = 30
): TerrainGradient | null {
  const radiusKm = sampleRadiusM / 1000;

  // Sample 4 cardinal directions
  const east = turf.destination(lngLat, radiusKm, 90, { units: "kilometers" })
    .geometry.coordinates as [number, number];
  const west = turf.destination(lngLat, radiusKm, 270, { units: "kilometers" })
    .geometry.coordinates as [number, number];
  const north = turf.destination(lngLat, radiusKm, 0, { units: "kilometers" })
    .geometry.coordinates as [number, number];
  const south = turf.destination(lngLat, radiusKm, 180, { units: "kilometers" })
    .geometry.coordinates as [number, number];

  const zE = queryElevation(map, east);
  const zW = queryElevation(map, west);
  const zN = queryElevation(map, north);
  const zS = queryElevation(map, south);

  if (zE === null || zW === null || zN === null || zS === null) return null;

  const diameter = 2 * sampleRadiusM;
  const dzdx = (zE - zW) / diameter; // positive = rising eastward
  const dzdy = (zN - zS) / diameter; // positive = rising northward

  const gradientMagnitude = Math.sqrt(dzdx * dzdx + dzdy * dzdy);
  const slopeDeg = (Math.atan(gradientMagnitude) * 180) / Math.PI;

  // Aspect = direction of steepest descent (opposite of gradient vector)
  // atan2(-dzdy, -dzdx) gives angle from east, CCW positive
  // Convert to compass bearing (from north, CW positive)
  let aspectDeg = (Math.atan2(-dzdx, -dzdy) * 180) / Math.PI;
  if (aspectDeg < 0) aspectDeg += 360;

  return { slopeDeg, aspectDeg, dzdx, dzdy };
}

/**
 * Blend two compass bearings using weighted circular interpolation.
 * Handles the 0°/360° wrap-around correctly.
 *
 * @param bearing1 First bearing in degrees
 * @param bearing2 Second bearing in degrees
 * @param weight1 Weight for bearing1 (0-1). bearing2 gets (1 - weight1).
 */
export function blendBearings(
  bearing1: number,
  bearing2: number,
  weight1: number
): number {
  const rad1 = (bearing1 * Math.PI) / 180;
  const rad2 = (bearing2 * Math.PI) / 180;

  const x = weight1 * Math.sin(rad1) + (1 - weight1) * Math.sin(rad2);
  const y = weight1 * Math.cos(rad1) + (1 - weight1) * Math.cos(rad2);

  let result = (Math.atan2(x, y) * 180) / Math.PI;
  if (result < 0) result += 360;
  return result;
}

/**
 * Convert a compass bearing (degrees) to a human-readable cardinal direction.
 */
export function bearingToCardinal(bearing: number): string {
  const directions = [
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
  ];
  const normalized = ((bearing % 360) + 360) % 360;
  const index = Math.round(normalized / 22.5) % 16;
  return directions[index];
}
