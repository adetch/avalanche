"use client";

import { useAvalancheStore } from "@/store/useAvalancheStore";
import Badge from "@/components/UI/Badge";
import Legend from "@/components/UI/Legend";

export default function ResultsDisplay() {
  const result = useAvalancheStore((s) => s.result);
  const isComputing = useAvalancheStore((s) => s.isComputing);
  const error = useAvalancheStore((s) => s.error);

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
        <Stat label="Alpha" value={`${path.alphaAngle.toFixed(1)}°`} />
        <Stat label="Beta" value={`${path.betaAngle.toFixed(1)}°`} />
        {result.pathCount > 1 && (
          <Stat
            label="Paths"
            value={`${result.pathCount}`}
          />
        )}
      </div>

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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-zinc-50 px-3 py-2">
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
