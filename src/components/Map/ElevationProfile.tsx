"use client";

import { useAvalancheStore } from "@/store/useAvalancheStore";

export default function ElevationProfile() {
  const result = useAvalancheStore((s) => s.result);

  if (!result) return null;

  const { profile, crownPoint, betaPoint, runoutPoint } = result.path;
  if (profile.length < 2) return null;

  // SVG dimensions
  const width = 280;
  const height = 120;
  const padding = { top: 10, right: 10, bottom: 24, left: 40 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  // Data bounds
  const minDist = profile[0].distanceFromCrown;
  const maxDist = profile[profile.length - 1].distanceFromCrown;
  const elevations = profile.map((p) => p.elevation);
  const minElev = Math.min(...elevations);
  const maxElev = Math.max(...elevations);
  const elevRange = maxElev - minElev || 1;
  const distRange = maxDist - minDist || 1;

  const scaleX = (d: number) =>
    padding.left + ((d - minDist) / distRange) * plotW;
  const scaleY = (e: number) =>
    padding.top + plotH - ((e - minElev) / elevRange) * plotH;

  // Build SVG path
  const pathD = profile
    .map((p, i) => {
      const x = scaleX(p.distanceFromCrown);
      const y = scaleY(p.elevation);
      return `${i === 0 ? "M" : "L"}${x},${y}`;
    })
    .join(" ");

  // Fill area under the profile
  const areaD =
    pathD +
    ` L${scaleX(maxDist)},${scaleY(minElev)} L${scaleX(minDist)},${scaleY(minElev)} Z`;

  // Key point positions
  const betaX = scaleX(betaPoint.distanceFromCrown);
  const betaY = scaleY(betaPoint.elevation);
  const runoutX = scaleX(runoutPoint.distanceFromCrown);
  const runoutY = scaleY(runoutPoint.elevation);

  return (
    <div>
      <h3 className="mb-2 text-xs font-medium text-zinc-500 uppercase tracking-wide">
        Elevation Profile
      </h3>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        style={{ maxHeight: 140 }}
      >
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const y = padding.top + plotH * (1 - t);
          const elev = minElev + elevRange * t;
          return (
            <g key={t}>
              <line
                x1={padding.left}
                y1={y}
                x2={padding.left + plotW}
                y2={y}
                stroke="#e4e4e7"
                strokeWidth={0.5}
              />
              <text
                x={padding.left - 4}
                y={y + 3}
                textAnchor="end"
                fontSize={7}
                fill="#a1a1aa"
              >
                {Math.round(elev)}
              </text>
            </g>
          );
        })}

        {/* Colored zones under the curve */}
        {/* Starting zone area (crown to ~50m) */}
        <path d={areaD} fill="#fef2f2" opacity={0.6} />

        {/* Beta point vertical line */}
        <line
          x1={betaX}
          y1={padding.top}
          x2={betaX}
          y2={padding.top + plotH}
          stroke="#F59E0B"
          strokeWidth={1}
          strokeDasharray="3,2"
          opacity={0.7}
        />

        {/* Runout point vertical line */}
        <line
          x1={runoutX}
          y1={padding.top}
          x2={runoutX}
          y2={padding.top + plotH}
          stroke="#FBBF24"
          strokeWidth={1}
          strokeDasharray="3,2"
          opacity={0.7}
        />

        {/* Profile line */}
        <path
          d={pathD}
          fill="none"
          stroke="#DC2626"
          strokeWidth={1.5}
          strokeLinejoin="round"
        />

        {/* Beta point */}
        <circle cx={betaX} cy={betaY} r={3} fill="#F59E0B" stroke="#fff" strokeWidth={1} />
        <text x={betaX} y={betaY - 6} textAnchor="middle" fontSize={7} fill="#92400e">
          Beta
        </text>

        {/* Runout point */}
        <circle cx={runoutX} cy={runoutY} r={3} fill="#FBBF24" stroke="#fff" strokeWidth={1} />
        <text x={runoutX} y={runoutY - 6} textAnchor="middle" fontSize={7} fill="#92400e">
          Runout
        </text>

        {/* X-axis label */}
        <text
          x={padding.left + plotW / 2}
          y={height - 2}
          textAnchor="middle"
          fontSize={7}
          fill="#a1a1aa"
        >
          Distance (m)
        </text>
      </svg>
    </div>
  );
}
