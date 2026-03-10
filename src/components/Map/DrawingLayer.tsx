"use client";

import { useEffect, useState, useCallback } from "react";
import type { Map as MaplibreMap, MapMouseEvent } from "maplibre-gl";
import { Source, Layer, Marker, type MapRef } from "react-map-gl/maplibre";
import * as turf from "@turf/turf";
import { useAvalancheStore } from "@/store/useAvalancheStore";
import { queryElevation } from "@/lib/geo/elevation";
import type { Feature, Polygon, LineString, Point } from "geojson";

const CLOSE_THRESHOLD_PX = 15;
const METERS_TO_FEET = 3.28084;
const SQ_METERS_TO_SQ_FEET = 10.7639;
const SLOPE_SAMPLE_DIST_M = 30; // sample 30m in each direction for local slope

// Slope color stops: [degrees, [h, s, l]]
// Interpolated in HSL to avoid muddy gray midpoints
const SLOPE_COLOR_STOPS: [number, [number, number, number]][] = [
  [0,  [160, 68, 52]],   // emerald — flat, safe
  [25, [160, 68, 52]],   // emerald — below slab threshold
  [28, [49, 96, 53]],    // yellow — transitional
  [32, [27, 96, 61]],    // orange — prime avalanche terrain
  [38, [0, 91, 71]],     // red — very active
  [45, [0, 91, 71]],     // red — peak danger
  [50, [174, 68, 50]],   // teal — sluffs off, slabs unlikely
  [60, [174, 68, 50]],   // teal
];

function lerpHue(h0: number, h1: number, t: number): number {
  // Take the shortest arc around the hue wheel
  let diff = h1 - h0;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return ((h0 + diff * t) % 360 + 360) % 360;
}

function slopeColor(deg: number): string {
  if (deg <= SLOPE_COLOR_STOPS[0][0]) {
    const [h, s, l] = SLOPE_COLOR_STOPS[0][1];
    return `hsl(${h},${s}%,${l}%)`;
  }
  for (let i = 1; i < SLOPE_COLOR_STOPS.length; i++) {
    const [d0, c0] = SLOPE_COLOR_STOPS[i - 1];
    const [d1, c1] = SLOPE_COLOR_STOPS[i];
    if (deg <= d1) {
      const t = (deg - d0) / (d1 - d0);
      const h = Math.round(lerpHue(c0[0], c1[0], t));
      const s = Math.round(c0[1] + (c1[1] - c0[1]) * t);
      const l = Math.round(c0[2] + (c1[2] - c0[2]) * t);
      return `hsl(${h},${s}%,${l}%)`;
    }
  }
  const [h, s, l] = SLOPE_COLOR_STOPS[SLOPE_COLOR_STOPS.length - 1][1];
  return `hsl(${h},${s}%,${l}%)`;
}

interface CursorInfo {
  lngLat: [number, number];
  distanceFt: number;
  areaSqFt: number | null;
  slopeDeg: number | null;
}

interface DrawingLayerProps {
  mapRef: React.RefObject<MapRef | null>;
}

function formatDistance(feet: number): string {
  if (feet < 1000) return `${Math.round(feet)} ft`;
  return `${(feet / 5280).toFixed(2)} mi`;
}

function formatArea(sqFt: number): string {
  if (sqFt < 43560) return `${Math.round(sqFt).toLocaleString()} ft²`;
  return `${(sqFt / 43560).toFixed(2)} acres`;
}

/**
 * Compute the steepest local slope at a point by sampling elevation
 * in 8 compass directions and returning the max slope angle.
 */
function computeLocalSlope(
  map: MaplibreMap,
  lngLat: [number, number]
): number | null {
  const centerElev = queryElevation(map, lngLat);
  if (centerElev === null || !Number.isFinite(centerElev)) return null;

  let maxSlope = 0;
  for (let bearing = 0; bearing < 360; bearing += 45) {
    const dest = turf.destination(lngLat, SLOPE_SAMPLE_DIST_M / 1000, bearing, {
      units: "kilometers",
    });
    const coord = dest.geometry.coordinates as [number, number];
    const elev = queryElevation(map, coord);
    if (elev === null || !Number.isFinite(elev)) continue;

    const elevDiff = Math.abs(centerElev - elev);
    const angle = (Math.atan2(elevDiff, SLOPE_SAMPLE_DIST_M) * 180) / Math.PI;
    if (Number.isFinite(angle) && angle > maxSlope) maxSlope = angle;
  }

  return maxSlope;
}

/**
 * Compute average terrain slope across multiple vertices by sampling
 * the local slope at each vertex and averaging.
 */
function computeAverageSlopeAcrossVertices(
  map: MaplibreMap,
  vertices: { lngLat: [number, number] }[]
): number | null {
  const slopes: number[] = [];
  for (const v of vertices) {
    const s = computeLocalSlope(map, v.lngLat);
    if (s !== null) slopes.push(s);
  }
  if (slopes.length === 0) return null;
  return slopes.reduce((a, b) => a + b, 0) / slopes.length;
}

