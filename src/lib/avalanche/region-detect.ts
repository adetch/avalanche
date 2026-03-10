import type { RegionCoefficients } from "@/types";
import { REGION_COEFFICIENTS, DEFAULT_REGION } from "./alpha-beta";

/**
 * Bounding boxes [minLat, maxLat, minLng, maxLng] for each calibration region.
 * Boxes are intentionally generous — better to match a nearby calibration
 * than silently use Norwegian coefficients in Colorado.
 */
const REGION_BOUNDS: { id: string; bounds: [number, number, number, number] }[] = [
  // Norway + Scandinavia
  { id: "norway", bounds: [57, 72, 4, 32] },
  // Iceland
  { id: "iceland", bounds: [63, 67, -25, -13] },
  // Canadian Rockies + Purcells + Selkirks + Coast Range
  { id: "canadian-rockies", bounds: [48, 60, -130, -114] },
  // Colorado Rockies + Wasatch + Tetons
  { id: "colorado", bounds: [35, 45, -112, -104] },
  // Sierra Nevada + Cascades
  { id: "sierra-nevada", bounds: [35, 49, -123, -117] },
];

/**
 * Auto-detect the best-fit regional coefficients from geographic coordinates.
 * Falls back to DEFAULT_REGION (Norway) if no bounding box matches.
 */
export function detectRegion(
  lngLat: [number, number]
): RegionCoefficients {
  const [lng, lat] = lngLat;

  for (const { id, bounds } of REGION_BOUNDS) {
    const [minLat, maxLat, minLng, maxLng] = bounds;
    if (lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng) {
      const region = REGION_COEFFICIENTS.find((r) => r.id === id);
      if (region) return region;
    }
  }

  return DEFAULT_REGION;
}
