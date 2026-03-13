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
import FlowPyOverlay from "./FlowPyOverlay";
import * as turf from "@turf/turf";
import { computeAvalanchePath } from "@/lib/avalanche/compute";
import { detectRegion } from "@/lib/avalanche/region-detect";
import { logStartingZone, logAvalanchePath, logComputationFailed } from "@/lib/logger";
import { runOpenFoamLocal, cancelOpenFoamJob } from "@/lib/solver/openfoam-local";

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
  const solverMode = useAvalancheStore((s) => s.solverMode);
  const localSolverUrl = useAvalancheStore((s) => s.localSolverUrl);
  const setExternalSolverStatus = useAvalancheStore((s) => s.setExternalSolverStatus);
  const setExternalSolverError = useAvalancheStore((s) => s.setExternalSolverError);
  const setExternalJobId = useAvalancheStore((s) => s.setExternalJobId);
  const setCancelExternalFn = useAvalancheStore((s) => s.setCancelExternalFn);
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

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
    setExternalSolverStatus("idle");
    setExternalSolverError(null);

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
          activeRegion,
          { flowPyMode: solverMode === "openfoam-local" ? "none" : "internal" }
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
          if (solverMode === "openfoam-local") {
            const requestId = ++requestIdRef.current;
            const snowDepthM = snowDepth / 100;
            // Abort any previous OpenFOAM job (client + server)
            const prevJobId = useAvalancheStore.getState().externalJobId;
            if (prevJobId) {
              cancelOpenFoamJob(localSolverUrl, prevJobId);
            }
            abortRef.current?.abort();
            const controller = new AbortController();
            abortRef.current = controller;
            const jobIdHolder = { current: "" };
            setExternalSolverStatus("running");
            setExternalJobId(null);
            setCancelExternalFn(() => {
              controller.abort();
              if (jobIdHolder.current) {
                cancelOpenFoamJob(localSolverUrl, jobIdHolder.current);
              }
            });
            runOpenFoamLocal(
              map,
              startingZonePolygon,
              outcome.result.path,
              snowDepthM,
              snowProfile,
              activeRegion,
              localSolverUrl,
              controller.signal,
              (jobId) => {
                jobIdHolder.current = jobId;
                setExternalJobId(jobId);
              }
            ).then((flowPy) => {
              if (requestIdRef.current !== requestId) return;
              const current = useAvalancheStore.getState().result;
              if (current) {
                setResult({ ...current, flowPy });
              }
              setExternalSolverStatus("complete");
              setCancelExternalFn(null);
            }).catch((err) => {
              if (requestIdRef.current !== requestId) return;
              if (controller.signal.aborted) return;
              setExternalSolverStatus("failed");
              const msg = err instanceof Error ? err.message : "OpenFOAM solver failed";
              setExternalSolverError(classifyError(msg));
              setCancelExternalFn(null);
            });
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

    return () => {
      clearTimeout(timer);
      const prevJobId = useAvalancheStore.getState().externalJobId;
      if (prevJobId) {
        cancelOpenFoamJob(localSolverUrl, prevJobId);
      }
      abortRef.current?.abort();
    };
  }, [startingZonePolygon, snowDepth, snowProfile, region, solverMode, localSolverUrl, setResult, setComputing, setError, setSlopeAngle, setRegion, setExternalSolverStatus, setExternalSolverError, setExternalJobId, setCancelExternalFn]);

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
      <FlowPyOverlay />
      <PathOverlay />
    </Map>
  );
}

function classifyError(msg: string): string {
  if (/cannot connect|fetch failed|network|ECONNREFUSED/i.test(msg)) {
    return "Cannot connect to solver service. Is Docker running and the solverd process started?";
  }
  if (/timed? ?out/i.test(msg)) {
    return "Solver timed out. The terrain may be too large or the solver service is unresponsive.";
  }
  if (/image.*not found|no such image|manifest unknown/i.test(msg)) {
    return "Solver container image not found. Run the container build first (see solver/README.md).";
  }
  if (/already running/i.test(msg)) {
    return "A solver job is already running. Wait for it to complete or cancel it.";
  }
  return msg;
}
