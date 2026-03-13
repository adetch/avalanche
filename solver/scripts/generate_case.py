#!/usr/bin/env python3
"""Generate an OpenFOAM case directory from an avalanche solver input JSON.

Reads input.json (schema v1) and produces a complete, runnable OpenFOAM case
by combining the static case-template with generated files:

  - constant/triSurface/terrain.stl   (DEM → STL triangulation)
  - constant/transportProperties       (Voellmy friction parameters)
  - system/controlDict                 (run time, timestep, output)
  - system/blockMeshDict               (domain bounding box mesh)
  - system/decomposeParDict            (MPI decomposition)
  - 0/h                                (initial flow depth from releaseCells)
  - 0/Us                               (initial velocity — zero)

Usage:
    python generate_case.py input.json output_dir/
    python generate_case.py --template /path/to/case-template input.json output_dir/
"""
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import struct
import sys
from pathlib import Path
from typing import Any

FOAM_HEADER = """\
FoamFile
{{
    version     2.0;
    format      {fmt};
    class       {cls};
    object      {obj};
}}
"""

DEFAULT_TEMPLATE_DIR = Path(__file__).resolve().parent.parent / "case-template"


# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------

def validate_input(data: dict[str, Any]) -> list[str]:
    """Return a list of validation errors (empty = valid)."""
    errors: list[str] = []

    if data.get("schemaVersion") != 1:
        errors.append("schemaVersion must be 1")

    dem = data.get("dem")
    if not isinstance(dem, dict):
        errors.append("dem is required and must be an object")
        return errors  # can't validate further

    for field in ("origin", "cellSize", "rows", "cols", "elevation"):
        if field not in dem:
            errors.append(f"dem.{field} is required")
    if errors:
        return errors

    rows, cols = dem["rows"], dem["cols"]
    if not (1 <= rows <= 300 and 1 <= cols <= 300):
        errors.append(f"dem.rows/cols must be 1–300, got {rows}x{cols}")
    if rows * cols > 90_000:
        errors.append(f"dem grid exceeds 90,000 cells ({rows * cols})")
    elev = dem["elevation"]
    if len(elev) != rows * cols:
        errors.append(f"elevation length {len(elev)} != rows*cols {rows * cols}")

    if dem["cellSize"] <= 0:
        errors.append("dem.cellSize must be > 0")

    release = data.get("releaseCells")
    if not release or len(release) == 0:
        errors.append("releaseCells must have at least one entry")
    else:
        for rc in release:
            r, c = rc
            if not (0 <= r < rows and 0 <= c < cols):
                errors.append(f"releaseCells entry [{r},{c}] out of DEM bounds")

    depth = data.get("snowDepthM")
    if depth is None or depth <= 0:
        errors.append("snowDepthM must be > 0")

    sp = data.get("snowProfile")
    if not isinstance(sp, dict):
        errors.append("snowProfile is required")
    else:
        if not (0.25 <= sp.get("frictionMu", -1) <= 0.45):
            errors.append("snowProfile.frictionMu must be 0.25–0.45")
        if not (800 <= sp.get("frictionXi", -1) <= 2000):
            errors.append("snowProfile.frictionXi must be 800–2000")
        if not (80 <= sp.get("density", -1) <= 450):
            errors.append("snowProfile.density must be 80–450")
        if not (1.0 <= sp.get("entrainmentFactor", -1) <= 4.0):
            errors.append("snowProfile.entrainmentFactor must be 1.0–4.0")

    return errors


# ---------------------------------------------------------------------------
# DEM → STL terrain surface
# ---------------------------------------------------------------------------

