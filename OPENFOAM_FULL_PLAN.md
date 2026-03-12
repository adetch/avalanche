# Full Implementation Plan: OpenFOAM Solver + Local Service + UI Integration

This is a complete end‑to‑end plan to build and integrate a local OpenFOAM‑based avalanche solver into this app.

## Phase 0 — Decisions and Baselines
1. Pick solver codebase (OpenFOAM‑avalanche repo and specific branch/commit).
2. Choose container base image and OpenFOAM version.
3. Fix runtime constraints: max domain size, grid resolution, expected runtime.
4. Freeze input schema version: `schemaVersion = 1`.

Deliverables:
- `docs/solver/DECISIONS.md`
- `docs/solver/SCHEMA.md`

---

## Phase 1 — Solver Build (OpenFOAM)
1. Clone solver repo into `solver/` and pin commit hash.
2. Create Dockerfile to build OpenFOAM + solver.
3. Build and run a smoke case inside the container.
4. Expose a CLI entrypoint in the container:
   - `avalancheSolver -case /case` with MPI support.

Deliverables:
- `solver/Dockerfile`
- `solver/entrypoint.sh`
- `solver/README.md` (build/run instructions)

---

## Phase 2 — Input/Output Specification
1. Define input JSON schema:
   - DEM (origin, cellSize, rows, cols, elevation array)
   - releaseCells
   - startingZone polygon
   - snow depth + profile
   - region coeffs
   - primaryPath (fallLineAzimuth, runout, etc.)
2. Define output JSON schema:
   - deposition grid
   - vMax grid
   - pMax grid
   - metadata: solver version, runtime, steps
3. Add schema versioning and validation rules.

Deliverables:
- `docs/solver/SCHEMA.md`
- `docs/solver/sample_input.json`
- `docs/solver/sample_output.json`

---

## Phase 3 — Case Template & Parameter Mapping
1. Create a solver case template directory:
   - `case/system/*`, `case/constant/*`
2. Map input parameters into OpenFOAM case files:
   - friction parameters, entrainment, run time, output fields
3. Implement DEM + release conversion:
   - DEM → required terrain format
   - releaseCells → initial condition field

Deliverables:
- `solver/case-template/`
- `solver/scripts/generate_case.py` (or Go helper)

---

## Phase 4 — Local Go Solver Service
1. Implement Go daemon, binding to `127.0.0.1:8090`.
2. Endpoints:
   - `POST /jobs`
   - `GET /jobs/{id}`
   - `GET /jobs/{id}/results`
   - `DELETE /jobs/{id}` (cancel)
3. Single-job concurrency (reject if busy).
4. Job workspace per run:
   - `input.json`, `case/`, outputs, `result.json`
5. Job cleanup after completion.

Deliverables:
- `cmd/solverd/`
- `internal/api/` + `internal/jobs/`

---

## Phase 5 — Docker Runner (Go)
1. Launch container per job with volume mounts:
   - `/case` from job dir
2. Run solver with MPI:
   - `mpirun -np N avalancheSolver -case /case`
3. Capture logs + error handling.

Deliverables:
- `internal/jobs/runner.go`

---

## Phase 6 — Output Conversion
1. Parse solver outputs (ASCII/GeoTIFF/NetCDF).
2. Convert to Float32 grids.
3. Write `result.json` in app’s expected `FlowPyGridResult` shape.

Deliverables:
- `internal/convert/output.go`
- `docs/solver/output-format.md`

---

## Phase 7 — UI Integration
1. Add solver selector (internal vs OpenFOAM local).
2. On OpenFOAM mode:
   - submit job
   - poll status
   - load results on completion
3. Display status + errors.

Deliverables:
- UI changes in ControlPanel, ResultsDisplay, AvalancheMap

---

## Phase 8 — Validation & Calibration
1. Run a known benchmark case from literature.
2. Compare runout distance, deposit extent, and velocity.
3. Adjust parameter mapping if off by large margin.

Deliverables:
- `docs/solver/VALIDATION.md`
- benchmark outputs

---

## Phase 9 — UX Safety
1. Add warning that solver is heavy and slow.
2. Add timeouts and clear error messages.

---

## Critical Constraints (Toy/Local)
- Localhost only.
- Single job at a time.
- Cleanup after completion.
- Schema version required.

---

## Milestone Checklist
1. Container builds and runs a trivial case.
2. Go daemon creates a job and runs container.
3. Output conversion produces valid grids.
4. UI shows OpenFOAM output overlays.
5. Benchmark validation passed.

