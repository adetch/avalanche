import type { Polygon, Position } from "geojson";

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
  volume: number;
  destructiveSize: 1 | 2 | 3 | 4 | 5;
  horizontalRunout: number;
  verticalDrop: number;
  trackLength: number;
}

export interface DrawingVertex {
  lngLat: [number, number];
  pixel?: [number, number];
}
