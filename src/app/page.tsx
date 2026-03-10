"use client";

import dynamic from "next/dynamic";
import ControlPanel from "@/components/Panel/ControlPanel";

const AvalancheMap = dynamic(
  () => import("@/components/Map/AvalancheMap"),
  { ssr: false }
);

export default function Home() {
  return (
    <div className="flex h-screen w-screen flex-col md:flex-row">
      {/* Sidebar on desktop, bottom sheet on mobile */}
      <div className="order-2 max-h-[40vh] md:order-1 md:max-h-none">
        <ControlPanel />
      </div>
      <div className="order-1 flex-1 md:order-2">
        <AvalancheMap />
      </div>
    </div>
  );
}
