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
        <>
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-3 w-10 rounded-sm"
              style={{
                background: "linear-gradient(to right, #FED976, #F59824, #B41414)",
                opacity: 0.85,
              }}
            />
            <span className="text-xs text-zinc-600">Flow intensity (low → high)</span>
          </div>
        </>
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
