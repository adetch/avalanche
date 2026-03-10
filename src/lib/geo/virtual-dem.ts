import type { Map as MaplibreMap } from "maplibre-gl";
import type { Polygon } from "geojson";
import * as turf from "@turf/turf";
import { queryElevation } from "./elevation";
import { offsetPoint } from "./fast-offset";

/**
 * In-memory regular elevation grid sampled from MapLibre terrain tiles.
 * Row 0 = south, row N = north. Col 0 = west, col N = east.
 */
export interface VirtualDEM {
  origin: [number, number]; // SW corner [lng, lat]
  cellSize: number;         // meters
  cols: number;
  rows: number;
  elevation: Float32Array;  // row-major: elevation[row * cols + col]
  /** Precomputed per-degree conversion factors at grid center latitude */
  mPerDegLat: number;
  mPerDegLng: number;
}

const DEG_TO_RAD = Math.PI / 180;
const EARTH_RADIUS_M = 6371000;

/**
 * Build a virtual DEM grid covering the release polygon and extending downslope.
 *
 * @param map - MapLibre map for elevation queries
 * @param polygon - Release zone polygon
 * @param downslopeBearing - Direction to extend the grid (degrees, 0=N)
 * @param downslopeExtentM - How far to extend downslope (meters)
 * @param cellSizeM - Grid cell size (meters), default 15
 * @param lateralPadM - Lateral padding on each side (meters), default 500
 */
export function buildVirtualDEM(
  map: MaplibreMap,
  polygon: Polygon,
  downslopeBearing: number,
  downslopeExtentM: number = 3000,
  cellSizeM: number = 15,
  lateralPadM: number = 500
): VirtualDEM | null {
  // Get polygon bounding box
  const bbox = turf.bbox(polygon);
  const sw: [number, number] = [bbox[0], bbox[1]];
  const ne: [number, number] = [bbox[2], bbox[3]];

  // Polygon centroid for extending downslope
  const centroid = turf.centroid(polygon).geometry.coordinates as [number, number];

  // Extend bounding box downslope
  const farPoint = offsetPoint(centroid, downslopeExtentM, downslopeBearing);

  // Extend bounding box laterally (perpendicular to downslope direction)
  const leftBearing = (downslopeBearing - 90 + 360) % 360;
  const rightBearing = (downslopeBearing + 90) % 360;
  const leftPoint = offsetPoint(centroid, lateralPadM, leftBearing);
  const rightPoint = offsetPoint(centroid, lateralPadM, rightBearing);
  const farLeft = offsetPoint(farPoint, lateralPadM, leftBearing);
  const farRight = offsetPoint(farPoint, lateralPadM, rightBearing);

  // Compute encompassing bounding box
  const allLngs = [sw[0], ne[0], farPoint[0], leftPoint[0], rightPoint[0], farLeft[0], farRight[0]];
  const allLats = [sw[1], ne[1], farPoint[1], leftPoint[1], rightPoint[1], farLeft[1], farRight[1]];
  const minLng = Math.min(...allLngs);
  const maxLng = Math.max(...allLngs);
  const minLat = Math.min(...allLats);
  const maxLat = Math.max(...allLats);

  // Compute grid dimensions
  const centerLat = (minLat + maxLat) / 2;
  const mPerDegLat = EARTH_RADIUS_M * DEG_TO_RAD;
  const mPerDegLng = EARTH_RADIUS_M * DEG_TO_RAD * Math.cos(centerLat * DEG_TO_RAD);

  const widthM = (maxLng - minLng) * mPerDegLng;
  const heightM = (maxLat - minLat) * mPerDegLat;

  const cols = Math.ceil(widthM / cellSizeM) + 1;
  const rows = Math.ceil(heightM / cellSizeM) + 1;

  // Safety: cap grid size at 300x300 = 90,000 cells
  if (cols * rows > 90000) {
    console.warn(`[virtual-dem] Grid too large: ${cols}x${rows} = ${cols * rows} cells, skipping`);
    return null;
  }

  const origin: [number, number] = [minLng, minLat];
  const dLng = cellSizeM / mPerDegLng;
  const dLat = cellSizeM / mPerDegLat;

  // Sample elevations
  const elevation = new Float32Array(rows * cols);
  let nullCount = 0;

  for (let r = 0; r < rows; r++) {
    const lat = origin[1] + r * dLat;
    for (let c = 0; c < cols; c++) {
      const lng = origin[0] + c * dLng;
      const elev = queryElevation(map, [lng, lat]);
      if (elev === null) {
        elevation[r * cols + c] = NaN;
        nullCount++;
      } else {
        elevation[r * cols + c] = elev;
      }
    }
  }

  if (nullCount > rows * cols * 0.5) {
    console.warn(`[virtual-dem] Too many null elevations: ${nullCount}/${rows * cols}`);
    return null;
  }

  console.log(
    `[virtual-dem] Built ${cols}x${rows} grid (${cols * rows} cells, ${cellSizeM}m resolution, ${nullCount} nulls)`
  );

  return { origin, cellSize: cellSizeM, cols, rows, elevation, mPerDegLat, mPerDegLng };
}

/** Convert grid cell [row, col] to geographic [lng, lat] */
export function gridToLngLat(dem: VirtualDEM, row: number, col: number): [number, number] {
  const dLng = dem.cellSize / dem.mPerDegLng;
  const dLat = dem.cellSize / dem.mPerDegLat;
  return [
    dem.origin[0] + col * dLng,
    dem.origin[1] + row * dLat,
  ];
}

/** Convert geographic [lng, lat] to nearest grid cell [row, col] */
export function lngLatToGrid(dem: VirtualDEM, lngLat: [number, number]): [number, number] {
  const dLng = dem.cellSize / dem.mPerDegLng;
  const dLat = dem.cellSize / dem.mPerDegLat;
  const col = Math.round((lngLat[0] - dem.origin[0]) / dLng);
  const row = Math.round((lngLat[1] - dem.origin[1]) / dLat);
  return [row, col];
}

/** Get elevation at a grid cell, NaN for out of bounds */
export function getElevation(dem: VirtualDEM, row: number, col: number): number {
  if (row < 0 || row >= dem.rows || col < 0 || col >= dem.cols) return NaN;
  return dem.elevation[row * dem.cols + col];
}

/**
 * Identify grid cells that fall inside a polygon.
 * Returns array of [row, col] pairs.
 */
export function identifyReleaseCells(
  dem: VirtualDEM,
  polygon: Polygon
): [number, number][] {
  const cells: [number, number][] = [];
  const bbox = turf.bbox(polygon);
  const dLng = dem.cellSize / dem.mPerDegLng;
  const dLat = dem.cellSize / dem.mPerDegLat;

  // Only test cells within the polygon's bounding box
  const minCol = Math.max(0, Math.floor((bbox[0] - dem.origin[0]) / dLng));
  const maxCol = Math.min(dem.cols - 1, Math.ceil((bbox[2] - dem.origin[0]) / dLng));
  const minRow = Math.max(0, Math.floor((bbox[1] - dem.origin[1]) / dLat));
  const maxRow = Math.min(dem.rows - 1, Math.ceil((bbox[3] - dem.origin[1]) / dLat));

  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      const elev = getElevation(dem, r, c);
      if (isNaN(elev)) continue;
      const pt = gridToLngLat(dem, r, c);
      if (turf.booleanPointInPolygon(turf.point(pt), polygon)) {
        cells.push([r, c]);
      }
    }
  }

  return cells;
}
