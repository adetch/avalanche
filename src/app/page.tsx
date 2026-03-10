"use client";

import dynamic from "next/dynamic";
import ControlPanel from "@/components/Panel/ControlPanel";

const AvalancheMap = dynamic(
  () => import("@/components/Map/AvalancheMap"),
  { ssr: false }
);

export default function Home() {
  return (
    <div className="flex h-screen w-screen">
      <ControlPanel />
      <div className="flex-1">
        <AvalancheMap />
      </div>
    </div>
  );
}
