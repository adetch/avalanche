# Avalanche Solver Container

Docker container running **faSavageHutterFoam** from the
[OpenFOAM-avalanche](https://develop.openfoam.com/Community/avalanche) module.
The solver is a depth-integrated (finite-area) Savage-Hutter model for dense
snow avalanche simulation on natural terrain.

## Base Image

- `opencfd/openfoam-dev:2312` (ESI-OpenCFD OpenFOAM v2312)
- `faSavageHutterFoam`, `slopeMesh`, `makeFaMesh`, `releaseAreaMapping`, and
  all standard OpenFOAM utilities are pre-compiled in the image.

## Build

```bash
docker build -t avalanche-solver solver/
```

## Run

Mount a case directory to `/case` inside the container:

```bash
docker run --rm -v $(pwd)/solver/test-case:/case avalanche-solver
```

### Environment Variables

| Variable   | Default | Description                            |
| ---------- | ------- | -------------------------------------- |
| `NP`       | `1`     | Number of MPI ranks (1 = serial run)   |
| `CASE_DIR` | `/case` | Path to the OpenFOAM case inside the container |

#### Parallel run (4 MPI ranks)

```bash
docker run --rm -e NP=4 -v $(pwd)/solver/test-case:/case avalanche-solver
```

When `NP > 1`, the entrypoint automatically runs `decomposePar` before the
solver and `reconstructPar` after. The case must contain a valid
`system/decomposeParDict` matching the requested number of subdomains.

## Entrypoint Pipeline

The `entrypoint.sh` script runs the following steps in order:

1. **Source OpenFOAM environment** (`/usr/lib/openfoam/openfoam2312/etc/bashrc`)
2. **Mesh generation** -- `slopeMesh` if `constant/slopeMeshDict` exists,
   otherwise `blockMesh`
3. **Finite-area mesh** -- `makeFaMesh`
4. **Restore initial conditions** -- copies `0.orig/` to `0/`
5. **Release area mapping** -- `releaseAreaMapping` (if `constant/releaseArea`
   exists)
6. **Solver** -- `faSavageHutterFoam` (serial or MPI depending on `NP`)

Each step prints timing information. The script exits non-zero on any failure
(`set -e`).

## Test Case

The `test-case/` directory contains a minimal "simple slope" case adapted from
the [upstream tutorial](https://develop.openfoam.com/Community/avalanche/-/tree/main/tutorials/simpleslope).

### Domain

- 30 m x 10 m inclined plane
- Upper section at 35 deg, lower section at 10 deg, with a smooth transition
- 300 x 100 cells (0.1 m resolution)
- Spherical release area (r = 2 m) near the top of the slope

### Configuration

- Voellmy friction model (mu = 0.26, xi = 2500 m/s^2)
- No entrainment, no deposition
- End time: 2 s (short for quick smoke testing)
- Adaptive time stepping with maxCo = 1.0

### Case Directory Structure

```
test-case/
  0.orig/             # Initial conditions (copied to 0/ at runtime)
    h                 # Flow depth [m]
    Us                # Depth-averaged velocity [m/s]
    hentrain          # Entrainment depth [m]
  constant/
    g                 # Gravitational acceleration
    releaseArea       # Release zone definition (sphere)
    slopeMeshDict     # Slope geometry and mesh parameters
    transportProperties  # Friction model and physical parameters
  system/
    controlDict       # Solver settings, end time, output interval
    decomposeParDict  # Parallel decomposition (4 subdomains)
    faMeshDefinition  # Finite-area mesh definition on the slope patch
    faSchemes         # Finite-area discretization schemes
    faSolution        # Finite-area solver tolerances
    fvSchemes         # Finite-volume schemes (mostly unused by FA solver)
    fvSolution        # Finite-volume solver settings (empty)
```

### Expected Output

A successful run produces time directories (`1/`, `2/`) containing the solution
fields (`h`, `Us`, `hentrain`) and prints:

```
========================================
  Solver finished
  Total wall time: ~14s
========================================
```

## Notes

- The v2312 image expects flat `system/` and `0/` layouts (not the
  `system/finite-area/` subdirectory layout used by newer OpenFOAM versions).
- The container runs as root inside Docker. The `--allow-run-as-root` flag is
  passed to `mpirun` for parallel runs.
- For real terrain cases, replace `slopeMeshDict` with a `blockMeshDict` or
  import an external mesh, and adjust `faMeshDefinition` boundary patches to
  match.
