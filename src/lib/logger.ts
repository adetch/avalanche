import type { AvalancheResult } from "@/types";

function timestamp(): string {
  return new Date().toISOString();
}

// Buffer entries and flush to server in batches
let buffer: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  if (buffer.length === 0) return;
  const entries = [...buffer];
  buffer = [];
  flushTimer = null;

  fetch("/api/log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries }),
  }).catch(() => {
    // If the API fails, fall back to browser console
    entries.forEach((e) => console.log(e));
  });
}

function log(entry: string) {
  buffer.push(entry);
  if (!flushTimer) {
    flushTimer = setTimeout(flush, 100);
  }
}

export function logLocation(center: [number, number], name: string) {
  log(
    `[${timestamp()}] LOCATION | name="${name}" lng=${center[0].toFixed(6)} lat=${center[1].toFixed(6)}`
  );
}

export function logStartingZone(slopeAngle: number, areaSqMeters: number) {
  log(
    `[${timestamp()}] STARTING_ZONE | slopeAngle=${slopeAngle.toFixed(1)}° area=${areaSqMeters.toFixed(0)}m²`
  );
}

export function logComputationFailed(
  step: string,
  reason: string,
  polygonCenter: [number, number],
  areaSqMeters: number,
  details: Record<string, unknown> = {}
) {
  const detailStr = Object.entries(details)
    .map(([k, v]) => `${k}=${typeof v === "number" ? (v as number).toFixed(1) : v}`)
    .join(" ");
  log(
    `[${timestamp()}] COMPUTATION_FAILED | step="${step}" reason="${reason}" ` +
    `center=[${polygonCenter[0].toFixed(6)},${polygonCenter[1].toFixed(6)}] ` +
    `area=${areaSqMeters.toFixed(0)}m²` +
    (detailStr ? ` ${detailStr}` : "")
  );
}

export function logAvalanchePath(result: AvalancheResult) {
  const { path, computedSlopeAngle, volume, destructiveSize, horizontalRunout, verticalDrop, trackLength } = result;
  log(
    `[${timestamp()}] AVALANCHE_PATH | ` +
    `slope=${computedSlopeAngle.toFixed(1)}° ` +
    `alpha=${path.alphaAngle.toFixed(1)}° ` +
    `beta=${path.betaAngle.toFixed(1)}° ` +
    `azimuth=${path.fallLineAzimuth.toFixed(0)}° ` +
    `runout=${horizontalRunout.toFixed(0)}m ` +
    `drop=${verticalDrop.toFixed(0)}m ` +
    `track=${trackLength.toFixed(0)}m ` +
    `volume=${volume.toFixed(0)}m³ ` +
    `D-size=${destructiveSize} ` +
    `crown=[${path.crownPoint.lngLat[0].toFixed(6)},${path.crownPoint.lngLat[1].toFixed(6)}@${path.crownPoint.elevation.toFixed(0)}m] ` +
    `runoutPt=[${path.runoutPoint.lngLat[0].toFixed(6)},${path.runoutPoint.lngLat[1].toFixed(6)}@${path.runoutPoint.elevation.toFixed(0)}m]`
  );
}
