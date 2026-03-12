"use client";

import { useEffect, useRef } from "react";
import { useMap } from "react-map-gl/maplibre";
import { useAvalancheStore } from "@/store/useAvalancheStore";
import { gridToLngLat } from "@/lib/geo/virtual-dem";
import type { FlowPyGridResult } from "@/types";

const SOURCE_ID = "flowpy-heatmap";
const LAYER_ID = "flowpy-heatmap-layer";

/**
 * Color ramp for the TRACK zone (flow passes through, no deposition).
 * Subtle warm amber tint showing the avalanche path from release to deposit.
 * t: 0-1 normalized rMax (1.0 = release cell, decaying downslope).
 */
function trackToColor(t: number): [number, number, number, number] {
  if (t < 0.02) return [0, 0, 0, 0];
  // Subtle amber wash: more visible near release, fading through track
  const s = Math.min(1, t);
  return [
    lerp(240, 220, s),
    lerp(200, 160, s),
    lerp(130, 80, s),
    lerp(30, 100, s),
  ];
}

/**
 * Color ramp for the DEPOSIT zone (debris accumulates here).
 * t: 0-1 normalized deposition intensity (relative to peak).
 * Yellow (fringe) → Orange (moderate) → Red (heavy) → Dark red (core)
 */
function depositToColor(t: number): [number, number, number, number] {
  if (t < 0.03) return [0, 0, 0, 0];

  if (t < 0.2) {
    const s = (t - 0.03) / 0.17;
    return [255, lerp(235, 200, s), lerp(140, 70, s), lerp(90, 155, s)];
  }
  if (t < 0.45) {
    const s = (t - 0.2) / 0.25;
    return [lerp(255, 240, s), lerp(200, 120, s), lerp(70, 35, s), lerp(155, 185, s)];
  }
  if (t < 0.7) {
    const s = (t - 0.45) / 0.25;
    return [lerp(240, 200, s), lerp(120, 40, s), lerp(35, 20, s), lerp(185, 210, s)];
  }
  const s = Math.min(1, (t - 0.7) / 0.3);
  return [lerp(200, 150, s), lerp(40, 10, s), lerp(20, 10, s), lerp(210, 230, s)];
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * Math.min(1, Math.max(0, t)));
}

/**
 * Generate a canvas image showing the full avalanche flow and deposit.
 *
 * Two-layer visualization:
 * 1. TRACK zone (steep slopes, deposition = 0): subtle amber wash using rMax
 *    to show where the avalanche travels from release to runout
 * 2. DEPOSIT zone (gentle slopes, deposition > 0): warm yellow → red ramp
 *    showing where debris accumulates, normalized to peak deposit intensity
 *
 * This avoids the visual gap between the starting zone and deposit that occurs
 * when only showing deposition (which is physically zero on steep track slopes).
 * The track visualization uses rMax from Flow-Py, which is spatially continuous
 * from release through track to runout.
 */
