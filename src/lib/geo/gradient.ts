import type { Map as MaplibreMap } from "maplibre-gl";
import { queryElevation } from "./elevation";
import { offsetPoint } from "./fast-offset";

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
 * Compute the local terrain gradient using the full Horn (1981) 3×3 method.
 *
 * Samples all 8 neighbors plus center in a 3×3 grid. Cardinal neighbors
 * are weighted 2×, diagonals 1×. This captures oblique terrain features
 * (diagonal ridgelines, angled gullies) that the 4-cardinal method misses.
 *
 * Horn, B.K.P. (1981). "Hill shading and the reflectance map."
 *
 * dz/dx = ((z_ne + 2*z_e + z_se) - (z_nw + 2*z_w + z_sw)) / (8 * cellsize)
 * dz/dy = ((z_nw + 2*z_n + z_ne) - (z_sw + 2*z_s + z_se)) / (8 * cellsize)
 *
 * @param sampleRadiusM Distance in meters for the offset samples (default 30m).
 *   Larger values smooth DEM noise; smaller values capture local detail.
 */
export function computeLocalGradient(
  map: MaplibreMap,
  lngLat: [number, number],
  sampleRadiusM: number = 30
): TerrainGradient | null {
  // Sample 8 neighbors: N, NE, E, SE, S, SW, W, NW
  // Using fast flat-Earth offset (~5× faster than turf.destination)
  const n  = offsetPoint(lngLat, sampleRadiusM, 0);
  const ne = offsetPoint(lngLat, sampleRadiusM, 45);
  const e  = offsetPoint(lngLat, sampleRadiusM, 90);
  const se = offsetPoint(lngLat, sampleRadiusM, 135);
  const s  = offsetPoint(lngLat, sampleRadiusM, 180);
  const sw = offsetPoint(lngLat, sampleRadiusM, 225);
  const w  = offsetPoint(lngLat, sampleRadiusM, 270);
  const nw = offsetPoint(lngLat, sampleRadiusM, 315);

  const zN  = queryElevation(map, n);
  const zNE = queryElevation(map, ne);
  const zE  = queryElevation(map, e);
  const zSE = queryElevation(map, se);
  const zS  = queryElevation(map, s);
  const zSW = queryElevation(map, sw);
  const zW  = queryElevation(map, w);
  const zNW = queryElevation(map, nw);

  // Need at least the 4 cardinal samples; diagonals provide refinement
  if (zN === null || zE === null || zS === null || zW === null) return null;

  // Fall back to 4-cardinal if any diagonal is missing
  if (zNE === null || zSE === null || zSW === null || zNW === null) {
    const diameter = 2 * sampleRadiusM;
    const dzdx = (zE - zW) / diameter;
    const dzdy = (zN - zS) / diameter;
    const mag = Math.sqrt(dzdx * dzdx + dzdy * dzdy);
    const slopeDeg = (Math.atan(mag) * 180) / Math.PI;
    let aspectDeg = (Math.atan2(-dzdx, -dzdy) * 180) / Math.PI;
    if (aspectDeg < 0) aspectDeg += 360;
    return { slopeDeg, aspectDeg, dzdx, dzdy };
  }

  // Full Horn (1981) formula
  const cellsize = sampleRadiusM; // distance from center to neighbor
  const dzdx = ((zNE + 2 * zE + zSE) - (zNW + 2 * zW + zSW)) / (8 * cellsize);
  const dzdy = ((zNW + 2 * zN + zNE) - (zSW + 2 * zS + zSE)) / (8 * cellsize);

  const gradientMagnitude = Math.sqrt(dzdx * dzdx + dzdy * dzdy);
  const slopeDeg = (Math.atan(gradientMagnitude) * 180) / Math.PI;

  // Aspect = direction of steepest descent (opposite of gradient vector)
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
