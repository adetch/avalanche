"use client";

import { useEffect, useRef } from "react";
import { useMap } from "react-map-gl/maplibre";
import { useAvalancheStore } from "@/store/useAvalancheStore";
import { gridToLngLat } from "@/lib/geo/virtual-dem";
import type { FlowPyGridResult } from "@/types";

const SOURCE_ID = "flowpy-heatmap";
const LAYER_ID = "flowpy-heatmap-layer";

/**
 * Color ramp for Flow-Py flux values (log-scaled).
 * Returns [r, g, b, a] in 0-255 range.
 */
function fluxToColor(rMax: number, rStop: number): [number, number, number, number] {
  if (rMax <= 0) return [0, 0, 0, 0];

  // Log-scale normalization: map [rStop, 1.0] to [0, 1]
  const logMin = Math.log10(rStop);
  const logMax = 0; // log10(1.0) = 0
  const logVal = Math.log10(Math.max(rMax, rStop));
  const t = Math.max(0, Math.min(1, (logVal - logMin) / (logMax - logMin)));

  // 5-stop color ramp: blue → teal → yellow → orange → red
  if (t < 0.25) {
    const s = t / 0.25;
    return [
      lerp(66, 65, s),
      lerp(133, 182, s),
      lerp(244, 196, s),
      lerp(80, 120, s),
    ];
  } else if (t < 0.5) {
    const s = (t - 0.25) / 0.25;
    return [
      lerp(65, 254, s),
      lerp(182, 204, s),
      lerp(196, 92, s),
      lerp(120, 160, s),
    ];
  } else if (t < 0.75) {
    const s = (t - 0.5) / 0.25;
    return [
      lerp(254, 253, s),
      lerp(204, 141, s),
      lerp(92, 60, s),
      lerp(160, 190, s),
    ];
  } else {
    const s = (t - 0.75) / 0.25;
    return [
      lerp(253, 200, s),
      lerp(141, 30, s),
      lerp(60, 30, s),
      lerp(190, 220, s),
    ];
  }
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/**
 * Generate a canvas image from Flow-Py grid results.
 */
function generateHeatmapCanvas(
  result: FlowPyGridResult
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = result.cols;
  canvas.height = result.rows;
  const ctx = canvas.getContext("2d")!;
  const imageData = ctx.createImageData(result.cols, result.rows);

  const rStop = 3e-4;

  for (let r = 0; r < result.rows; r++) {
    for (let c = 0; c < result.cols; c++) {
      const gridIdx = r * result.cols + c;
      // Canvas row 0 = top = north (highest row), so flip vertically
      const canvasRow = result.rows - 1 - r;
      const pixelIdx = (canvasRow * result.cols + c) * 4;

      const flux = result.rMax[gridIdx];
      const [red, green, blue, alpha] = fluxToColor(flux, rStop);

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
  const { current: mapRef } = useMap();
  const addedRef = useRef(false);

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

    // Generate heatmap canvas
    const canvas = generateHeatmapCanvas(flowPy);
    const dataUrl = canvas.toDataURL();

    // Compute geographic bounds using the grid metadata
    // We need a minimal VirtualDEM-like object for gridToLngLat
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

    // MapLibre image source coordinates: [top-left, top-right, bottom-right, bottom-left]
    const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [
      nw, ne, se, sw,
    ];

    try {
      map.addSource(SOURCE_ID, {
        type: "image",
        url: dataUrl,
        coordinates,
      });

      // Insert below the track zone fill layer if it exists, otherwise just add
      const beforeLayer = map.getLayer("track-zone-fill") ? "track-zone-fill" : undefined;

      map.addLayer(
        {
          id: LAYER_ID,
          type: "raster",
          source: SOURCE_ID,
          paint: {
            "raster-opacity": 0.7,
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
  }, [result?.flowPy, mapRef]);

  return null; // Imperative MapLibre layer, no JSX rendering
}
