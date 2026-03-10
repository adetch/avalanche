"use client";

const ZONES = [
  { label: "Starting Zone", color: "#DC2626" },
  { label: "Track", color: "#F59E0B" },
  { label: "Runout Zone", color: "#FBBF24" },
];

export default function Legend() {
  return (
    <div className="flex flex-col gap-1.5">
      {ZONES.map((zone) => (
        <div key={zone.label} className="flex items-center gap-2">
          <span
            className="inline-block h-3 w-3 rounded-sm"
            style={{ backgroundColor: zone.color, opacity: 0.7 }}
          />
          <span className="text-xs text-zinc-600">{zone.label}</span>
        </div>
      ))}
    </div>
  );
}
