#!/bin/bash
# entrypoint.sh — OpenFOAM avalanche solver wrapper
# Runs the faSavageHutterFoam pipeline inside the container.
#
# Environment variables:
#   NP  — number of MPI ranks (default: 1)
#
set -eo pipefail

# ---------- OpenFOAM environment ----------
FOAM_BASHRC="/usr/lib/openfoam/openfoam2312/etc/bashrc"
if [ ! -f "$FOAM_BASHRC" ]; then
    echo "ERROR: OpenFOAM bashrc not found at $FOAM_BASHRC" >&2
    exit 1
fi
# OpenFOAM's bashrc references unset variables and contains commands that
# return non-zero; disable errexit and nounset temporarily during sourcing
set +eu
source "$FOAM_BASHRC"
set -eu

# ---------- Configuration ----------
NP="${NP:-1}"
CASE_DIR="${CASE_DIR:-/case}"

echo "========================================"
echo "  faSavageHutterFoam solver container"
echo "========================================"
echo "  Case directory : $CASE_DIR"
echo "  MPI ranks      : $NP"
echo "  OpenFOAM       : $WM_PROJECT_VERSION"
echo "========================================"

cd "$CASE_DIR"

TOTAL_START=$(date +%s)

# ---------- Helper ----------
run_step() {
    local step_name="$1"
    shift
    echo ""
    echo ">>> [$step_name] $*"
    local t0=$(date +%s)
    "$@"
    local t1=$(date +%s)
    echo "<<< [$step_name] completed in $((t1 - t0))s"
}

# ---------- 1. Mesh generation ----------
if [ -f "constant/slopeMeshDict" ]; then
    run_step "slopeMesh" slopeMesh
else
    run_step "blockMesh" blockMesh
fi

# ---------- 1b. Terrain displacement ----------
# If pre-computed displaced points exist, swap them in to follow DEM elevation
if [ -f "displaced/points" ]; then
    echo ""
    echo ">>> [displace_terrain] Replacing mesh points with terrain-following coordinates"
    cp displaced/points constant/polyMesh/points
    echo "<<< [displace_terrain] done"
fi

# ---------- 2. Finite-area mesh ----------
run_step "makeFaMesh" makeFaMesh

# ---------- 3. Clean stale time directories & restore initial conditions ----------
# Remove any leftover time directories (> 0) so startFrom latestTime works correctly
echo ""
echo ">>> [cleanCase] Removing stale time directories"
find . -maxdepth 1 -regex './[1-9][0-9.]*' -type d -exec rm -rf {} +
rm -rf processor*
echo "<<< [cleanCase] done"

if [ -d "0.orig" ]; then
    echo ""
    echo ">>> [restore0Dir] Copying 0.orig -> 0"
    rm -rf 0
    cp -r 0.orig 0
    echo "<<< [restore0Dir] done"
fi

# ---------- 4. Release area mapping ----------
if [ -f "constant/releaseArea" ]; then
    run_step "releaseAreaMapping" releaseAreaMapping
fi

# ---------- 5. Run solver ----------
if [ "$NP" -gt 1 ]; then
    # Parallel run
    run_step "decomposePar" decomposePar
    run_step "faSavageHutterFoam" mpirun \
        --allow-run-as-root \
        -np "$NP" \
        faSavageHutterFoam -parallel
    run_step "reconstructPar" reconstructPar
else
    # Serial run
    run_step "faSavageHutterFoam" faSavageHutterFoam
fi

TOTAL_END=$(date +%s)
echo ""
echo "========================================"
echo "  Solver finished"
echo "  Total wall time: $((TOTAL_END - TOTAL_START))s"
echo "========================================"
