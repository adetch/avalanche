"use client";

import { useAvalancheStore } from "@/store/useAvalancheStore";

export default function SnowDepthInput() {
  const snowDepth = useAvalancheStore((s) => s.snowDepth);
  const setSnowDepth = useAvalancheStore((s) => s.setSnowDepth);

  return (
    <div>
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-zinc-700">Snow Depth</label>
        <span className="text-sm font-mono text-zinc-900">{snowDepth} cm</span>
      </div>
      <input
        type="range"
        min={10}
        max={500}
        step={10}
        value={snowDepth}
        onChange={(e) => setSnowDepth(Number(e.target.value))}
        className="mt-2 w-full accent-blue-600"
      />
      <div className="mt-1 flex justify-between text-xs text-zinc-400">
        <span>10 cm</span>
        <span>500 cm</span>
      </div>
    </div>
  );
}
