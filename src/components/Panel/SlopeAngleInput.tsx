"use client";

import { useAvalancheStore } from "@/store/useAvalancheStore";

export default function SlopeAngleInput() {
  const slopeAngle = useAvalancheStore((s) => s.slopeAngle);
  const setSlopeAngle = useAvalancheStore((s) => s.setSlopeAngle);

  return (
    <div>
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-zinc-700">
          Slope Angle
        </label>
        <span className="text-sm font-mono text-zinc-900">{slopeAngle}°</span>
      </div>
      <input
        type="range"
        min={20}
        max={60}
        value={slopeAngle}
        onChange={(e) => setSlopeAngle(Number(e.target.value))}
        className="mt-2 w-full accent-red-600"
      />
      <div className="mt-1 flex justify-between text-xs text-zinc-400">
        <span>20°</span>
        <span>60°</span>
      </div>
      {(slopeAngle < 25 || slopeAngle > 55) && (
        <p className="mt-1 text-xs text-amber-600">
          {slopeAngle < 25
            ? "Slopes under 25° rarely produce avalanches."
            : "Slopes over 55° tend to sluff frequently rather than build slabs."}
        </p>
      )}
    </div>
  );
}
