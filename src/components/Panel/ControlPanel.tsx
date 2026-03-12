"use client";

import { useAvalancheStore } from "@/store/useAvalancheStore";
import LocationSearch from "./LocationSearch";
import SlopeAngleInput from "./SlopeAngleInput";
import SnowDepthInput from "./SnowDepthInput";
import SnowConditions from "./SnowConditions";
import ResultsDisplay from "./ResultsDisplay";
import ElevationProfile from "@/components/Map/ElevationProfile";

export default function ControlPanel() {
  const drawingMode = useAvalancheStore((s) => s.drawingMode);
  const toggleDrawingMode = useAvalancheStore((s) => s.toggleDrawingMode);
  const startingZonePolygon = useAvalancheStore((s) => s.startingZonePolygon);
  const clearDrawing = useAvalancheStore((s) => s.clearDrawing);
  const flyTo = useAvalancheStore((s) => s.flyTo);
  const solverMode = useAvalancheStore((s) => s.solverMode);
  const setSolverMode = useAvalancheStore((s) => s.setSolverMode);
  const localSolverUrl = useAvalancheStore((s) => s.localSolverUrl);
  const setLocalSolverUrl = useAvalancheStore((s) => s.setLocalSolverUrl);

  return (
    <div className="flex h-full w-full shrink-0 flex-col border-t border-zinc-200 bg-white p-4 overflow-y-auto md:w-80 md:border-r md:border-t-0 md:p-6">
      <h1 className="text-lg font-semibold text-zinc-900">
        Avalanche Path Estimator
      </h1>
      <p className="mt-1 text-sm text-zinc-500">
        Search for a location, then draw an area on the map.
      </p>

      <div className="mt-6 space-y-6">
        {/* Location search */}
        <LocationSearch
          onSelect={(center) => flyTo({ center, zoom: 13 })}
        />

        <hr className="border-zinc-200" />

        {/* Slope & snow inputs */}
        <SlopeAngleInput />
        <SnowDepthInput />
        <SnowConditions />

        <hr className="border-zinc-200" />

        {/* Solver selection */}
        <div className="space-y-3">
          <label className="text-sm font-medium text-zinc-700">
            Solver
          </label>
          <select
            value={solverMode}
            onChange={(e) => setSolverMode(e.target.value as "internal" | "openfoam-local")}
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900"
          >
            <option value="internal">Internal (fast)</option>
            <option value="openfoam-local">Local OpenFOAM (slow)</option>
          </select>
          {solverMode === "openfoam-local" && (
            <div className="space-y-2">
              <label className="text-xs text-zinc-500">Local solver URL</label>
              <input
                value={localSolverUrl}
                onChange={(e) => setLocalSolverUrl(e.target.value)}
                className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs text-zinc-900"
                placeholder="http://127.0.0.1:8090"
              />
              <p className="text-[11px] text-zinc-500">
                Requires a local OpenFOAM container exposing a REST API.
              </p>
            </div>
          )}
        </div>

        <hr className="border-zinc-200" />

        {/* Drawing controls */}
        <div className="space-y-3">
          <label className="text-sm font-medium text-zinc-700">
            Starting Zone
          </label>

          {!startingZonePolygon ? (
            <button
              onClick={toggleDrawingMode}
              className={`w-full rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                drawingMode
                  ? "bg-red-600 text-white hover:bg-red-700"
                  : "bg-zinc-900 text-white hover:bg-zinc-800"
              }`}
            >
              {drawingMode ? "Cancel Drawing" : "Draw on Map"}
            </button>
          ) : (
            <div className="space-y-2">
              <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                Starting zone defined
              </div>
              <button
                onClick={clearDrawing}
                className="w-full rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
              >
                Clear &amp; Redraw
              </button>
            </div>
          )}

          {drawingMode && (
            <p className="text-xs text-zinc-500">
              Click to place vertices. After 3+ points, click near the first
              point to close the polygon.
            </p>
          )}
        </div>

        <hr className="border-zinc-200" />

        {/* Results */}
        <ResultsDisplay />

        {/* Elevation profile */}
        <ElevationProfile />
      </div>

      <div className="mt-auto pt-6 text-xs text-zinc-400">
        Educational tool only. Do not use for avalanche safety decisions.
      </div>
    </div>
  );
}
