# Output Format Mapping: OpenFOAM → FlowPyGridResult

This document describes how OpenFOAM solver output is converted to the app's
`FlowPyGridResult` JSON shape (`schemaVersion = 1`).

## OpenFOAM Output Structure

The `faSavageHutterFoam` solver writes results to time directories within the
case directory:

```
caseDir/
  input.json              ← original job input (grid geometry source)
  0/
    h                     ← initial depth field (areaScalarField)
    Us                    ← initial velocity field (areaVectorField)
  <time>/                 ← e.g., "45.2" (final simulation time)
    h                     ← deposition depth (areaScalarField, meters)
    Us                    ← surface velocity (areaVectorField, m/s)
  constant/
  system/
```

The converter reads the **latest time directory** (highest numeric directory
name, excluding "0") to extract final-state fields.

## Field Mapping

| OpenFOAM Field  | Type              | → Result Field   | Unit   | Notes                                 |
|-----------------|-------------------|------------------|--------|---------------------------------------|
| `<time>/h`      | areaScalarField   | `deposition`     | meters | Final flow depth = deposition depth   |
| `<time>/Us`     | areaVectorField   | `vMaxGrid`       | m/s    | Velocity magnitude: `√(vx² + vy²)`   |
| (computed)      | —                 | `pMaxGrid`       | kPa    | `0.5 · ρ · v² / 1000`                |
| `0/h`           | areaScalarField   | (mass tracking)  | meters | Used for `massConservation` ratio     |

### Pressure Calculation

Impact pressure is computed from velocity and snow density:

```
pMaxGrid[i] = 0.5 × density × vMaxGrid[i]² / 1000
```

Where:
- `density` is `snowProfile.density` from the input (kg/m³)
- Result is in kPa

### Mass Conservation

```
massConservation = sum(deposition) / sum(h₀)
```

Where `h₀` is the initial depth field from `0/h`. If the initial field is
unavailable, `massConservation` defaults to `1.0`.

## OpenFOAM ASCII Format

### Scalar Field (e.g., `h`)

```
FoamFile
{
    version     2.0;
    format      ascii;
    class       areaScalarField;
    object      h;
}
dimensions      [0 1 0 0 0 0 0];

internalField   nonuniform List<scalar>
48
(
0.42
0.65
...
)
;
```

Or uniform: `internalField   uniform 0;`

### Vector Field (e.g., `Us`)

```
FoamFile
{
    version     2.0;
    format      ascii;
    class       areaVectorField;
    object      Us;
}
dimensions      [0 1 -1 0 0 0 0];

internalField   nonuniform List<vector>
48
(
(2.1 0.0 0.0)
(3.0 2.4 0.0)
...
)
;
```

## Grid Geometry

Grid geometry (origin, cellSize, rows, cols) is read from `input.json` in the
case directory — it is **not** stored in the OpenFOAM output.

- **Cell ordering**: OpenFOAM cell indices map 1:1 to the flat row-major array.
  Cell `i` corresponds to `array[row * cols + col]`.
- **Row 0** = southernmost (minimum latitude)
- **Col 0** = westernmost (minimum longitude)
- **Origin**: SW corner `[longitude, latitude]` in WGS84

## Output JSON Schema

Written to `result.json`:

```json
{
  "schemaVersion": 1,
  "origin": [-116.8425, 51.042],
  "cellSize": 15,
  "cols": 6,
  "rows": 8,
  "deposition": [0.42, 0.65, ...],
  "vMaxGrid": [2.1, 3.84, ...],
  "pMaxGrid": [0.55, 1.84, ...],
  "metadata": {
    "solverVersion": "openfoam-avalanche@2312",
    "runtime": 0.85,
    "steps": 312,
    "simulationTime": 45.2,
    "massConservation": 0.94,
    "massInitial": 4.8,
    "massDeposited": 7.9
  }
}
```

This maps to the TypeScript `FlowPyGridResult` interface with
`solverInfo.type = 'openfoam'`.

## Graceful Handling of Missing Output

| Missing Field | Behavior                                        |
|---------------|-------------------------------------------------|
| `h`           | `deposition` filled with zeros                  |
| `Us`          | `vMaxGrid` and `pMaxGrid` filled with zeros     |
| `0/h`         | `massConservation` defaults to `1.0`            |
| Fewer cells   | Remaining cells padded with zeros               |
| Extra cells   | Truncated to grid size                          |

## Implementation

Converter: `internal/convert/output.go`

Entry point: `ConvertOutput(caseDir, density, wallClockSec) → (*ConvertResult, error)`

Serializer: `WriteResultJSON(result, outputPath) → error`