def dem_to_stl_binary(dem: dict[str, Any]) -> bytes:
    """Convert a row-major DEM grid to a binary STL surface.

    Each grid quad is split into two triangles.  Null/NaN cells are skipped.
    Coordinates are local meters: x = col*cellSize, y = row*cellSize, z = elev.
    """
    rows = dem["rows"]
    cols = dem["cols"]
    cs = dem["cellSize"]
    elev = dem["elevation"]

    def z(r: int, c: int) -> float | None:
        v = elev[r * cols + c]
        if v is None or (isinstance(v, float) and math.isnan(v)):
            return None
        return float(v)

    triangles: list[tuple[tuple[float, ...], ...]] = []

    for r in range(rows - 1):
        for c in range(cols - 1):
            # Four corners of quad
            z00 = z(r, c)
            z10 = z(r + 1, c)
            z01 = z(r, c + 1)
            z11 = z(r + 1, c + 1)
            if any(v is None for v in (z00, z10, z01, z11)):
                continue

            x0, x1 = c * cs, (c + 1) * cs
            y0, y1 = r * cs, (r + 1) * cs

            # Lower-left triangle: (0,0) (1,0) (1,1)
            triangles.append((
                (x0, y0, z00), (x1, y0, z01), (x1, y1, z11)
            ))
            # Upper-left triangle: (0,0) (1,1) (0,1)
            triangles.append((
                (x0, y0, z00), (x1, y1, z11), (x0, y1, z10)
            ))

    # Binary STL format
    header = b"\x00" * 80
    num_triangles = len(triangles)
    buf = bytearray(header)
    buf += struct.pack("<I", num_triangles)

    for v0, v1, v2 in triangles:
        # Compute face normal via cross product
        ux, uy, uz = v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]
        wx, wy, wz = v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]
        nx = uy * wz - uz * wy
        ny = uz * wx - ux * wz
        nz = ux * wy - uy * wx
        mag = math.sqrt(nx * nx + ny * ny + nz * nz)
        if mag > 0:
            nx, ny, nz = nx / mag, ny / mag, nz / mag

        buf += struct.pack("<3f", nx, ny, nz)
        for v in (v0, v1, v2):
            buf += struct.pack("<3f", v[0], v[1], v[2])
        buf += struct.pack("<H", 0)  # attribute byte count

    return bytes(buf)


# ---------------------------------------------------------------------------
# OpenFOAM file generators
# ---------------------------------------------------------------------------

def foam_header(fmt: str, cls: str, obj: str) -> str:
    return FOAM_HEADER.format(fmt=fmt, cls=cls, obj=obj)


def generate_control_dict(dem: dict, path_data: dict | None) -> str:
    """Generate system/controlDict with computed end time and timestep."""
    rows, cols, cs = dem["rows"], dem["cols"], dem["cellSize"]
    domain_length = max(rows, cols) * cs

    # Estimate end time from path length or domain diagonal
    if path_data and "runoutPoint" in path_data:
        path_length = path_data["runoutPoint"].get("distanceFromCrown", domain_length)
    else:
        path_length = domain_length
    # Avalanche traversal at ~15 m/s with 2x safety margin
    end_time = max(30.0, min(300.0, 2.0 * path_length / 15.0))

    # CFL-based initial timestep (conservative)
    delta_t = cs / 100.0
    # Write every ~5 s of simulation time
    write_interval = max(1.0, round(end_time / 10.0, 1))

    return (
        foam_header("ascii", "dictionary", "controlDict")
        + f"""
application     faSavageHutterFoam;

startFrom       latestTime;
startTime       0;

stopAt          endTime;
endTime         {end_time:.1f};

deltaT          {delta_t:.4f};

writeControl    adjustableRunTime;
writeInterval   {write_interval:.1f};

purgeWrite      0;

writeFormat     ascii;
writePrecision  8;
writeCompression off;

timeFormat      general;
timePrecision   6;

runTimeModifiable yes;

adjustTimeStep  yes;
initDeltaT      yes;
maxCo           1.0;
maxDeltaT       0.1;
"""
    )


