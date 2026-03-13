import type { Map as MaplibreMap } from "maplibre-gl";
import type { Polygon } from "geojson";
import type { AvalanchePath, FlowPyGridResult, SnowProfile, RegionCoefficients } from "@/types";
import { buildVirtualDEM, identifyReleaseCells } from "@/lib/geo/virtual-dem";

type JobStatus = "queued" | "running" | "complete" | "failed";

interface JobCreateResponse {
  id: string;
}

interface JobStatusResponse {
  status: JobStatus;
  error?: string;
}

interface ServerResult {
  origin: [number, number];
  cellSize: number;
  cols: number;
  rows: number;
  deposition: number[];
  vMaxGrid: number[];
  pMaxGrid: number[];
  metadata: {
    solverVersion: string;
    runtime: number;
    steps: number;
    simulationTime: number;
    massConservation: number;
    massInitial?: number;
    massEntrained?: number;
    massDeposited?: number;
  };
}

interface OpenFoamJobPayload {
  schemaVersion: number;
  dem: {
    origin: [number, number];
    cellSize: number;
    cols: number;
    rows: number;
    elevation: number[];
  };
  releaseCells: [number, number][];
  startingZone: Polygon;
  snowDepthM: number;
  snowProfile: SnowProfile;
  regionCoefficients: RegionCoefficients;
  primaryPath: AvalanchePath;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function runOpenFoamLocal(
  map: MaplibreMap,
  startingZone: Polygon,
  primaryPath: AvalanchePath,
  snowDepthM: number,
  snowProfile: SnowProfile,
  region: RegionCoefficients,
  baseUrl: string,
  signal?: AbortSignal
): Promise<FlowPyGridResult> {
  const downslopeExtent = Math.max(primaryPath.runoutPoint.distanceFromCrown * 1.5, 2000);
  const dem = buildVirtualDEM(
    map,
    startingZone,
    primaryPath.fallLineAzimuth,
    downslopeExtent,
    15, // 15m cell size
    500 // 500m lateral padding
  );
  if (!dem) {
    throw new Error("failed to build virtual DEM");
  }
  const releaseCells = identifyReleaseCells(dem, startingZone);
  if (releaseCells.length === 0) {
    throw new Error("no release cells in DEM");
  }

  const payload: OpenFoamJobPayload = {
    schemaVersion: 1,
    dem: {
      origin: dem.origin,
      cellSize: dem.cellSize,
      cols: dem.cols,
      rows: dem.rows,
      elevation: Array.from(dem.elevation),
    },
    releaseCells,
    startingZone,
    snowDepthM,
    snowProfile,
    regionCoefficients: region,
    primaryPath,
  };

  const create = await fetchJson<JobCreateResponse>(`${baseUrl}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

  const timeoutMs = 20 * 60 * 1000;
  const pollMs = 2000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) {
      throw new Error("openfoam job aborted");
    }
    const status = await fetchJson<JobStatusResponse>(`${baseUrl}/jobs/${create.id}`, { signal });
    if (status.status === "failed") {
      throw new Error(status.error ?? "openfoam job failed");
    }
    if (status.status === "complete") {
      const raw = await fetchJson<ServerResult>(`${baseUrl}/jobs/${create.id}/results`, { signal });
      const n = raw.rows * raw.cols;
      return {
        origin: raw.origin,
        cellSize: raw.cellSize,
        cols: raw.cols,
        rows: raw.rows,
        deposition: new Float32Array(raw.deposition),
        zMaxDelta: new Float32Array(n),
        rMax: new Float32Array(n),
        cellCount: new Uint16Array(n),
        vMaxGrid: new Float32Array(raw.vMaxGrid),
        pMaxGrid: new Float32Array(raw.pMaxGrid),
        solverInfo: {
          type: 'openfoam',
          simulationTime: raw.metadata.simulationTime,
          timeSteps: raw.metadata.steps,
          massConservation: raw.metadata.massConservation,
          massInitial: raw.metadata.massInitial,
          massEntrained: raw.metadata.massEntrained,
          massDeposited: raw.metadata.massDeposited,
        },
      };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  throw new Error("openfoam job timed out");
}
