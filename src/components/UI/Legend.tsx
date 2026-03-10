"use client";

import { useAvalancheStore } from "@/store/useAvalancheStore";

export default function Legend() {
  const result = useAvalancheStore((s) => s.result);
  const hasFlowPy = result?.flowPy !== null && result?.flowPy !== undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-3 w-3 rounded-sm"
          style={{ backgroundColor: "#DC2626", opacity: 0.7 }}
        />
        <span className="text-xs text-zinc-600">Starting Zone</span>
      </div>

      {hasFlowPy ? (
        <div className="space-y-1">
          <div className="text-xs text-zinc-500 font-medium">Est. Burial Depth</div>
          <div className="flex items-center gap-2">
            <span className="inline-block h-3 w-3 rounded-sm" style={{ backgroundColor: "#FFED9E" }} />
            <span className="text-xs text-zinc-600">&lt; 0.3 m</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-block h-3 w-3 rounded-sm" style={{ backgroundColor: "#FDBF50" }} />
            <span className="text-xs text-zinc-600">0.3 – 1.0 m</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-block h-3 w-3 rounded-sm" style={{ backgroundColor: "#E6641E" }} />
            <span className="text-xs text-zinc-600">1.0 – 2.0 m</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-block h-3 w-3 rounded-sm" style={{ backgroundColor: "#AA0A0A" }} />
            <span className="text-xs text-zinc-600">&gt; 2.0 m</span>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-3 w-3 rounded-sm"
              style={{ backgroundColor: "#F59E0B", opacity: 0.7 }}
            />
            <span className="text-xs text-zinc-600">Track</span>
          </div>
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-3 w-3 rounded-sm"
              style={{ backgroundColor: "#FBBF24", opacity: 0.7 }}
            />
            <span className="text-xs text-zinc-600">Runout Zone</span>
          </div>
        </>
      )}
    </div>
  );
}