def generate_block_mesh_dict(dem: dict) -> str:
    """Generate system/blockMeshDict — flat bounding box mesh.

    After blockMesh runs, the entrypoint runs a point-displacement step
    to move the terrain patch vertices to follow the DEM elevation.
    """
    rows, cols, cs = dem["rows"], dem["cols"], dem["cellSize"]
    elev = dem["elevation"]

    valid_elev = [e for e in elev if e is not None and not (isinstance(e, float) and math.isnan(e))]
    z_min = min(valid_elev) - 50.0
    z_max = max(valid_elev) + 100.0

    x_max = (cols - 1) * cs
    y_max = (rows - 1) * cs

    nx = max(1, cols - 1)
    ny = max(1, rows - 1)
    nz = 1

    return (
        foam_header("ascii", "dictionary", "blockMeshDict")
        + f"""
scale   1;

vertices
(
    (0      0      {z_min:.2f})   // 0
    ({x_max:.2f}  0      {z_min:.2f})   // 1
    ({x_max:.2f}  {y_max:.2f}  {z_min:.2f})   // 2
    (0      {y_max:.2f}  {z_min:.2f})   // 3
    (0      0      {z_max:.2f})   // 4
    ({x_max:.2f}  0      {z_max:.2f})   // 5
    ({x_max:.2f}  {y_max:.2f}  {z_max:.2f})   // 6
    (0      {y_max:.2f}  {z_max:.2f})   // 7
);

blocks
(
    hex (0 1 2 3 4 5 6 7) ({nx} {ny} {nz}) simpleGrading (1 1 1)
);

edges
(
);

boundary
(
    terrain
    {{
        type    wall;
        faces
        (
            (4 5 6 7)
        );
    }}
    ground
    {{
        type    wall;
        faces
        (
            (0 3 2 1)
        );
    }}
    sides
    {{
        type    patch;
        faces
        (
            (0 1 5 4)
            (1 2 6 5)
            (2 3 7 6)
            (3 0 4 7)
        );
    }}
);
"""
    )


def generate_terrain_displacement_script(dem: dict) -> str:
    """Generate a Python script that moves terrain patch points to follow DEM elevation.

    This runs inside the container after blockMesh to deform the flat mesh.
    """
    rows, cols, cs = dem["rows"], dem["cols"], dem["cellSize"]
    elev = dem["elevation"]

    # Build elevation lookup: for each (x, y) grid point, the target z
    elev_map = {}
    for r in range(rows):
        for c in range(cols):
            v = elev[r * cols + c]
            if v is not None and not (isinstance(v, float) and math.isnan(v)):
                x, y = round(c * cs, 4), round(r * cs, 4)
                elev_map[f"{x},{y}"] = float(v)

    lines = [
        "#!/usr/bin/env python3",
        '"""Move terrain patch vertices to DEM elevations in an OpenFOAM polyMesh."""',
        "import os, re, sys",
        "",
        "case_dir = sys.argv[1] if len(sys.argv) > 1 else '/case'",
        "points_path = os.path.join(case_dir, 'constant', 'polyMesh', 'points')",
        "",
        "# DEM elevation lookup",
        "elev = {",
    ]
    for key, z in elev_map.items():
        lines.append(f'    "{key}": {z},')
    lines += [
        "}",
        "",
        "# Read points file",
        "with open(points_path) as f:",
        "    content = f.read()",
        "",
        "# Find the points list",
        "m = re.search(r'\\n(\\d+)\\n\\(\\n', content)",
        "if not m:",
        "    print('ERROR: cannot parse points file'); sys.exit(1)",
        "",
        "header = content[:m.start() + 1]",
        "n_points = int(m.group(1))",
        "rest = content[m.end():]",
        "end_idx = rest.index('\\n)\\n')",
        "points_text = rest[:end_idx]",
        "footer = rest[end_idx:]",
        "",
        "# Parse and modify points",
        "new_points = []",
        "for line in points_text.strip().split('\\n'):",
        "    line = line.strip().strip('()')",
        "    x, y, z = [float(v) for v in line.split()]",
        "    key = f'{round(x,4)},{round(y,4)}'",
        "    if key in elev:",
        "        z = elev[key]",
        "    new_points.append(f'({x} {y} {z})')",
        "",
        "with open(points_path, 'w') as f:",
        "    f.write(header + str(n_points) + '\\n(\\n')",
        "    f.write('\\n'.join(new_points))",
        "    f.write(footer)",
        "",
        "print(f'Displaced {len(elev)} terrain points')",
    ]
    return "\n".join(lines) + "\n"


