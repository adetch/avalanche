"use client";

import { useAvalancheStore } from "@/store/useAvalancheStore";

function formatDepth(inches: number): string {
  if (inches < 12) return `${inches}"`;
  const feet = Math.floor(inches / 12);
  const remaining = inches % 12;
  return remaining === 0 ? `${feet}'` : `${feet}' ${remaining}"`;
}

export default function SnowDepthInput() {
  const snowDepthCm = useAvalancheStore((s) => s.snowDepth);
  const setSnowDepth = useAvalancheStore((s) => s.setSnowDepth);

  // Convert cm to inches for display, inches to cm for storage
  const inches = Math.round(snowDepthCm / 2.54);

  const handleChange = (newInches: number) => {
    setSnowDepth(Math.round(newInches * 2.54));
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-zinc-700">Snow Depth</label>
        <span className="text-sm font-mono text-zinc-900">
          {formatDepth(inches)}
        </span>
      </div>
      <input
        type="range"
        min={4}
        max={200}
        step={2}
        value={inches}
        onChange={(e) => handleChange(Number(e.target.value))}
        className="mt-2 w-full accent-blue-600"
      />
      <div className="mt-1 flex justify-between text-xs text-zinc-400">
        <span>4&quot;</span>
        <span>16&apos; 8&quot;</span>
      </div>
    </div>
  );
}