function generateHeatmapCanvas(
  result: FlowPyGridResult,
  _snowDepthM: number
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = result.cols;
  canvas.height = result.rows;
  const ctx = canvas.getContext("2d")!;
  const imageData = ctx.createImageData(result.cols, result.rows);

  // Find peaks for normalization
  let maxDep = 0;
  let maxR = 0;
  for (let i = 0; i < result.deposition.length; i++) {
    if (result.deposition[i] > maxDep) maxDep = result.deposition[i];
    if (result.rMax[i] > maxR) maxR = result.rMax[i];
  }

  if (maxR <= 0 && maxDep <= 0) {
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  for (let r = 0; r < result.rows; r++) {
    for (let c = 0; c < result.cols; c++) {
      const gridIdx = r * result.cols + c;
      const canvasRow = result.rows - 1 - r; // flip: row 0 = south → bottom
      const pixelIdx = (canvasRow * result.cols + c) * 4;

      const dep = result.deposition[gridIdx];
      const rMaxVal = result.rMax[gridIdx];

      let red: number, green: number, blue: number, alpha: number;

      if (dep > 0 && maxDep > 0) {
        // DEPOSIT zone: sqrt compression so shallow deposits are visible.
        // Without sqrt, a peak of 5m makes 0.1m deposits invisible (t=0.02).
        // With sqrt: t=sqrt(0.02)=0.14 → visible in the color ramp.
        const t = Math.sqrt(dep / maxDep);
        [red, green, blue, alpha] = depositToColor(t);
      } else if (rMaxVal > 0 && maxR > 0) {
        // TRACK zone: subtle amber showing flow path
        [red, green, blue, alpha] = trackToColor(rMaxVal / maxR);
      } else {
        red = green = blue = alpha = 0;
      }

      imageData.data[pixelIdx] = red;
      imageData.data[pixelIdx + 1] = green;
      imageData.data[pixelIdx + 2] = blue;
      imageData.data[pixelIdx + 3] = alpha;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/**
 * Compute the DEM-like metadata object needed for coordinate conversion.
 */
function buildDemLike(flowPy: FlowPyGridResult) {
  const DEG_TO_RAD = Math.PI / 180;
  const EARTH_RADIUS_M = 6371000;
  const centerLat = flowPy.origin[1] + (flowPy.rows * flowPy.cellSize / 2) / (EARTH_RADIUS_M * DEG_TO_RAD);
  const mPerDegLat = EARTH_RADIUS_M * DEG_TO_RAD;
  const mPerDegLng = EARTH_RADIUS_M * DEG_TO_RAD * Math.cos(centerLat * DEG_TO_RAD);
  return {
    origin: flowPy.origin,
    cellSize: flowPy.cellSize,
    cols: flowPy.cols,
    rows: flowPy.rows,
    mPerDegLat,
    mPerDegLng,
  };
}

/**
 * Convert lng/lat to grid cell and compute estimated burial depth from deposition.
 * Returns null if outside the grid or no deposition at this cell.
 */
export function getDepthAtLngLat(
  flowPy: FlowPyGridResult,
  lng: number,
  lat: number,
  snowDepthM: number
): number | null {
  const demLike = buildDemLike(flowPy);
  const dLng = flowPy.cellSize / demLike.mPerDegLng;
  const dLat = flowPy.cellSize / demLike.mPerDegLat;
  const col = Math.round((lng - flowPy.origin[0]) / dLng);
  const row = Math.round((lat - flowPy.origin[1]) / dLat);

  if (row < 0 || row >= flowPy.rows || col < 0 || col >= flowPy.cols) return null;

  const idx = row * flowPy.cols + col;
  const dep = flowPy.deposition[idx];
  if (dep <= 0) return null;

  // voellmy-2d/openfoam store deposition in absolute meters; flow-py uses dimensionless fraction
  if (flowPy.solverInfo?.type === 'voellmy-2d' || flowPy.solverInfo?.type === 'openfoam') {
    return dep;
  }
  return snowDepthM * dep;
}

export default function FlowPyOverlay() {
  const result = useAvalancheStore((s) => s.result);
  const snowDepth = useAvalancheStore((s) => s.snowDepth);
  const { current: mapRef } = useMap();
  const addedRef = useRef(false);

  const snowDepthM = snowDepth / 100;

  // Render heatmap image layer
  useEffect(() => {
    const map = mapRef?.getMap();
    if (!map) return;

    // Cleanup previous layer/source
    if (addedRef.current) {
      try {
        if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      } catch { /* ignore */ }
      addedRef.current = false;
    }

    const flowPy = result?.flowPy;
    if (!flowPy || flowPy.cols === 0 || flowPy.rows === 0) return;

    const canvas = generateHeatmapCanvas(flowPy, snowDepthM);
    const dataUrl = canvas.toDataURL();

    const demLike = buildDemLike(flowPy);
    const sw = gridToLngLat(demLike as Parameters<typeof gridToLngLat>[0], 0, 0);
    const se = gridToLngLat(demLike as Parameters<typeof gridToLngLat>[0], 0, flowPy.cols - 1);
    const ne = gridToLngLat(demLike as Parameters<typeof gridToLngLat>[0], flowPy.rows - 1, flowPy.cols - 1);
    const nw = gridToLngLat(demLike as Parameters<typeof gridToLngLat>[0], flowPy.rows - 1, 0);

    const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [
      nw, ne, se, sw,
    ];

    try {
      map.addSource(SOURCE_ID, {
        type: "image",
        url: dataUrl,
        coordinates,
      });

      const beforeLayer = map.getLayer("key-points-circle") ? "key-points-circle" : undefined;

      map.addLayer(
        {
          id: LAYER_ID,
          type: "raster",
          source: SOURCE_ID,
          paint: {
            "raster-opacity": 0.75,
            "raster-fade-duration": 0,
          },
        },
        beforeLayer
      );

      addedRef.current = true;
    } catch (err) {
      console.warn("[flow-py overlay] Failed to add layer:", err);
    }

    return () => {
      try {
        if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      } catch { /* ignore */ }
      addedRef.current = false;
    };
  }, [result?.flowPy, snowDepthM, mapRef]);

  return null;
}
