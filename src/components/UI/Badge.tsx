"use client";

import { DESTRUCTIVE_SIZE_INFO } from "@/lib/avalanche/destructive-size";

interface BadgeProps {
  size: 1 | 2 | 3 | 4 | 5;
}

export default function Badge({ size }: BadgeProps) {
  const info = DESTRUCTIVE_SIZE_INFO[size];

  return (
    <div className="flex items-center gap-2">
      <span
        className="inline-flex items-center justify-center rounded-md px-2.5 py-1 text-sm font-bold text-white"
        style={{ backgroundColor: info.color }}
      >
        {info.label}
      </span>
      <span className="text-sm text-zinc-600">{info.description}</span>
    </div>
  );
}
