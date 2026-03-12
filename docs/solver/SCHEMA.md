# Solver Input/Output Schema — v1

All requests and responses use JSON. Grid arrays are row-major (south-to-north, west-to-east): `value[row * cols + col]`.

---

## Input (`POST /jobs`)

```jsonc
{
  "schemaVersion": 1,

  // --- DEM ---
  "dem": {
    "origin": [lng, lat],      // SW corner (WGS-84)
    "cellSize": 15,            // meters
    "cols": 200,
    "rows": 150,
    "elevation": [...]         // row-major Float32, length = rows × cols
                               // NaN = out-of-bounds / no-data (treated as wall)
  },

  // --- Release ---
  "releaseCells": [[row, col], ...],  // grid cells inside the starting zone
  "snowDepthM": 1.5,                 // uniform initial snow depth (meters)

  // --- Friction (Voellmy model) ---
  "frictionMu": 0.3,          // Coulomb friction coefficient
  "frictionXi": 1500,         // turbulent friction (m/s²)

  // --- Snow properties ---
  "density": 250,             // kg/m³
  "entrainmentFactor": 2.0,   // multiplier on initial volume for entrainment target

  // --- Simulation control ---
  "maxTime": 120              // max physical time (seconds)
}
```

### Field reference

| Field               | Type              | Required | Description                                      |
| ------------------- | ----------------- | -------- | ------------------------------------------------ |
| `schemaVersion`     | `integer`         | yes      | Must be `1`                                      |
| `dem.origin`        | `[number, number]`| yes      | SW corner `[lng, lat]` in WGS-84                 |
| `dem.cellSize`      | `number`          | yes      | Grid cell size in meters                         |
| `dem.cols`          | `integer`         | yes      | Number of columns                                |
| `dem.rows`          | `integer`         | yes      | Number of rows                                   |
| `dem.elevation`     | `number[]`        | yes      | Row-major elevations; NaN for no-data            |
| `releaseCells`      | `[int, int][]`    | yes      | `[row, col]` pairs inside starting zone          |
| `snowDepthM`        | `number`          | yes      | Initial snow depth in meters (>0)                |
| `frictionMu`        | `number`          | yes      | Coulomb friction (typical 0.15–0.55)             |
| `frictionXi`        | `number`          | yes      | Turbulent friction in m/s² (typical 500–2500)    |
| `density`           | `number`          | yes      | Snow density in kg/m³ (typical 80–500)           |
| `entrainmentFactor` | `number`          | yes      | Entrainment target as multiple of initial volume |
| `maxTime`           | `number`          | no       | Max physical simulation time; default 120 s      |

### Validation rules

- `dem.cols * dem.rows` must not exceed 90,000.
- `releaseCells` entries must be within grid bounds.
- `snowDepthM > 0`, `frictionMu > 0`, `frictionXi > 0`, `density > 0`.
- `entrainmentFactor >= 1.0` (1.0 = no entrainment).

---

## Output (`GET /jobs/{id}/results`)

```jsonc
{
  "schemaVersion": 1,

  // --- Grid metadata (echo from input) ---
  "origin": [lng, lat],
  "cellSize": 15,
  "cols": 200,
  "rows": 150,

  // --- Result grids (row-major, length = rows × cols) ---
  "deposition": [...],    // final flow depth in meters
  "hMax":       [...],    // maximum flow depth at each cell (meters)
  "vMax":       [...],    // maximum velocity at each cell (m/s)
  "pMax":       [...],    // maximum impact pressure at each cell (kPa)
  "cellCount":  [...],    // 1 if cell was reached (hMax > 1mm), else 0

  // --- Solver metadata ---
  "solverInfo": {
    "type": "openfoam",
    "simulationTime": 45.2,       // physical seconds simulated
    "timeSteps": 312,
    "wallClockSeconds": 23.4,     // actual compute time
    "massConservation": 0.998,    // ratio final/initial mass
    "massInitial": 12.5,          // meters (depth equivalent)
    "massEntrained": 8.3,         // meters
    "massDeposited": 20.6,        // meters
    "massBalanceError": 0.002,    // relative error
    "solverVersion": "v2312-abc1234"
  }
}
```

### Output field reference

| Field                          | Type       | Description                                            |
| ------------------------------ | ---------- | ------------------------------------------------------ |
| `deposition`                   | `number[]` | Final snow depth per cell (meters)                     |
| `hMax`                         | `number[]` | Peak depth reached during simulation (meters)          |
| `vMax`                         | `number[]` | Peak velocity per cell (m/s)                           |
| `pMax`                         | `number[]` | Peak impact pressure per cell (kPa = 0.5·ρ·v²/1000)   |
| `cellCount`                    | `integer[]`| Binary reach indicator (1 = reached, 0 = not)          |
| `solverInfo.type`              | `string`   | Always `"openfoam"` for this solver                    |
| `solverInfo.simulationTime`    | `number`   | Physical time simulated (seconds)                      |
| `solverInfo.timeSteps`         | `number`   | Number of solver time steps                            |
| `solverInfo.wallClockSeconds`  | `number`   | Wall-clock compute duration                            |
| `solverInfo.massConservation`  | `number`   | Final/initial mass ratio (ideal = 1.0)                 |
| `solverInfo.massInitial`       | `number`   | Total initial release mass (depth-equivalent meters)   |
| `solverInfo.massEntrained`     | `number`   | Total entrained mass (depth-equivalent meters)         |
| `solverInfo.massDeposited`     | `number`   | Total deposited mass (depth-equivalent meters)         |
| `solverInfo.massBalanceError`  | `number`   | Relative mass balance error                            |
| `solverInfo.solverVersion`     | `string`   | OpenFOAM version + solver commit                       |

### Compatibility with existing UI

The output maps directly to the app's `FlowPyGridResult` type:

| Schema field  | FlowPyGridResult field | Notes                              |
| ------------- | ---------------------- | ---------------------------------- |
| `deposition`  | `deposition`           | Direct: meters                     |
| `hMax`        | `hMax`                 | Direct: meters                     |
| `vMax`        | `vMaxGrid`             | Rename on load                     |
| `pMax`        | `pMaxGrid`             | Rename on load                     |
| `cellCount`   | `cellCount`            | Direct: cast to Uint16Array        |
| `solverInfo`  | `solverInfo`           | Direct: `type = "openfoam"`        |

The legacy fields `zMaxDelta` and `rMax` are not produced by OpenFOAM. The UI already handles their absence when `solverInfo.type !== "flow-py"`.
