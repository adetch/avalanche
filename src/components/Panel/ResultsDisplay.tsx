"use client";

import { useAvalancheStore } from "@/store/useAvalancheStore";
import Badge from "@/components/UI/Badge";
import Legend from "@/components/UI/Legend";

export default function ResultsDisplay() {
  const result = useAvalancheStore((s) => s.result);
  const isComputing = useAvalancheStore((s) => s.isComputing);
  const error = useAvalancheStore((s) => s.error);
  const solverMode = useAvalancheStore((s) => s.solverMode);
  const externalSolverStatus = useAvalancheStore((s) => s.externalSolverStatus);
  const externalSolverError = useAvalancheStore((s) => s.externalSolverError);
  const cancelExternalJob = useAvalancheStore((s) => s.cancelExternalJob);

  if (isComputing) {
    return (
      <div className="rounded-md bg-zinc-50 px-4 py-3 text-sm text-zinc-500">
        Computing avalanche path...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-600">
        {error}
      </div>
    );
  }

  if (!result) return null;

  const { path, allPaths } = result;

  // Get confidence bands from the primary path
  const primaryPath = allPaths.find(
    (p) => p.horizontalRunout === result.horizontalRunout
  );
  const alphaConf = primaryPath?.alphaConfidence;

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-zinc-800">Results</h2>

      {/* Destructive size */}
      <Badge size={result.destructiveSize} />

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3">
        <Stat
          label="Volume"
          value={`${formatNumber(result.volume)} m³`}
        />
        <Stat
          label="Mass"
          value={`${formatNumber(result.mass)} t`}
        />
        <Stat
          label="Runout"
          value={`${formatNumber(result.horizontalRunout)} m`}
        />
        <Stat
          label="Vertical Drop"
          value={`${formatNumber(result.verticalDrop)} m`}
        />
        <Stat
          label="Track Length"
          value={`${formatNumber(result.trackLength)} m`}
        />
        <Stat
          label="Alpha"
          value={`${path.alphaAngle.toFixed(1)}°`}
        />
        <Stat
          label="Beta"
          value={`${path.betaAngle.toFixed(1)}°`}
          title="Beta point: where slope first drops below 10° (Lied & Bakkehøi convention)"
        />
        <Stat
          label="Confinement"
          value={result.confinement === "channelized" ? "Gully" : result.confinement === "partly-confined" ? "Partial" : "Open"}
        />
        {result.pathCount > 1 && (
          <Stat
            label="Paths"
            value={`${result.pathCount}`}
          />
        )}
      </div>

      {/* Profile shape diagnostics */}
      {primaryPath?.profileCurvature !== null && primaryPath?.profileCurvature !== undefined && (
        <div className="rounded-md bg-zinc-50 px-3 py-2">
          <div className="text-xs font-medium text-zinc-500 mb-1">
            Profile Shape
          </div>
          <div className="space-y-0.5 text-xs font-mono">
            <div className="flex justify-between text-zinc-700">
              <span title="Second derivative of quadratic fit (z''). Positive = concave (bowl), negative = convex (ridge)">
                Curvature (z&Prime;)
              </span>
              <span>
                {(primaryPath.profileCurvature * 1e6).toFixed(1)} ×10⁻⁶ /m
                {" "}
                <span className="text-zinc-400">
                  {primaryPath.profileCurvature > 0.5e-6 ? "concave" : primaryPath.profileCurvature < -0.5e-6 ? "convex" : "linear"}
                </span>
              </span>
            </div>
            {primaryPath.profileH0 !== null && (
              <div className="flex justify-between text-zinc-700">
                <span title="Vertical range of the quadratic profile fit">H₀</span>
                <span>{formatNumber(primaryPath.profileH0)} m</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Confidence bands */}
      {alphaConf && (
        <div className="rounded-md bg-zinc-50 px-3 py-2">
          <div className="text-xs font-medium text-zinc-500 mb-1">
            Runout Confidence
          </div>
          <div className="space-y-0.5 text-xs font-mono">
            <div className="flex justify-between text-zinc-500">
              <span>Short (α+1σ)</span>
              <span>{alphaConf.high.toFixed(1)}°</span>
            </div>
            <div className="flex justify-between text-zinc-800 font-semibold">
              <span>Mean (α)</span>
              <span>{alphaConf.mid.toFixed(1)}°</span>
            </div>
            <div className="flex justify-between text-red-600">
              <span>Long (α−1σ)</span>
              <span>{alphaConf.low.toFixed(1)}°</span>
            </div>
          </div>
        </div>
      )}

      {/* Runout range across paths */}
      {result.pathCount > 1 && (
        <div className="rounded-md bg-zinc-50 px-3 py-2">
          <div className="text-xs font-medium text-zinc-500 mb-1">
            Runout Range (Ensemble)
          </div>
          <div className="space-y-0.5 text-xs font-mono">
            <div className="flex justify-between text-zinc-500">
              <span>Min</span>
              <span>{formatNumber(result.runoutRange.min)} m</span>
            </div>
            <div className="flex justify-between text-zinc-800 font-semibold">
              <span>Median</span>
              <span>{formatNumber(result.runoutRange.median)} m</span>
            </div>
            <div className="flex justify-between text-red-600">
              <span>Max</span>
              <span>{formatNumber(result.runoutRange.max)} m</span>
            </div>
          </div>
        </div>
      )}

      {/* Voellmy dynamic results */}
      {result.voellmy && (
        <div className="rounded-md bg-zinc-50 px-3 py-2">
          <div className="text-xs font-medium text-zinc-500 mb-1">
            Dynamic Model (Voellmy)
          </div>
          <div className="space-y-0.5 text-xs font-mono">
            <div className="flex justify-between text-zinc-700">
              <span>Max velocity</span>
              <span>{result.voellmy.maxVelocity.toFixed(1)} m/s</span>
            </div>
            <div className="flex justify-between text-zinc-700">
              <span>Max pressure</span>
              <span>{result.voellmy.maxPressure.toFixed(0)} kPa</span>
            </div>
            <div className="flex justify-between text-zinc-700">
              <span>Dynamic runout</span>
              <span>{formatNumber(result.voellmy.dynamicRunout)} m</span>
            </div>
          </div>
        </div>
      )}

      {/* OpenFOAM solver status (shown independently of flowPy results) */}
      {solverMode === "openfoam-local" && externalSolverStatus === "running" && (
        <div className="rounded-md bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-700">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              OpenFOAM solver running...
            </div>
            <button
              onClick={cancelExternalJob}
              className="rounded px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {solverMode === "openfoam-local" && externalSolverStatus === "failed" && (
        <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-600">
          <div className="font-medium">OpenFOAM solver failed</div>
          {externalSolverError && (
            <div className="mt-1 text-xs">{externalSolverError}</div>
          )}
        </div>
      )}
      {solverMode === "openfoam-local" && externalSolverStatus === "complete" && !result.flowPy && (
        <div className="rounded-md bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700">
          OpenFOAM solver complete
        </div>
      )}

      {/* Flow-Py 2D simulation */}
      {result.flowPy && (
        <div className="rounded-md bg-zinc-50 px-3 py-2">
          <div className="text-xs font-medium text-zinc-500 mb-1">
            2D Flow Simulation
            {solverMode === "openfoam-local" && (
              <span className="ml-1 text-green-600">(OpenFOAM)</span>
            )}
          </div>
          <div className="space-y-0.5 text-xs font-mono">
            <div className="flex justify-between text-zinc-700">
              <span>Grid</span>
              <span>{result.flowPy.cols}×{result.flowPy.rows} ({result.flowPy.cellSize}m)</span>
            </div>
            <div className="flex justify-between text-zinc-700">
              <span>Cells reached</span>
              <span>{(() => {
                let count = 0;
                for (let i = 0; i < result.flowPy.cellCount.length; i++) {
                  if (result.flowPy.cellCount[i] > 0) count++;
                }
                return count.toLocaleString();
              })()}</span>
            </div>
            <div className="flex justify-between text-zinc-700">
              <span>Affected area</span>
              <span>{(() => {
                let count = 0;
                for (let i = 0; i < result.flowPy.cellCount.length; i++) {
                  if (result.flowPy.cellCount[i] > 0) count++;
                }
                const areaM2 = count * result.flowPy.cellSize * result.flowPy.cellSize;
                return areaM2 < 10000
                  ? `${formatNumber(areaM2)} m²`
                  : `${(areaM2 / 10000).toFixed(1)} ha`;
              })()}</span>
            </div>
            {(result.flowPy.solverInfo?.type === "voellmy-2d" || result.flowPy.solverInfo?.type === "openfoam") && (
              <>
                <div className="flex justify-between text-zinc-700">
                  <span>Mass in</span>
                  <span>{formatNumber((result.flowPy.solverInfo.massInitial ?? 0) + (result.flowPy.solverInfo.massEntrained ?? 0))} m</span>
                </div>
                <div className="flex justify-between text-zinc-700">
                  <span>Mass deposited</span>
                  <span>{formatNumber(result.flowPy.solverInfo.massDeposited ?? 0)} m</span>
                </div>
                <div className="flex justify-between text-zinc-700">
                  <span>Mass balance</span>
                  <span>{(((result.flowPy.solverInfo.massBalanceError ?? 0) * 100)).toFixed(1)}%</span>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Legend */}
      <div>
        <h3 className="mb-2 text-xs font-medium text-zinc-500 uppercase tracking-wide">
          Map Legend
        </h3>
        <Legend />
      </div>
    </div>
  );
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="rounded-md bg-zinc-50 px-3 py-2" title={title}>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-sm font-semibold text-zinc-900 font-mono">
        {value}
      </div>
    </div>
  );
}

function formatNumber(n: number): string {
  return n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString();
}
