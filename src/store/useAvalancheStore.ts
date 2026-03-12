import { create } from "zustand";
import type { Polygon } from "geojson";
import type { AvalancheResult, DrawingVertex, SnowProfile, RegionCoefficients } from "@/types";
import { DEFAULT_SNOW_PROFILE } from "@/lib/avalanche/snow-profiles";
import { DEFAULT_REGION } from "@/lib/avalanche/alpha-beta";

interface FlyToTarget {
  center: [number, number];
  zoom?: number;
}

interface AvalancheStore {
  // Inputs
  slopeAngle: number;
  snowDepth: number;
  snowProfile: SnowProfile;
  region: RegionCoefficients;
  solverMode: "internal" | "openfoam-local";
  localSolverUrl: string;
  externalSolverStatus: "idle" | "running" | "failed" | "complete";
  externalSolverError: string | null;

  // Drawing
  drawingMode: boolean;
  drawingVertices: DrawingVertex[];
  startingZonePolygon: Polygon | null;

  // Map
  mapReady: boolean;
  flyToTarget: FlyToTarget | null;

  // Results
  result: AvalancheResult | null;
  isComputing: boolean;
  error: string | null;

  // Actions
  setSlopeAngle: (angle: number) => void;
  setSnowDepth: (depth: number) => void;
  setSnowProfile: (profile: SnowProfile) => void;
  setRegion: (region: RegionCoefficients) => void;
  setSolverMode: (mode: "internal" | "openfoam-local") => void;
  setLocalSolverUrl: (url: string) => void;
  setExternalSolverStatus: (status: "idle" | "running" | "failed" | "complete") => void;
  setExternalSolverError: (error: string | null) => void;
  setMapReady: (ready: boolean) => void;
  flyTo: (target: FlyToTarget) => void;
  clearFlyTo: () => void;
  toggleDrawingMode: () => void;
  addDrawingVertex: (vertex: DrawingVertex) => void;
  finishDrawing: () => void;
  clearDrawing: () => void;
  setResult: (result: AvalancheResult | null) => void;
  setComputing: (computing: boolean) => void;
  setError: (error: string | null) => void;
}

export const useAvalancheStore = create<AvalancheStore>((set, get) => ({
  slopeAngle: 38,
  snowDepth: 100,
  snowProfile: DEFAULT_SNOW_PROFILE,
  region: DEFAULT_REGION,
  solverMode: "internal",
  localSolverUrl: "http://127.0.0.1:8090",
  externalSolverStatus: "idle",
  externalSolverError: null,

  drawingMode: false,
  drawingVertices: [],
  startingZonePolygon: null,

  mapReady: false,
  flyToTarget: null,

  result: null,
  isComputing: false,
  error: null,

  setSlopeAngle: (angle) => set({ slopeAngle: angle }),
  setSnowDepth: (depth) => set({ snowDepth: depth }),
  setSnowProfile: (profile) => set({ snowProfile: profile }),
  setRegion: (region) => set({ region }),
  setSolverMode: (mode) => set({ solverMode: mode }),
  setLocalSolverUrl: (url) => set({ localSolverUrl: url }),
  setExternalSolverStatus: (status) => set({ externalSolverStatus: status }),
  setExternalSolverError: (error) => set({ externalSolverError: error }),
  setMapReady: (ready) => set({ mapReady: ready }),

  flyTo: (target) => set({ flyToTarget: target }),
  clearFlyTo: () => set({ flyToTarget: null }),

  toggleDrawingMode: () => {
    const { drawingMode } = get();
    set({
      drawingMode: !drawingMode,
      drawingVertices: [],
    });
  },

  addDrawingVertex: (vertex) =>
    set((state) => ({
      drawingVertices: [...state.drawingVertices, vertex],
    })),

  finishDrawing: () => {
    const { drawingVertices } = get();
    if (drawingVertices.length < 3) return;

    const coords = drawingVertices.map((v) => v.lngLat);
    // Close the polygon
    coords.push(coords[0]);

    const polygon: Polygon = {
      type: "Polygon",
      coordinates: [coords],
    };

    set({
      startingZonePolygon: polygon,
      drawingMode: false,
      drawingVertices: [],
    });
  },

  clearDrawing: () =>
    set({
      startingZonePolygon: null,
      drawingVertices: [],
      result: null,
      error: null,
    }),

  setResult: (result) => set({ result }),
  setComputing: (computing) => set({ isComputing: computing }),
  setError: (error) => set({ error }),
}));
