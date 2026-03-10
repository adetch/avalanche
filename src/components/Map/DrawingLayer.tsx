"use client";

import { useCallback, useEffect } from "react";
import { Source, Layer, type MapRef } from "react-map-gl/maplibre";
import { useAvalancheStore } from "@/store/useAvalancheStore";
import type { Feature, Polygon, LineString, Point } from "geojson";

interface DrawingLayerProps {
  mapRef: React.RefObject<MapRef | null>;
}

export default function DrawingLayer({ mapRef }: DrawingLayerProps) {
  const drawingMode = useAvalancheStore((s) => s.drawingMode);
  const drawingVertices = useAvalancheStore((s) => s.drawingVertices);
  const startingZonePolygon = useAvalancheStore((s) => s.startingZonePolygon);
  const addDrawingVertex = useAvalancheStore((s) => s.addDrawingVertex);
  const finishDrawing = useAvalancheStore((s) => s.finishDrawing);

  // Handle map clicks for drawing
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;

    const handleClick = (e: maplibregl.MapMouseEvent) => {
      if (!useAvalancheStore.getState().drawingMode) return;
      addDrawingVertex({ lngLat: [e.lngLat.lng, e.lngLat.lat] });
    };

    const handleDblClick = (e: maplibregl.MapMouseEvent) => {
      if (!useAvalancheStore.getState().drawingMode) return;
      e.preventDefault();
      finishDrawing();
    };

    map.on("click", handleClick);
    map.on("dblclick", handleDblClick);

    return () => {
      map.off("click", handleClick);
      map.off("dblclick", handleDblClick);
    };
  }, [mapRef, addDrawingVertex, finishDrawing]);

  // Change cursor when in drawing mode
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    const canvas = map.getCanvas();
    canvas.style.cursor = drawingMode ? "crosshair" : "";
    return () => {
      canvas.style.cursor = "";
    };
  }, [drawingMode, mapRef]);

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
      (coord): Feature<Point> => ({
        type: "Feature",
        properties: {},
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

      {/* Drawing vertices */}
      {pointsData.features.length > 0 && (
        <Source id="drawing-points" type="geojson" data={pointsData}>
          <Layer
            id="drawing-points-layer"
            type="circle"
            paint={{
              "circle-radius": 5,
              "circle-color": "#ffffff",
              "circle-stroke-color": "#DC2626",
              "circle-stroke-width": 2,
            }}
          />
        </Source>
      )}
    </>
  );
}
