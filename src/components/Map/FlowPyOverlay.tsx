"use client";

import { useEffect, useRef } from "react";
import { useMap } from "react-map-gl/maplibre";
import { useAvalancheStore } from "@/store/useAvalancheStore";
import { gridToLngLat } from "@/lib/geo/virtual-dem";
import type { FlowPyGridResult } from "@/types";

const SOURCE_ID = "flowpy-heatmap";
const LAYER_ID = "flowpy-heatmap-layer";

/**
 * Estimated burial depth thresholds (meters).
 * Based on avalanche rescue statistics:
 * - <0.5m: survivable with self-rescue
 * - 0.5–1.0m: serious, companion rescue critical
 * - 1.0–2.0m: critical burial
 * - >2.0m: very deep, low survival probability
 */
const DEPTH_THRESHOLDS = [0.1, 0.5, 1.0, 2.0]; // meters

/**
 * Color ramp by estimated burial depth (meters).
 * Returns [r, g, b, a] in 0-255 range.
 *
 * Yellow (<0.5m) → Orange (0.5–1m) → Red (1–2m) → Dark red (>2m)
 */
function depthToColor(depthM: number): [number, number, number, number] {
  if (depthM < DEPTH_THRESHOLDS[0]) return [0, 0, 0, 0]; // negligible

  if (depthM < DEPTH_THRESHOLDS[1]) {
    // 0.1m – 0.5m: yellow (light hazard)
    const t = (depthM - DEPTH_THRESHOLDS[0]) / (DEPTH_THRESHOLDS[1] - DEPTH_THRESHOLDS[0]);
    return [
      lerp(255, 253, t),
      lerp(237, 191, t),
      lerp(160, 80, t),
      lerp(70, 140, t),
    ];
  }

  if (depthM < DEPTH_THRESHOLDS[2]) {
    // 0.5m – 1.0m: orange (moderate hazard)
    const t = (depthM - DEPTH_THRESHOLDS[1]) / (DEPTH_THRESHOLDS[2] - DEPTH_THRESHOLDS[1]);
    return [
      lerp(253, 230, t),
      lerp(191, 100, t),
      lerp(80, 30, t),
      lerp(140, 185, t),
    ];
  }

  if (depthM < DEPTH_THRESHOLDS[3]) {
    // 1.0m – 2.0m: red (critical)
    const t = (depthM - DEPTH_THRESHOLDS[2]) / (DEPTH_THRESHOLDS[3] - DEPTH_THRESHOLDS[2]);
    return [
      lerp(230, 170, t),
      lerp(100, 20, t),
      lerp(30, 20, t),
      lerp(185, 210, t),
    ];
  }

  // >2.0m: dark red (extreme)
  return [150, 10, 10, 220];
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * Math.min(1, Math.max(0, t)));
}

/**
 * Generate a canvas image colored by estimated burial depth.
 * Burial depth ≈ snowDepthM × rMax (flux fraction of release mass).
 */
function generateHeatmapCanvas(
  result: FlowPyGridResult,
  snowDepthM: number
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = result.cols;
  canvas.height = result.rows;
  const ctx = canvas.getContext("2d")!;
  const imageData = ctx.createImageData(result.cols, result.rows);

  for (let r = 0; r < result.rows; r++) {
    for (let c = 0; c < result.cols; c++) {
      const gridIdx = r * result.cols + c;
      const canvasRow = result.rows - 1 - r; // flip: row 0 = south → bottom
      const pixelIdx = (canvasRow * result.cols + c) * 4;

      const flux = result.rMax[gridIdx];
      const estimatedDepth = snowDepthM * flux;
      const [red, green, blue, alpha] = depthToColor(estimatedDepth);

      imageData.data[pixelIdx] = red;
      imageData.data[pixelIdx + 1] = green;
      imageData.data[pixelIdx + 2] = blue;
      imageData.data[pixelIdx + 3] = alpha;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

export default function FlowPyOverlay() {
  const result = useAvalancheStore((s) => s.result);
  const snowDepth = useAvalancheStore((s) => s.snowDepth);
  const { current: mapRef } = useMap();
  const addedRef = useRef(false);

  const snowDepthM = snowDepth / 100;

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

    // Generate heatmap canvas colored by estimated burial depth
    const canvas = generateHeatmapCanvas(flowPy, snowDepthM);
    const dataUrl = canvas.toDataURL();

    // Compute geographic bounds
    const DEG_TO_RAD = Math.PI / 180;
    const EARTH_RADIUS_M = 6371000;
    const centerLat = flowPy.origin[1] + (flowPy.rows * flowPy.cellSize / 2) / (EARTH_RADIUS_M * DEG_TO_RAD);
    const mPerDegLat = EARTH_RADIUS_M * DEG_TO_RAD;
    const mPerDegLng = EARTH_RADIUS_M * DEG_TO_RAD * Math.cos(centerLat * DEG_TO_RAD);
    const demLike = {
      origin: flowPy.origin,
      cellSize: flowPy.cellSize,
      cols: flowPy.cols,
      rows: flowPy.rows,
      mPerDegLat,
      mPerDegLng,
    };

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
