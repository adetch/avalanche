"use client";

import { useAvalancheStore } from "@/store/useAvalancheStore";
import { SNOW_PROFILES } from "@/lib/avalanche/snow-profiles";
import { REGION_COEFFICIENTS } from "@/lib/avalanche/alpha-beta";

export default function SnowConditions() {
  const snowProfile = useAvalancheStore((s) => s.snowProfile);
  const setSnowProfile = useAvalancheStore((s) => s.setSnowProfile);
  const region = useAvalancheStore((s) => s.region);
  const setRegion = useAvalancheStore((s) => s.setRegion);

  return (
    <div className="space-y-3">
      <label className="text-sm font-medium text-zinc-700">
        Snow Conditions
      </label>

      {/* Snow type */}
      <div>
        <div className="text-xs text-zinc-500 mb-1">Snow Type</div>
        <select
          value={snowProfile.id}
          onChange={(e) => {
            const profile = SNOW_PROFILES.find((p) => p.id === e.target.value);
            if (profile) setSnowProfile(profile);
          }}
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
        >
          {SNOW_PROFILES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <div className="mt-1 flex gap-3 text-xs text-zinc-400">
          <span>{snowProfile.density} kg/m³</span>
          <span>{snowProfile.entrainmentFactor}× entrainment</span>
        </div>
      </div>

      {/* Snowpack region */}
      <div>
        <div className="text-xs text-zinc-500 mb-1">Snowpack</div>
        <select
          value={region.id}
          onChange={(e) => {
            const r = REGION_COEFFICIENTS.find((r) => r.id === e.target.value);
            if (r) setRegion(r);
          }}
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
        >
          {REGION_COEFFICIENTS.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
        <div className="mt-1 text-xs text-zinc-400">
          Runout coefficients calibrated from observed avalanche paths in this
          region. Different mountain ranges have different terrain geometry that
          affects how far avalanches travel.
        </div>
      </div>
    </div>
  );
}
