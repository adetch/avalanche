"use client";

import { useAvalancheStore } from "@/store/useAvalancheStore";

export default function SlopeAngleInput() {
  const slopeAngle = useAvalancheStore((s) => s.slopeAngle);
  const startingZonePolygon = useAvalancheStore((s) => s.startingZonePolygon);
  const drawingVertices = useAvalancheStore((s) => s.drawingVertices);
  const drawingMode = useAvalancheStore((s) => s.drawingMode);

  const hasSlope = startingZonePolygon || (drawingMode && drawingVertices.length >= 1);
  const isLive = drawingMode && !startingZonePolygon;

  return (
    <div>
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-zinc-700">
          Slope Angle
        </label>
        <span className="text-sm font-mono text-zinc-900">
          {hasSlope ? `${slopeAngle}°` : "—"}
          {isLive && hasSlope && (
            <span className="ml-1 text-xs text-zinc-400">(live)</span>
          )}
        </span>
      </div>
      <p className="mt-1 text-xs text-zinc-400">
        {hasSlope
          ? isLive
            ? "Estimated from vertices placed so far."
            : "Computed from terrain elevation data."
          : "Draw a starting zone to measure slope."}
      </p>
      {hasSlope && (slopeAngle < 25 || slopeAngle > 55) && (
        <p className="mt-1 text-xs text-amber-600">
          {slopeAngle < 25
            ? "Slopes under 25° rarely produce avalanches."
            : "Slopes over 55° tend to sluff frequently rather than build slabs."}
        </p>
      )}
    </div>
  );
}
