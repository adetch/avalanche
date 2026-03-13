import type { Map as MaplibreMap } from "maplibre-gl";
import type { Polygon } from "geojson";
import type { AvalanchePath, FlowPyGridResult, SnowProfile, RegionCoefficients } from "@/types";
import { buildVirtualDEM, identifyReleaseCells } from "@/lib/geo/virtual-dem";

type JobStatus = "queued" | "running" | "complete" | "failed";

interface JobCreateResponse {
  jobId: string;
}

interface JobStatusResponse {
  status: JobStatus;
  error?: string;
}

interface JobResultResponse {
  flowPy: FlowPyGridResult;
}

interface OpenFoamJobPayload {
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
  region: RegionCoefficients;
  primaryPath: AvalanchePath;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error(
        "Cannot connect to solver service. Is Docker running and the solverd process started?"
      );
    }
    throw err;
  }
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 409) {
      let parsed: { error?: string } | undefined;
      try { parsed = JSON.parse(text); } catch { /* ignore */ }
      throw new Error(parsed?.error ?? "A solver job is already running");
    }
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function cancelOpenFoamJob(baseUrl: string, jobId: string): Promise<void> {
  try {
    await fetch(`${baseUrl}/jobs/${jobId}`, { method: "DELETE" });
  } catch {
    // Best-effort cancellation — ignore network errors
  }
}

export async function runOpenFoamLocal(
  map: MaplibreMap,
  startingZone: Polygon,
  primaryPath: AvalanchePath,
  snowDepthM: number,
  snowProfile: SnowProfile,
  region: RegionCoefficients,
  baseUrl: string,
  signal?: AbortSignal,
  onJobCreated?: (jobId: string) => void
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
    region,
    primaryPath,
  };

  const create = await fetchJson<JobCreateResponse>(`${baseUrl}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

  onJobCreated?.(create.jobId);

  const timeoutMs = 20 * 60 * 1000;
  const pollMs = 2000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) {
      throw new Error("openfoam job aborted");
    }
    const status = await fetchJson<JobStatusResponse>(`${baseUrl}/jobs/${create.jobId}`, { signal });
    if (status.status === "failed") {
      throw new Error(status.error ?? "openfoam job failed");
    }
    if (status.status === "complete") {
      const result = await fetchJson<JobResultResponse>(`${baseUrl}/jobs/${create.jobId}/results`, { signal });
      return result.flowPy;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  throw new Error("Solver timed out. The terrain may be too large or the solver service is unresponsive.");
}
