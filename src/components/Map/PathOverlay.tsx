"use client";

import { Source, Layer } from "react-map-gl/maplibre";
import { useAvalancheStore } from "@/store/useAvalancheStore";
import type { Feature, Polygon, LineString, FeatureCollection } from "geojson";

export default function PathOverlay() {
  const result = useAvalancheStore((s) => s.result);

  if (!result) return null;

  const { path, allPaths } = result;

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

  // Primary fall-line from crown to runout (truncate at runout distance)
  const runoutDist = path.runoutPoint.distanceFromCrown;
  const fallLineCoords = path.profile
    .filter((p) => p.distanceFromCrown <= runoutDist)
    .map((p) => p.lngLat);
  fallLineCoords.push(path.runoutPoint.lngLat);
  const fallLineData: Feature<LineString> = {
    type: "Feature",
    properties: {},
    geometry: {
      type: "LineString",
      coordinates: fallLineCoords,
    },
  };

  // Secondary paths from ensemble (all paths except primary)
  const secondaryLines: FeatureCollection<LineString> = {
    type: "FeatureCollection",
    features: allPaths
      .filter((p) => p !== allPaths[0]) // skip primary (already rendered as white dashed)
      .map((p) => {
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

      {/* Secondary ensemble paths */}
      {secondaryLines.features.length > 0 && (
        <Source id="secondary-paths" type="geojson" data={secondaryLines}>
          <Layer
            id="secondary-paths-layer"
            type="line"
            paint={{
              "line-color": "#f97316",
              "line-width": 1.5,
              "line-opacity": 0.4,
              "line-dasharray": [2, 2],
            }}
          />
        </Source>
      )}

      {/* Primary fall-line */}
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
