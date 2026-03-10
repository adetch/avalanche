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

  const { path } = result;

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
      </div>

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