def generate_displaced_points(dem: dict, output_dir: Path) -> None:
    """Pre-generate the displaced points file for the terrain-following mesh.

    After blockMesh creates a flat mesh, the entrypoint replaces
    constant/polyMesh/points with this pre-computed version where
    the top-layer z-coordinates follow the DEM elevation.

    blockMesh with nz=1 creates points in this order:
    - Bottom layer (z=z_min): for j in 0..ny: for i in 0..nx: point(i*dx, j*dy, z_min)
    - Top layer (z=z_max):    for j in 0..ny: for i in 0..nx: point(i*dx, j*dy, z_max)
    Total: 2 * (nx+1) * (ny+1) = 2 * cols * rows points
    """
    rows, cols, cs = dem["rows"], dem["cols"], dem["cellSize"]
    elev = dem["elevation"]

    valid_elev = [e for e in elev if e is not None and not (isinstance(e, float) and math.isnan(e))]
    z_min = min(valid_elev) - 50.0

    def get_elev(r: int, c: int) -> float:
        v = elev[r * cols + c]
        if v is None or (isinstance(v, float) and math.isnan(v)):
            return z_min + 25.0
        return float(v)

    points: list[str] = []
    # Bottom layer
    for r in range(rows):
        for c in range(cols):
            x, y = c * cs, r * cs
            points.append(f"({x} {y} {z_min})")
    # Top layer — follow DEM
    for r in range(rows):
        for c in range(cols):
            x, y = c * cs, r * cs
            z = get_elev(r, c)
            points.append(f"({x} {y} {z})")

    content = (
        foam_header("ascii", "vectorField", "points")
        + f"\n{len(points)}\n(\n"
        + "\n".join(points)
        + "\n)\n"
    )

    displaced_dir = output_dir / "displaced"
    displaced_dir.mkdir(exist_ok=True)
    (displaced_dir / "points").write_text(content)


