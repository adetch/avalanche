import type { Polygon } from "geojson";
import type { AlphaConfidence } from "@/lib/avalanche/alpha-beta";

export interface ElevationPoint {
  lngLat: [number, number];
  elevation: number;
  distanceFromCrown: number;
}

export interface AvalanchePath {
  crownPoint: ElevationPoint;
  betaPoint: ElevationPoint;
  runoutPoint: ElevationPoint;
  fallLineAzimuth: number;
  betaAngle: number;
  alphaAngle: number;
  profile: ElevationPoint[];
  startingZone: Polygon;
  trackZone: Polygon;
  runoutZone: Polygon;
}

/**
 * Result from a single release-point path computation.
 * Multiple of these are computed for the multi-path ensemble.
 */
export interface PathResult {
  crownPoint: ElevationPoint;
  betaPoint: ElevationPoint;
  runoutPoint: ElevationPoint;
  profile: ElevationPoint[];
  fallLineAzimuth: number;
  betaAngle: number;
  alphaAngle: number;
  alphaConfidence: AlphaConfidence;
  slopeAngle: number;
  horizontalRunout: number;
  verticalDrop: number;
  crownAspect: number;
  betaAspect: number;
  runoutAspect: number;
  bearingChange: number;
}

export interface AvalancheResult {
  /** Primary path (longest runout — conservative) */
  path: AvalanchePath;
  computedSlopeAngle: number;
  volume: number;
  destructiveSize: 1 | 2 | 3 | 4 | 5;
  horizontalRunout: number;
  verticalDrop: number;
  trackLength: number;
  /** Aspect (compass bearing) at the crown point */
  crownAspect: number;
  /** Aspect (compass bearing) at the beta point */
  betaAspect: number;
  /** Aspect (compass bearing) at the runout point */
  runoutAspect: number;
  /** Total bearing change from crown to runout (0-180°) */
  bearingChange: number;
  /** All computed paths from different release points */
  allPaths: PathResult[];
  /** Number of successful paths computed */
  pathCount: number;
  /** Runout distance range across all paths */
  runoutRange: { min: number; median: number; max: number };
}

export interface DrawingVertex {
  lngLat: [number, number];
  pixel?: [number, number];
}