/**
 * Compute area of a polygon formed by vertices + an optional cursor point.
 * Returns area in square feet, or null if < 3 points.
 */
function computePolygonArea(
  vertices: [number, number][],
  cursorLngLat?: [number, number]
): number | null {
  const allPts = cursorLngLat ? [...vertices, cursorLngLat] : vertices;
  if (allPts.length < 3) return null;
  const coords = [...allPts, allPts[0]]; // close ring
  const poly = turf.polygon([coords]);
  return turf.area(poly) * SQ_METERS_TO_SQ_FEET;
}

export default function DrawingLayer({ mapRef }: DrawingLayerProps) {
  const drawingMode = useAvalancheStore((s) => s.drawingMode);
  const drawingVertices = useAvalancheStore((s) => s.drawingVertices);
  const startingZonePolygon = useAvalancheStore((s) => s.startingZonePolygon);
  const addDrawingVertex = useAvalancheStore((s) => s.addDrawingVertex);
  const finishDrawing = useAvalancheStore((s) => s.finishDrawing);
  const setSlopeAngle = useAvalancheStore((s) => s.setSlopeAngle);
  const [nearFirstVertex, setNearFirstVertex] = useState(false);
  const [cursorInfo, setCursorInfo] = useState<CursorInfo | null>(null);

  // Update slope from DEM when vertices are placed
  const updateSlopeFromVertices = useCallback(
    (vertices: { lngLat: [number, number] }[]) => {
      const map = mapRef.current?.getMap();
      if (!map || vertices.length < 1) return;

      const slope = computeAverageSlopeAcrossVertices(map, vertices);
      if (slope !== null) {
        setSlopeAngle(Math.round(slope));
      }
    },
    [mapRef, setSlopeAngle]
  );

  // Handle map clicks for drawing + proximity close
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;

    const handleClick = (e: MapMouseEvent) => {
      const state = useAvalancheStore.getState();
      if (!state.drawingMode) return;

      // If we have 3+ vertices and cursor is near the first vertex, close
      if (state.drawingVertices.length >= 3) {
        const firstLngLat = state.drawingVertices[0].lngLat;
        const firstPixel = map.project({
          lng: firstLngLat[0],
          lat: firstLngLat[1],
        });
        const clickPixel = e.point;
        const dx = firstPixel.x - clickPixel.x;
        const dy = firstPixel.y - clickPixel.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < CLOSE_THRESHOLD_PX) {
          finishDrawing();
          setCursorInfo(null);
          return;
        }
      }

      const newVertex = {
        lngLat: [e.lngLat.lng, e.lngLat.lat] as [number, number],
      };
      addDrawingVertex(newVertex);

      // Update slope — includes the new vertex
      const updatedVertices = [...state.drawingVertices, newVertex];
      updateSlopeFromVertices(updatedVertices);
    };

    map.on("click", handleClick);

    return () => {
      map.off("click", handleClick);
    };
  }, [mapRef, addDrawingVertex, finishDrawing, updateSlopeFromVertices]);

  // Track mouse: proximity to first vertex, distance from last vertex, live area
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;

    // Throttle slope queries — only recompute when cursor moves >5px
    let lastSlopePixel: { x: number; y: number } | null = null;
    let cachedSlope: number | null = null;

    const handleMouseMove = (e: MapMouseEvent) => {
      const state = useAvalancheStore.getState();
      if (!state.drawingMode) {
        setNearFirstVertex(false);
        setCursorInfo(null);
        return;
      }

      const cursorLngLat: [number, number] = [e.lngLat.lng, e.lngLat.lat];

      // Proximity to first vertex
      if (state.drawingVertices.length >= 3) {
        const firstLngLat = state.drawingVertices[0].lngLat;
        const firstPixel = map.project({
          lng: firstLngLat[0],
          lat: firstLngLat[1],
        });
        const dx = firstPixel.x - e.point.x;
        const dy = firstPixel.y - e.point.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        setNearFirstVertex(dist < CLOSE_THRESHOLD_PX);
      } else {
        setNearFirstVertex(false);
      }

      // Local slope at cursor — throttled to avoid excessive GPU readbacks
      let slopeDeg = cachedSlope;
      if (!lastSlopePixel ||
        Math.abs(e.point.x - lastSlopePixel.x) > 5 ||
        Math.abs(e.point.y - lastSlopePixel.y) > 5
      ) {
        slopeDeg = computeLocalSlope(map, cursorLngLat);
        cachedSlope = slopeDeg;
        lastSlopePixel = { x: e.point.x, y: e.point.y };
      }

      // Distance from last vertex to cursor
      if (state.drawingVertices.length >= 1) {
        const lastVertex =
          state.drawingVertices[state.drawingVertices.length - 1];
        const from = turf.point(lastVertex.lngLat);
        const to = turf.point(cursorLngLat);
        const distKm = turf.distance(from, to, { units: "kilometers" });
        const distFt = distKm * 1000 * METERS_TO_FEET;

        // Live area: existing vertices + cursor as tentative next point
        const vertexCoords = state.drawingVertices.map((v) => v.lngLat);
        const liveArea = computePolygonArea(vertexCoords, cursorLngLat);

        setCursorInfo({
          lngLat: cursorLngLat,
          distanceFt: distFt,
          areaSqFt: liveArea,
          slopeDeg,
        });
      } else {
        setCursorInfo({
          lngLat: cursorLngLat,
          distanceFt: 0,
          areaSqFt: null,
          slopeDeg,
        });
      }
    };

    map.on("mousemove", handleMouseMove);
    return () => {
      map.off("mousemove", handleMouseMove);
      setNearFirstVertex(false);
      setCursorInfo(null);
    };
  }, [mapRef]);

  // Change cursor based on drawing state
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    const canvas = map.getCanvas();
    if (!drawingMode) {
      canvas.style.cursor = "";
    } else if (nearFirstVertex) {
      canvas.style.cursor = "pointer";
    } else {
      canvas.style.cursor = "crosshair";
    }
    return () => {
      canvas.style.cursor = "";
    };
  }, [drawingMode, nearFirstVertex, mapRef]);

  // Build GeoJSON for in-progress drawing
  const vertexCoords = drawingVertices.map((v) => v.lngLat);

  const lineData: Feature<LineString> | null =
    vertexCoords.length >= 2
      ? {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: vertexCoords,
          },
        }
      : null;

  const previewPolygonData: Feature<Polygon> | null =
    vertexCoords.length >= 3
      ? {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [[...vertexCoords, vertexCoords[0]]],
          },
        }
      : null;

  const pointsData = {
    type: "FeatureCollection" as const,
    features: vertexCoords.map(
      (coord, i): Feature<Point> => ({
        type: "Feature",
        properties: { isFirst: i === 0 && vertexCoords.length >= 3 },
        geometry: { type: "Point", coordinates: coord },
      })
    ),
  };

  // Completed polygon
  const completedPolygonData: Feature<Polygon> | null = startingZonePolygon
    ? { type: "Feature", properties: {}, geometry: startingZonePolygon }
    : null;

  return (
    <>
      {/* Completed starting zone polygon */}
      {completedPolygonData && (
        <Source id="starting-zone" type="geojson" data={completedPolygonData}>
          <Layer
            id="starting-zone-fill"
            type="fill"
            paint={{ "fill-color": "#DC2626", "fill-opacity": 0.35 }}
          />
          <Layer
            id="starting-zone-outline"
            type="line"
            paint={{
              "line-color": "#DC2626",
              "line-width": 2,
            }}
          />
        </Source>
      )}

      {/* In-progress drawing line */}
      {lineData && (
        <Source id="drawing-line" type="geojson" data={lineData}>
          <Layer
            id="drawing-line-layer"
            type="line"
            paint={{
              "line-color": "#DC2626",
              "line-width": 2,
              "line-dasharray": [2, 2],
            }}
          />
        </Source>
      )}

      {/* In-progress preview polygon fill */}
      {previewPolygonData && (
        <Source
          id="drawing-preview"
          type="geojson"
          data={previewPolygonData}
        >
          <Layer
            id="drawing-preview-fill"
            type="fill"
            paint={{ "fill-color": "#DC2626", "fill-opacity": 0.15 }}
          />
        </Source>
      )}

      {/* Drawing vertices — first vertex gets larger ring when closeable */}
      {pointsData.features.length > 0 && (
        <Source id="drawing-points" type="geojson" data={pointsData}>
          <Layer
            id="drawing-points-layer"
            type="circle"
            paint={{
              "circle-radius": [
                "case",
                ["get", "isFirst"],
                nearFirstVertex ? 8 : 7,
                5,
              ],
              "circle-color": [
                "case",
                ["get", "isFirst"],
                "#DC2626",
                "#ffffff",
              ],
              "circle-stroke-color": "#DC2626",
              "circle-stroke-width": 2,
            }}
          />
        </Source>
      )}

      {/* Cursor label: distance + live area */}
      {drawingMode && cursorInfo && (
        <Marker
          longitude={cursorInfo.lngLat[0]}
          latitude={cursorInfo.lngLat[1]}
          anchor="bottom-left"
          offset={[12, -12]}
        >
          <div className="pointer-events-none rounded bg-zinc-900/80 px-2 py-1 text-xs font-mono text-white whitespace-nowrap shadow-lg">
            <span
              style={{
                color: cursorInfo.slopeDeg !== null
                  ? slopeColor(cursorInfo.slopeDeg)
                  : "#a1a1aa",
              }}
            >
              {cursorInfo.slopeDeg !== null
                ? `${Math.round(cursorInfo.slopeDeg)}°`
                : "—"}
            </span>
            {cursorInfo.distanceFt > 0 && (
              <>
                <span className="mx-1.5 text-zinc-400">|</span>
                <span>{formatDistance(cursorInfo.distanceFt)}</span>
              </>
            )}
            {cursorInfo.areaSqFt !== null && (
              <>
                <span className="mx-1.5 text-zinc-400">|</span>
                <span>{formatArea(cursorInfo.areaSqFt)}</span>
              </>
            )}
          </div>
        </Marker>
      )}
    </>
  );
}
