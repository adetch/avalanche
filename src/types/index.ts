import type { Polygon } from "geojson";

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

export interface AvalancheResult {
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
}

export interface DrawingVertex {
  lngLat: [number, number];
  pixel?: [number, number];
}
