"use client";

import { Source, Layer } from "react-map-gl/maplibre";
import { useAvalancheStore } from "@/store/useAvalancheStore";
import type { Feature, Polygon, LineString } from "geojson";

export default function PathOverlay() {
  const result = useAvalancheStore((s) => s.result);

  if (!result) return null;

  const { path } = result;

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

  // Fall-line from crown to runout
  const fallLineData: Feature<LineString> = {
    type: "Feature",
    properties: {},
    geometry: {
      type: "LineString",
      coordinates: path.profile.map((p) => p.lngLat),
    },
  };

  // Key points: crown, beta, runout
  const pointsData = {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: { label: "Crown", color: "#DC2626" },
        geometry: {
          type: "Point" as const,
          coordinates: path.crownPoint.lngLat,
        },
      },
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
      },
    ],
  };

  return (
    <>
      {/* Track zone */}
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

      {/* Runout zone */}
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

      {/* Fall-line */}
      <Source id="fall-line" type="geojson" data={fallLineData}>
        <Layer
          id="fall-line-layer"
          type="line"
          paint={{
            "line-color": "#ffffff",
            "line-width": 2,
            "line-dasharray": [3, 3],
            "line-opacity": 0.7,
          }}
        />
      </Source>

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
