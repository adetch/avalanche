# Solver Input/Output JSON Schema

**Schema version:** `schemaVersion = 1`

This document defines the versioned JSON schemas for communication between the
UI/frontend, the Go solver service, and the OpenFOAM solver container. All
messages MUST include `schemaVersion: 1`.

---

## Input Schema

Submitted as the body of `POST /jobs` to the solver service.

```jsonc
{
  "schemaVersion": 1,           // REQUIRED — must be 1
  "dem": { ... },               // Digital elevation model grid
  "releaseCells": [[r,c], ...], // Cells inside starting zone
  "startingZone": { ... },      // GeoJSON Polygon of release area
  "snowDepthM": 1.5,            // Snow depth in meters (> 0)
  "snowProfile": { ... },       // Physical snow parameters
  "regionCoefficients": { ... },// Alpha-beta regression coefficients
  "primaryPath": { ... }        // Primary avalanche path geometry
}
```

### `dem` — Digital Elevation Model

| Field       | Type             | Required | Description                                      |
|-------------|------------------|----------|--------------------------------------------------|
| `origin`    | `[number, number]` | yes    | SW corner `[longitude, latitude]` in WGS84       |
| `cellSize`  | `number`         | yes      | Cell size in meters (typically 15)                |
| `rows`      | `integer`        | yes      | Number of rows (south→north). Range: 1–300       |
| `cols`      | `integer`        | yes      | Number of columns (west→east). Range: 1–300      |
| `elevation` | `number[]`       | yes      | Row-major flat array of elevations in meters. Length = `rows × cols`. `null` for invalid/missing cells (treated as walls). |

**Grid layout:** Row 0 = southernmost, row N-1 = northernmost. Column 0 = westernmost.
Maximum grid size: 300 × 300 = 90,000 cells.

### `releaseCells` — Release Cell Coordinates

| Field          | Type               | Required | Description                                |
|----------------|--------------------|-----------|--------------------------------------------|
| `releaseCells` | `[integer, integer][]` | yes  | Array of `[row, col]` pairs within the DEM |

Each pair must satisfy `0 ≤ row < rows` and `0 ≤ col < cols`. Cells with
`null` elevation are skipped.

### `startingZone` — Release Area Polygon

Standard GeoJSON Polygon:

```jsonc
{
  "type": "Polygon",
  "coordinates": [[[lng, lat], [lng, lat], ...]]  // exterior ring, closed
}
```

### `snowDepthM` — Snow Depth

| Field        | Type     | Required | Range  | Description               |
|--------------|----------|----------|--------|---------------------------|
| `snowDepthM` | `number` | yes      | > 0    | Snow depth in meters      |

### `snowProfile` — Physical Snow Parameters

| Field               | Type     | Required | Range       | Unit           | Description                           |
|---------------------|----------|----------|-------------|----------------|---------------------------------------|
| `id`                | `string` | yes      | —           | —              | Unique identifier                     |
| `label`             | `string` | yes      | —           | —              | Display name                          |
| `density`           | `number` | yes      | 80–450      | kg/m³          | Snow density                          |
| `entrainmentFactor` | `number` | yes      | 1.0–4.0     | dimensionless  | Multiplier on initial volume          |
| `frictionMu`        | `number` | yes      | 0.25–0.45   | dimensionless  | Coulomb friction coefficient          |
| `frictionXi`        | `number` | yes      | 800–2000    | m/s²           | Turbulent friction coefficient        |

### `regionCoefficients` — Alpha-Beta Model

| Field    | Type     | Required | Description                                |
|----------|----------|----------|--------------------------------------------|
| `id`     | `string` | yes      | Unique identifier                          |
| `label`  | `string` | yes      | Display name                               |
| `a`      | `number` | yes      | Slope coefficient                          |
| `b`      | `number` | yes      | Intercept (degrees)                        |
| `sigma`  | `number` | yes      | Standard deviation (degrees)               |
| `source` | `string` | yes      | Literature reference                       |

Formula: `α = a·β + b − k·σ` where `k` depends on return period.

### `primaryPath` — Primary Avalanche Path

| Field             | Type             | Required | Description                              |
|-------------------|------------------|----------|------------------------------------------|
| `crownPoint`      | `ElevationPoint` | yes      | Release zone crown                       |
| `betaPoint`       | `ElevationPoint` | yes      | 10° beta point                           |
| `runoutPoint`     | `ElevationPoint` | yes      | Predicted runout                         |
| `fallLineAzimuth` | `number`         | yes      | Downhill bearing (0–360°)                |
| `betaAngle`       | `number`         | yes      | Slope angle at beta point (degrees)      |
| `alphaAngle`      | `number`         | yes      | Runout angle (degrees)                   |
| `profile`         | `ElevationPoint[]` | yes    | Full elevation profile crown→runout      |