def _unused_generate_poly_mesh(dem: dict, output_dir: Path) -> None:
    """[UNUSED] Generate constant/polyMesh/ directly with terrain-following top face.

    Creates a single-layer hex mesh where the top vertices follow DEM elevation,
    so the finite-area mesh on the terrain patch captures real slope gradients.
    """
    rows, cols, cs = dem["rows"], dem["cols"], dem["cellSize"]
    elev = dem["elevation"]

    valid_elev = [e for e in elev if e is not None and not (isinstance(e, float) and math.isnan(e))]
    z_offset = min(valid_elev) - 10.0  # ground layer below terrain

    def get_elev(r: int, c: int) -> float:
        v = elev[r * cols + c]
        if v is None or (isinstance(v, float) and math.isnan(v)):
            return z_offset + 5.0  # fallback for NaN
        return float(v)

    # Vertices: bottom layer (rows*cols) + top layer (rows*cols)
    # bottom[r*cols+c] at (c*cs, r*cs, z_offset)
    # top[r*cols+c]    at (c*cs, r*cs, elev[r,c])
    n_pts = rows * cols
    points: list[str] = []
    for r in range(rows):
        for c in range(cols):
            x, y = c * cs, r * cs
            points.append(f"({x} {y} {z_offset})")
    for r in range(rows):
        for c in range(cols):
            x, y = c * cs, r * cs
            z = get_elev(r, c)
            points.append(f"({x} {y} {z})")

    # Cells: (rows-1)*(cols-1) hexahedra
    nr, nc = rows - 1, cols - 1
    n_cells = nr * nc

    # Face enumeration:
    # Internal faces (vertical internal walls between cells):
    #   - x-direction internal: (nc-1)*nr faces
    #   - y-direction internal: nc*(nr-1) faces
    # Boundary faces:
    #   terrain: nr*nc top faces
    #   ground:  nr*nc bottom faces
    #   sides:   2*nr + 2*nc side faces
    n_internal_x = (nc - 1) * nr
    n_internal_y = nc * (nr - 1)
    n_internal = n_internal_x + n_internal_y
    n_terrain = n_cells
    n_ground = n_cells
    n_sides = 2 * nr + 2 * nc

    def bot(r: int, c: int) -> int:
        return r * cols + c

    def top(r: int, c: int) -> int:
        return n_pts + r * cols + c

    def cell_idx(r: int, c: int) -> int:
        return r * nc + c

    faces: list[str] = []
    owner: list[int] = []
    neighbour: list[int] = []

    # OpenFOAM face orientation rules:
    # - Internal faces: normal points from owner (lower index) to neighbour (higher index)
    # - Boundary faces: normal points outward from the cell
    # Face normal = right-hand rule on vertex ordering (CCW when viewed from normal direction)

    # Internal faces in x-direction (between cell(r,c) and cell(r,c+1))
    # Normal should point in +x direction (from cell(r,c) to cell(r,c+1))
    for r in range(nr):
        for c in range(nc - 1):
            # Face at x = (c+1)*cs, normal in +x: vertices CCW when viewed from +x
            f = [bot(r, c + 1), top(r, c + 1), top(r + 1, c + 1), bot(r + 1, c + 1)]
            faces.append(f"4({f[0]} {f[1]} {f[2]} {f[3]})")
            owner.append(cell_idx(r, c))
            neighbour.append(cell_idx(r, c + 1))

    # Internal faces in y-direction (between cell(r,c) and cell(r+1,c))
    # Normal should point in +y direction (from cell(r,c) to cell(r+1,c))
    for r in range(nr - 1):
        for c in range(nc):
            # Face at y = (r+1)*cs, normal in +y: vertices CCW when viewed from +y
            f = [bot(r + 1, c), bot(r + 1, c + 1), top(r + 1, c + 1), top(r + 1, c)]
            faces.append(f"4({f[0]} {f[1]} {f[2]} {f[3]})")
            owner.append(cell_idx(r, c))
            neighbour.append(cell_idx(r + 1, c))

    # Terrain faces (top of each cell) — outward normal points up
    # CCW when viewed from above (+z direction)
    for r in range(nr):
        for c in range(nc):
            f = [top(r, c), top(r + 1, c), top(r + 1, c + 1), top(r, c + 1)]
            faces.append(f"4({f[0]} {f[1]} {f[2]} {f[3]})")
            owner.append(cell_idx(r, c))

    # Ground faces (bottom of each cell) — outward normal points down (-z)
    # CCW when viewed from below (-z direction)
    for r in range(nr):
        for c in range(nc):
            f = [bot(r, c), bot(r, c + 1), bot(r + 1, c + 1), bot(r + 1, c)]
            faces.append(f"4({f[0]} {f[1]} {f[2]} {f[3]})")
            owner.append(cell_idx(r, c))

    # Side faces — outward normals point away from domain
    # minY (r=0): normal in -y direction, CCW when viewed from -y
    for c in range(nc):
        f = [bot(0, c), top(0, c), top(0, c + 1), bot(0, c + 1)]
        faces.append(f"4({f[0]} {f[1]} {f[2]} {f[3]})")
        owner.append(cell_idx(0, c))
    # maxY (r=nr): normal in +y direction, CCW when viewed from +y
    for c in range(nc):
        f = [bot(nr, c), bot(nr, c + 1), top(nr, c + 1), top(nr, c)]
        faces.append(f"4({f[0]} {f[1]} {f[2]} {f[3]})")
        owner.append(cell_idx(nr - 1, c))
    # minX (c=0): normal in -x direction, CCW when viewed from -x
    for r in range(nr):
        f = [bot(r, 0), bot(r + 1, 0), top(r + 1, 0), top(r, 0)]
        faces.append(f"4({f[0]} {f[1]} {f[2]} {f[3]})")
        owner.append(cell_idx(r, 0))
    # maxX (c=nc): normal in +x direction, CCW when viewed from +x
    for r in range(nr):
        f = [bot(r, nc), top(r, nc), top(r + 1, nc), bot(r + 1, nc)]
        faces.append(f"4({f[0]} {f[1]} {f[2]} {f[3]})")
        owner.append(cell_idx(r, nc - 1))

    n_faces_total = len(faces)

    # Write polyMesh files
    mesh_dir = output_dir / "constant" / "polyMesh"
    mesh_dir.mkdir(parents=True, exist_ok=True)

    # points
    (mesh_dir / "points").write_text(
        foam_header("ascii", "vectorField", "points")
        + f"\n{len(points)}\n(\n"
        + "\n".join(points)
        + "\n)\n"
    )

    # faces
    (mesh_dir / "faces").write_text(
        foam_header("ascii", "faceList", "faces")
        + f"\n{n_faces_total}\n(\n"
        + "\n".join(faces)
        + "\n)\n"
    )

    # owner
    (mesh_dir / "owner").write_text(
        foam_header("ascii", "labelList", "owner")
        + f"\n{n_faces_total}\n(\n"
        + "\n".join(str(o) for o in owner)
        + "\n)\n"
    )

    # neighbour (only internal faces)
    (mesh_dir / "neighbour").write_text(
        foam_header("ascii", "labelList", "neighbour")
        + f"\n{n_internal}\n(\n"
        + "\n".join(str(n) for n in neighbour)
        + "\n)\n"
    )

    # boundary
    terrain_start = n_internal
    ground_start = terrain_start + n_terrain
    sides_start = ground_start + n_ground

    (mesh_dir / "boundary").write_text(
        foam_header("ascii", "polyBoundaryMesh", "boundary")
        + f"""
3
(
    terrain
    {{
        type            wall;
        nFaces          {n_terrain};
        startFace       {terrain_start};
    }}
    ground
    {{
        type            wall;
        nFaces          {n_ground};
        startFace       {ground_start};
    }}
    sides
    {{
        type            patch;
        nFaces          {n_sides};
        startFace       {sides_start};
    }}
)
"""
    )


