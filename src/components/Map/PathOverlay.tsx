"use client";

import { Source, Layer } from "react-map-gl/maplibre";
import { useAvalancheStore } from "@/store/useAvalancheStore";
import type { Feature, Polygon, LineString, FeatureCollection } from "geojson";

export default function PathOverlay() {
  const result = useAvalancheStore((s) => s.result);

  if (!result) return null;

  const { path, allPaths } = result;
  const hasFlowPy = result.flowPy !== null;

  const trackData: Feature<Polygon> = {
    type: "Feature",
    properties: {},
    geometry: path.trackZone,
  };

  const runoutData: Feature<Polygon> = {
    type: "Feature",
    properties: {},
    geometry: path.runoutZone,
  };

  // All fall-line paths rendered uniformly
  const allLines: FeatureCollection<LineString> = {
    type: "FeatureCollection",
    features: allPaths.map((p) => {
      const coords = p.profile
        .filter((pt) => pt.distanceFromCrown <= p.horizontalRunout)
        .map((pt) => pt.lngLat);
      coords.push(p.runoutPoint.lngLat);
      return {
        type: "Feature" as const,
        properties: {},
        geometry: {
          type: "LineString" as const,
          coordinates: coords,
        },
      };
    }),
  };

  // Key points: Crown always shown.
  // Beta and Runout are alpha-beta model concepts — hidden when Flow-Py is active.
  const pointFeatures = [
    {
      type: "Feature" as const,
      properties: { label: "Crown", color: "#DC2626" },
      geometry: {
        type: "Point" as const,
        coordinates: path.crownPoint.lngLat,
      },
    },
  ];

  if (!hasFlowPy) {
    pointFeatures.push(
      {
        type: "Feature" as const,
        properties: { label: "Beta", color: "#F59E0B" },
        geometry: {
          type: "Point" as const,
          coordinates: path.betaPoint.lngLat,
        },
      },
      {
        type: "Feature" as const,
        properties: { label: "Runout", color: "#FBBF24" },
        geometry: {
          type: "Point" as const,
          coordinates: path.runoutPoint.lngLat,
        },
      }
    );
  }

  const pointsData = {
    type: "FeatureCollection" as const,
    features: pointFeatures,
  };

  return (
    <>
      {/* Track and runout zones — only shown when Flow-Py heatmap is not available */}
      {!hasFlowPy && (
        <>
          <Source id="track-zone" type="geojson" data={trackData}>
            <Layer
              id="track-zone-fill"
              type="fill"
              paint={{ "fill-color": "#F59E0B", "fill-opacity": 0.35 }}
            />
            <Layer
              id="track-zone-outline"
              type="line"
              paint={{ "line-color": "#F59E0B", "line-width": 1.5 }}
            />
          </Source>

          <Source id="runout-zone" type="geojson" data={runoutData}>
            <Layer
              id="runout-zone-fill"
              type="fill"
              paint={{ "fill-color": "#FBBF24", "fill-opacity": 0.25 }}
            />
            <Layer
              id="runout-zone-outline"
              type="line"
              paint={{
                "line-color": "#FBBF24",
                "line-width": 1.5,
                "line-dasharray": [4, 2],
              }}
            />
          </Source>
        </>
      )}

      {/* Ensemble fall-lines — hidden when Flow-Py heatmap is active */}
      {!hasFlowPy && (
        <Source id="fall-lines" type="geojson" data={allLines}>
          <Layer
            id="fall-lines-layer"
            type="line"
            paint={{
              "line-color": "#ffffff",
              "line-width": 1.5,
              "line-dasharray": [3, 3],
              "line-opacity": 0.6,
            }}
          />
        </Source>
      )}

      {/* Key points */}
      <Source id="key-points" type="geojson" data={pointsData}>
        <Layer
          id="key-points-circle"
          type="circle"
          paint={{
            "circle-radius": 7,
            "circle-color": ["get", "color"],
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 2,
          }}
        />
        <Layer
          id="key-points-label"
          type="symbol"
          layout={{
            "text-field": ["get", "label"],
            "text-size": 11,
            "text-offset": [0, -1.5],
            "text-font": ["Open Sans Bold"],
          }}
          paint={{
            "text-color": "#1f2937",
            "text-halo-color": "#ffffff",
            "text-halo-width": 1.5,
          }}
        />
      </Source>
    </>
  );
}