**`ElevationPoint` shape:**

| Field               | Type               | Required | Description                          |
|----------------------|--------------------|----------|--------------------------------------|
| `lngLat`            | `[number, number]` | yes      | `[longitude, latitude]` WGS84       |
| `elevation`         | `number`           | yes      | Meters above sea level               |
| `distanceFromCrown` | `number`           | yes      | Cumulative horizontal distance (m)   |

---

## Output Schema

Returned by `GET /jobs/{id}/results` when job status is `complete`.

```jsonc
{
  "schemaVersion": 1,           // REQUIRED — must be 1
  "origin": [lng, lat],         // Grid origin (SW corner)
  "cellSize": 15,               // meters
  "cols": 200,
  "rows": 150,
  "deposition": [0, 0, 0.5, ...],  // Deposition depth grid
  "vMaxGrid": [0, 0, 12.3, ...],   // Max velocity grid
  "pMaxGrid": [0, 0, 18.9, ...],   // Max impact pressure grid
  "metadata": { ... }              // Solver run metadata
}
```

### Output Grid Fields

| Field        | Type       | Required | Unit    | Description                                              |
|--------------|------------|----------|---------|----------------------------------------------------------|
| `origin`     | `[number, number]` | yes | WGS84  | SW corner `[longitude, latitude]`                        |
| `cellSize`   | `number`   | yes      | meters  | Cell size in meters                                      |
| `cols`       | `integer`  | yes      | —       | Grid width (columns)                                     |
| `rows`       | `integer`  | yes      | —       | Grid height (rows)                                       |
| `deposition` | `number[]` | yes      | meters  | Deposition depth per cell. Flat row-major. Length = `rows × cols`. Values ≥ 0. |
| `vMaxGrid`   | `number[]` | yes      | m/s     | Maximum velocity per cell during simulation. Values ≥ 0. |
| `pMaxGrid`   | `number[]` | yes      | kPa     | Maximum impact pressure per cell (`0.5·ρ·v²/1000`). Values ≥ 0. |

### `metadata` — Solver Run Information

| Field              | Type     | Required | Description                                         |
|--------------------|----------|----------|-----------------------------------------------------|
| `solverVersion`    | `string` | yes      | Solver identifier and version (e.g. `"voellmy-2d@1.0"`) |
| `runtime`          | `number` | yes      | Wall-clock solver execution time in seconds         |
| `steps`            | `integer`| yes      | Number of timesteps executed                        |
| `simulationTime`   | `number` | yes      | Simulated physical time in seconds                  |
| `massConservation` | `number` | yes      | Ratio: `finalMass / initialMass` (expect ~0.8–1.0)  |
| `massInitial`      | `number` | no       | Initial snow mass (m of depth summed across cells)  |
| `massEntrained`    | `number` | no       | Total entrained mass (m)                            |
| `massDeposited`    | `number` | no       | Total deposited mass (m)                            |

---

## Validation Rules

### Required Fields

All fields marked "yes" in the Required column above MUST be present. The
solver service MUST reject input missing any required field with HTTP 400.

### Value Ranges

| Field                       | Constraint                                |
|-----------------------------|-------------------------------------------|
| `schemaVersion`             | Must equal `1`                            |
| `dem.rows`, `dem.cols`      | Positive integers, each ≤ 300             |
| `dem.rows × dem.cols`       | ≤ 90,000                                  |
| `dem.elevation` length      | Must equal `rows × cols`                  |
| `dem.elevation` values      | Finite numbers or `null`                  |
| `dem.cellSize`              | > 0                                       |
| `releaseCells` entries      | Each `[row, col]` within DEM bounds       |
| `releaseCells` length       | ≥ 1                                       |
| `snowDepthM`                | > 0                                       |
| `snowProfile.density`       | 80–450 kg/m³                              |
| `snowProfile.entrainmentFactor` | 1.0–4.0                               |
| `snowProfile.frictionMu`    | 0.25–0.45                                 |
| `snowProfile.frictionXi`    | 800–2000 m/s²                             |
| `deposition` values         | ≥ 0                                       |
| `vMaxGrid` values           | ≥ 0                                       |
| `pMaxGrid` values           | ≥ 0                                       |
| `metadata.massConservation` | > 0                                       |

### Grid Array Encoding

All grid arrays (`elevation`, `deposition`, `vMaxGrid`, `pMaxGrid`) are
**flat row-major**: `array[row * cols + col]`. Row 0 = south, row N-1 = north.

### Coordinate System

All geographic coordinates use **WGS84** (EPSG:4326) as `[longitude, latitude]`.
