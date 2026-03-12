# Minimal Plan (Toy/Local) with Only Critical Fixes

Goal: Local OpenFOAM solver service for the app, with just the critical safeguards.

## 1. Local Go Solver Service
- Bind strictly to `127.0.0.1:8090`.
- Endpoints:
  - `POST /jobs` → create job, return `jobId`.
  - `GET /jobs/{id}` → status.
  - `GET /jobs/{id}/results` → result JSON.

### Critical safeguards
1. Localhost-only binding (no external access).
2. Single-job concurrency:
   - If a job is running, reject new requests with `409 busy`.
3. Job cleanup:
   - Delete job directory after completion (or on daemon restart).
4. Schema versioning:
   - Request must include `schemaVersion`, reject unknown version.

## 2. Docker Runner (Minimal)
- Run OpenFOAM container with:
  - `docker run --rm -v <jobdir>:/case ...`
- `mpirun -np N` inside container.

## 3. Data Flow
1. App submits JSON payload (includes DEM, release cells, params).
2. Service writes `input.json`, generates DEM file.
3. Solver runs → writes output raster files.
4. Service converts outputs to `result.json`.

## 4. UI Integration
- Use existing “Local OpenFOAM” mode.
- Display solver status from `/jobs/{id}`.
- Replace `flowPy` grid when job completes.
