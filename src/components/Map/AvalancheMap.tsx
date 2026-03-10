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

const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_KEY;

export default function AvalancheMap() {
  const mapRef = useRef<MapRef>(null);
  const setMapReady = useAvalancheStore((s) => s.setMapReady);
  const flyToTarget = useAvalancheStore((s) => s.flyToTarget);
  const clearFlyTo = useAvalancheStore((s) => s.clearFlyTo);

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

  // Request geolocation on mount and fly to user's location
  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        mapRef.current?.flyTo({
          center: [pos.coords.longitude, pos.coords.latitude],
          zoom: 12,
          pitch: 50,
          duration: 2000,
        });
      },
      () => {
        // Denied or unavailable — stay at default view
      }
    );
  }, []);

  // Respond to flyTo requests from the store (e.g. address search)
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
        longitude: 7.66,
        latitude: 46.55,
        zoom: 12,
        pitch: 50,
        bearing: -20,
      }}
      style={{ width: "100%", height: "100%" }}
      mapStyle={`https://api.maptiler.com/maps/outdoor-v2/style.json?key=${MAPTILER_KEY}`}
      onLoad={onMapLoad}
      terrain={{ source: "terrain-dem", exaggeration: 1.2 }}
      maxPitch={85}
    >
      <NavigationControl position="top-right" />
      <GeolocateControl
        position="top-right"
        trackUserLocation
        showAccuracyCircle={false}
      />
      <DrawingLayer mapRef={mapRef} />
    </Map>
  );
}