def generate_decompose_par_dict(n_procs: int = 4) -> str:
    """Generate system/decomposeParDict for scotch decomposition."""
    return (
        foam_header("ascii", "dictionary", "decomposeParDict")
        + f"""
numberOfSubdomains  {n_procs};

method          scotch;
"""
    )


def generate_transport_properties(snow_profile: dict, entrainment_factor: float) -> str:
    """Generate constant/transportProperties with Voellmy parameters.

    Format must match faSavageHutterFoam expectations:
    frictionModel, entrainmentModel, depositionModel, and VoellmyCoeffs block.
    """
    mu = snow_profile["frictionMu"]
    xi = snow_profile["frictionXi"]
    density = snow_profile["density"]

    return (
        foam_header("ascii", "dictionary", "transportProperties")
        + f"""
pressureFeedback    off;

explicitDryAreas    on;

xi                  xi     [ 0 0 0 0 0 0 0]     1;

hmin                hmin   [ 0 1 0 0 0 0 0]     0;

rho                 rho    [ 1 -3  0 0 0 0 0 ]  {density:.1f};

u0                  u0     [ 0 1 -1 0 0 0 0]    1e-4;

h0                  h0     [ 0 1 0 0 0 0 0]     1e-6;

frictionModel       Voellmy;

entrainmentModel    entrainmentOff;

depositionModel     depositionOff;

VoellmyCoeffs
{{
    mu              mu    [0 0 0 0 0 0 0 ]      {mu};

    xi              xi    [0 1 -2 0 0 0 0 ]     {xi};
}}
"""
    )


def generate_h_field(dem: dict, release_cells: list[list[int]], snow_depth: float) -> str:
    """Generate 0/h — initial flow depth field on the finite-area mesh.

    Sets h = snowDepthM at release cells, 0 elsewhere.
    The field is areaScalarField for finite-area method.
    """
    rows, cols = dem["rows"], dem["cols"]
    n_faces = (rows - 1) * (cols - 1)  # one quad face per blockMesh cell on terrain patch

    # Build a set of quads that contain release cells
    release_set = set()
    for rc in release_cells:
        release_set.add((rc[0], rc[1]))

    # Map release cells to quad face indices on the terrain patch.
    # blockMesh produces (cols-1)*(rows-1) quad faces on the terrain patch.
    # quad_idx = r * (cols-1) + c  (for r in 0..rows-2, c in 0..cols-2)
    release_face_indices: set[int] = set()
    for r, c in release_set:
        # A release cell (r, c) touches up to 4 quads:
        # quad(r-1, c-1), quad(r-1, c), quad(r, c-1), quad(r, c)
        for qr in (r - 1, r):
            for qc in (c - 1, c):
                if 0 <= qr < rows - 1 and 0 <= qc < cols - 1:
                    qi = qr * (cols - 1) + qc
                    release_face_indices.add(qi)

    # Build nonuniform field value list
    values = []
    for i in range(n_faces):
        if i in release_face_indices:
            values.append(snow_depth)
        else:
            values.append(0.0)

    value_lines = "\n".join(f"    {v}" for v in values)

    return (
        foam_header("ascii", "areaScalarField", "h")
        + f"""
dimensions      [0 1 0 0 0 0 0];

internalField   nonuniform List<scalar>
{n_faces}
(
{value_lines}
)
;

boundaryField
{{
    outline
    {{
        type            zeroGradient;
    }}
}}
"""
    )


