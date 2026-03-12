# Solver Decisions

## 1. Solver Codebase

**Choice**: [openfoam-avalanche](https://develop.openfoam.com/Community/avalanche) (OpenCFD community module)

- Branch: `master` (pin to specific commit at build time)
- Solver binary: `faSavageHutterFoam` — finite-area Savage-Hutter shallow-water solver on arbitrary terrain meshes
- Well-maintained under the OpenFOAM.com ecosystem; compiles against ESI OpenFOAM (v2312+)

## 2. Container Base Image & OpenFOAM Version

**Choice**: `opencfd/openfoam-dev:2312` (Debian-based, ~2.5 GB)

- ESI OpenFOAM v2312 — latest LTS-style release with finite-area support
- Includes `mpirun` (OpenMPI) out of the box
- The avalanche module compiles as a user library on top of this image

## 3. Runtime Constraints

| Constraint         | Value     | Rationale                                              |
| ------------------ | --------- | ------------------------------------------------------ |
| Max domain cells   | 90,000    | Matches existing VirtualDEM cap (300×300)              |
| Grid resolution    | 15 m      | Matches current tile-sampled DEM                       |
| Max simulation time| 120 s     | Physical time; matches Voellmy 2D `maxTime`            |
| Max wall-clock time| 300 s     | Hard kill after 5 min to prevent runaway jobs          |
| MPI ranks          | 1–4       | Local machine; user can configure via env var          |

## 4. Input Schema Version

**Frozen at**: `schemaVersion = 1`

The service rejects any request without a matching `schemaVersion` field. Breaking changes to the input/output format require bumping this version.

## 5. Localhost-Only Binding

The Go service binds to `127.0.0.1:8090` — no external network access. This is a toy/local integration, not a production service.

## 6. Single-Job Concurrency

One job at a time. New requests while a job is running receive `409 Conflict`. This avoids resource contention on a single machine.
