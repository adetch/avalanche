"use client";

import { useRef, useCallback, useEffect } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import Map, {
  NavigationControl,
  GeolocateControl,
  type MapRef,
} from "react-map-gl/maplibre";
import { useAvalancheStore } from "@/store/useAvalancheStore";
import DrawingLayer from "./DrawingLayer";
import PathOverlay from "./PathOverlay";
import * as turf from "@turf/turf";
import { computeAvalanchePath } from "@/lib/avalanche/compute";
import { detectRegion } from "@/lib/avalanche/region-detect";
import { logStartingZone, logAvalanchePath, logComputationFailed } from "@/lib/logger";

const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_KEY;

export default function AvalancheMap() {
  const mapRef = useRef<MapRef>(null);
  const setMapReady = useAvalancheStore((s) => s.setMapReady);
  const flyToTarget = useAvalancheStore((s) => s.flyToTarget);
  const clearFlyTo = useAvalancheStore((s) => s.clearFlyTo);
  const startingZonePolygon = useAvalancheStore((s) => s.startingZonePolygon);
  const snowDepth = useAvalancheStore((s) => s.snowDepth);
  const snowProfile = useAvalancheStore((s) => s.snowProfile);
  const region = useAvalancheStore((s) => s.region);
  const setRegion = useAvalancheStore((s) => s.setRegion);
  const setSlopeAngle = useAvalancheStore((s) => s.setSlopeAngle);
  const setResult = useAvalancheStore((s) => s.setResult);
  const setComputing = useAvalancheStore((s) => s.setComputing);
  const setError = useAvalancheStore((s) => s.setError);

  const onMapLoad = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;

    map.addSource("terrain-dem", {
      type: "raster-dem",
      url: `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${MAPTILER_KEY}`,
      tileSize: 256,
    });

    map.setTerrain({ source: "terrain-dem", exaggeration: 1.2 });
    setMapReady(true);
  }, [setMapReady]);

  // Respond to flyTo requests from the store (e.g. address search, "Use my location")
  useEffect(() => {
    if (!flyToTarget) return;
    mapRef.current?.flyTo({
      center: flyToTarget.center,
      zoom: flyToTarget.zoom ?? 13,
      pitch: 50,
      duration: 2000,
    });
    clearFlyTo();
  }, [flyToTarget, clearFlyTo]);

  // Run computation when polygon or inputs change
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !startingZonePolygon) {
      setResult(null);
      return;
    }

    setComputing(true);
    setError(null);

    // Small delay to ensure terrain tiles are loaded at current view
    const timer = setTimeout(() => {
      const center = turf.center(startingZonePolygon).geometry.coordinates as [number, number];
      const area = turf.area(startingZonePolygon);

      // Auto-detect region from coordinates on first computation
      const detectedRegion = detectRegion(center);
      if (detectedRegion.id !== region.id) {
        setRegion(detectedRegion);
      }
      const activeRegion = detectedRegion.id !== region.id ? detectedRegion : region;

      try {
        const outcome = computeAvalanchePath(
          map,
          startingZonePolygon,
          0, // slope angle is now computed from DEM
          snowDepth,
          snowProfile,
          activeRegion
        );
        if (outcome.ok) {
          setResult(outcome.result);
          setSlopeAngle(Math.round(outcome.result.computedSlopeAngle));
          logStartingZone(outcome.result.computedSlopeAngle, area);
          logAvalanchePath(outcome.result);
          // Warn if slope is below typical slab avalanche threshold
          if (outcome.result.computedSlopeAngle < 25) {
            setError(
              `Slope angle (${Math.round(outcome.result.computedSlopeAngle)}°) is below the typical 25° threshold for slab avalanches. Results may be unreliable.`
            );
          }
        } else {
          const { failure } = outcome;
          logComputationFailed(failure.step, failure.reason, center, area, failure.details);
          setError(failure.reason);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown_error";
        logComputationFailed("exception", msg, center, area);
        setError("Computation failed. Try a different area.");
      } finally {
        setComputing(false);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [startingZonePolygon, snowDepth, snowProfile, region, setResult, setComputing, setError, setSlopeAngle, setRegion]);

  if (!MAPTILER_KEY) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-zinc-100 text-zinc-500">
        <p>
          Missing <code>NEXT_PUBLIC_MAPTILER_KEY</code> in .env.local
        </p>
      </div>
    );
  }

  return (
    <Map
      ref={mapRef}
      mapLib={maplibregl}
      initialViewState={{
        longitude: -120.1833,
        latitude: 39.328,
        zoom: 12,
        pitch: 50,
        bearing: -20,
      }}
      style={{ width: "100%", height: "100%" }}
      mapStyle={`https://api.maptiler.com/maps/outdoor-v2/style.json?key=${MAPTILER_KEY}`}
      onLoad={onMapLoad}
      maxPitch={85}
    >
      <NavigationControl position="top-right" visualizePitch showCompass />
      <GeolocateControl
        position="top-right"
        trackUserLocation
        showAccuracyCircle={false}
      />
      <DrawingLayer mapRef={mapRef} />
      <PathOverlay />
    </Map>
  );
}
