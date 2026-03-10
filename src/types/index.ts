import type { Polygon } from "geojson";
import type { AlphaConfidence } from "@/lib/avalanche/alpha-beta";

export interface ElevationPoint {
  lngLat: [number, number];
  elevation: number;
  distanceFromCrown: number;
}

/**
 * Snow type presets bundling physical parameters that affect calculations.
 * Derived from Bartelt et al. (1999), Salm et al. (1990), Sovilla et al. (2006).
 */
export interface SnowProfile {
  id: string;
  label: string;
  density: number;           // kg/m³
  entrainmentFactor: number; // multiplier on initial volume
  frictionMu: number;        // Coulomb friction (Voellmy model)
  frictionXi: number;        // turbulent friction m/s² (Voellmy model)
}

/**
 * Regional regression coefficients for the alpha-beta model.
 * α = a·β + b − k·σ where k depends on desired return period.
 */
export interface RegionCoefficients {
  id: string;
  label: string;
  a: number;   // slope coefficient
  b: number;   // intercept (degrees)
  sigma: number; // standard deviation (degrees)
  source: string;
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
  /** Profile curvature from quadratic fit (z'', rad/m). Positive=concave, negative=convex */
  profileCurvature: number | null;
  /** Vertical range of quadratic profile fit (meters) */
  profileH0: number | null;
}

export interface AvalancheResult {
  /** Primary path (longest runout — conservative) */
  path: AvalanchePath;
  computedSlopeAngle: number;
  volume: number;
  /** Estimated mass in tonnes (volume × density / 1000) */
  mass: number;
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
  /** Path confinement classification */
  confinement: "channelized" | "partly-confined" | "open";
  /** Voellmy dynamic model results (velocity, pressure, dynamic runout) */
  voellmy: {
    maxVelocity: number;
    maxPressure: number;
    dynamicRunout: number;
  } | null;
  /** Flow-Py 2D simulation result grid */
  flowPy: FlowPyGridResult | null;
}

/**
 * Result grid from the Flow-Py 2D gravitational mass-flow simulation.
 * D'Amboise et al. (2022), Holmgren (1994) MFD routing with z-delta stopping.
 */
export interface FlowPyGridResult {
  /** Grid origin (SW corner) [lng, lat] */
  origin: [number, number];
  /** Cell size in meters */
  cellSize: number;
  /** Grid dimensions */
  cols: number;
  rows: number;
  /** Maximum z-delta energy at each cell (flat row-major Float32Array) */
  zMaxDelta: Float32Array;
  /** Maximum routing flux at each cell */
  rMax: Float32Array;
  /** Count of release cells that reached each cell */
  cellCount: Uint16Array;
}

export interface DrawingVertex {
  lngLat: [number, number];
  pixel?: [number, number];
}