def generate_us_field(dem: dict) -> str:
    """Generate 0/Us — initial velocity field (zero everywhere)."""
    return (
        foam_header("ascii", "areaVectorField", "Us")
        + """
dimensions      [0 1 -1 0 0 0 0];

internalField   uniform (0 0 0);

boundaryField
{
    outline
    {
        type            zeroGradient;
    }
}
"""
    )


# ---------------------------------------------------------------------------
# Main case generation
# ---------------------------------------------------------------------------

def generate_case(
    input_path: str | Path,
    output_dir: str | Path,
    template_dir: str | Path | None = None,
    n_procs: int = 4,
) -> Path:
    """Generate a complete OpenFOAM case directory from solver input JSON.

    Args:
        input_path: Path to input.json (schema v1).
        output_dir: Destination case directory (created if missing).
        template_dir: Path to case-template/ skeleton. Defaults to
            solver/case-template/ relative to this script.
        n_procs: MPI processes for decomposeParDict.

    Returns:
        Path to the generated case directory.

    Raises:
        ValueError: If input validation fails.
        FileNotFoundError: If input or template path doesn't exist.
    """
    input_path = Path(input_path)
    output_dir = Path(output_dir)
    template_dir = Path(template_dir) if template_dir else DEFAULT_TEMPLATE_DIR

    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")
    if not template_dir.exists():
        raise FileNotFoundError(f"Case template not found: {template_dir}")

    # Load and validate input
    with open(input_path) as f:
        data = json.load(f)

    errors = validate_input(data)
    if errors:
        raise ValueError("Input validation failed:\n  " + "\n  ".join(errors))

    dem = data["dem"]
    snow_profile = data["snowProfile"]
    release_cells = data["releaseCells"]
    snow_depth = data["snowDepthM"]
    primary_path = data.get("primaryPath")

    # Create output directory and copy static template
    if output_dir.exists():
        shutil.rmtree(output_dir)
    shutil.copytree(template_dir, output_dir)

    # Create subdirectories for generated files
    (output_dir / "0").mkdir(parents=True, exist_ok=True)

    # Copy input.json into case for provenance
    shutil.copy2(input_path, output_dir / "input.json")

    # --- Generate system files ---
    (output_dir / "system" / "blockMeshDict").write_text(
        generate_block_mesh_dict(dem)
    )
    (output_dir / "system" / "controlDict").write_text(
        generate_control_dict(dem, primary_path)
    )

    # --- Pre-generate displaced points file ---
    # blockMesh will create constant/polyMesh/points with flat terrain.
    # We pre-compute the terrain-following points and save them; the entrypoint
    # swaps them in after blockMesh runs.
    generate_displaced_points(dem, output_dir)
    (output_dir / "system" / "decomposeParDict").write_text(
        generate_decompose_par_dict(n_procs)
    )

    # --- Generate constant files ---
    (output_dir / "constant" / "transportProperties").write_text(
        generate_transport_properties(snow_profile, snow_profile["entrainmentFactor"])
    )

    # --- Generate initial conditions ---
    (output_dir / "0" / "h").write_text(
        generate_h_field(dem, release_cells, snow_depth)
    )
    (output_dir / "0" / "Us").write_text(
        generate_us_field(dem)
    )

    return output_dir


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate an OpenFOAM avalanche case from input JSON."
    )
    parser.add_argument("input", help="Path to input.json (schema v1)")
    parser.add_argument("output", help="Output case directory")
    parser.add_argument(
        "--template",
        default=None,
        help="Path to case-template/ (default: solver/case-template/)",
    )
    parser.add_argument(
        "--nprocs",
        type=int,
        default=4,
        help="MPI processes for decomposeParDict (default: 4)",
    )
    args = parser.parse_args()

    try:
        case_dir = generate_case(args.input, args.output, args.template, args.nprocs)
        print(f"Case generated: {case_dir}")

        # Summary
        files = sorted(case_dir.rglob("*"))
        dirs = [f for f in files if f.is_dir()]
        regular = [f for f in files if f.is_file()]
        print(f"  {len(dirs)} directories, {len(regular)} files")
        for f in regular:
            size = f.stat().st_size
            print(f"  {f.relative_to(case_dir)}  ({size:,} bytes)")
    except (ValueError, FileNotFoundError) as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
