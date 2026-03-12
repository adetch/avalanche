import { describe, it, expect } from "vitest";
import { runFlowPy, DEFAULT_FLOW_PY_PARAMS } from "./flow-py";
import type { VirtualDEM } from "@/lib/geo/virtual-dem";
import type { FlowPyParams } from "./flow-py";

/**
 * Helper: create a VirtualDEM with a given elevation function.
 * Grid is rows x cols, origin at [0, 0], cellSize = 10m.
 */
function makeDEM(
  rows: number,
  cols: number,
  elevFn: (row: number, col: number) => number
): VirtualDEM {
  const elevation = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      elevation[r * cols + c] = elevFn(r, c);
    }
  }
  return {
    origin: [0, 0],
    cellSize: 10,
    cols,
    rows,
    elevation,
    mPerDegLat: 111320,
    mPerDegLng: 111320,
  };
}

describe("runFlowPy", () => {
  it("flat terrain produces no flow beyond release cell", () => {
    // All cells at 100m elevation — no downslope neighbors
    const dem = makeDEM(20, 20, () => 100);
    const result = runFlowPy(dem, [[10, 10]]);

    // Only the release cell should have flux
    let cellsWithFlux = 0;
    for (let i = 0; i < result.rMax.length; i++) {
      if (result.rMax[i] > 0) cellsWithFlux++;
    }
    expect(cellsWithFlux).toBe(1);

    // All mass deposits at the release cell (nowhere to go)
    const releaseIdx = 10 * 20 + 10;
    expect(result.deposition[releaseIdx]).toBeCloseTo(1.0, 5);
  });

  it("uniform slope produces downslope flow", () => {
    // Slope tilted southward: row 0 is lowest, row 49 is highest
    // Each row step = 10m horizontal, 5m vertical drop = ~26.6° slope
    const dem = makeDEM(50, 20, (row, _col) => row * 5);
    // Release from top row
    const result = runFlowPy(dem, [[49, 10]], {
      alphaAngleDeg: 25,
      exponent: 8,
      rStop: 3e-4,
    });

    // Flow should reach cells below the release
    let cellsReached = 0;
    for (let i = 0; i < result.cellCount.length; i++) {
      if (result.cellCount[i] > 0) cellsReached++;
    }
    expect(cellsReached).toBeGreaterThan(5);

    // Flow should be concentrated near col 10 (straight downslope)
    const col10Flux = result.rMax[25 * 20 + 10]; // midway down
    const col15Flux = result.rMax[25 * 20 + 15]; // off to the side
    expect(col10Flux).toBeGreaterThan(col15Flux);
  });

  it("higher alpha angle produces less energy at runout", () => {
    // On steep terrain both alpha values reach all cells, but the higher
    // alpha dissipates more energy. Max z-delta should be lower.
    const dem = makeDEM(100, 20, (row) => row * 5);

    const lowAlpha = runFlowPy(dem, [[99, 10]], {
      alphaAngleDeg: 10,
      exponent: 8,
      rStop: 3e-4,
    });
    const highAlpha = runFlowPy(dem, [[99, 10]], {
      alphaAngleDeg: 30,
      exponent: 8,
      rStop: 3e-4,
    });

    let lowMaxZ = 0;
    let highMaxZ = 0;
    for (let i = 0; i < lowAlpha.zMaxDelta.length; i++) {
      if (lowAlpha.zMaxDelta[i] > lowMaxZ) lowMaxZ = lowAlpha.zMaxDelta[i];
      if (highAlpha.zMaxDelta[i] > highMaxZ) highMaxZ = highAlpha.zMaxDelta[i];
    }
    expect(lowMaxZ).toBeGreaterThan(highMaxZ);
  });

  it("lower exponent produces more lateral spread", () => {
    // Steep slope with low rStop so flux doesn't die from splitting
    const cols = 30;
    const dem = makeDEM(50, cols, (row) => row * 6);

    const narrow = runFlowPy(dem, [[49, 15]], {
      alphaAngleDeg: 15,
      exponent: 8,
      rStop: 1e-8,
    });
    const wide = runFlowPy(dem, [[49, 15]], {
      alphaAngleDeg: 15,
      exponent: 1,
      rStop: 1e-8,
    });

    // Count total cells reached (wide should be >= narrow)
    let narrowTotal = 0;
    let wideTotal = 0;
    for (let i = 0; i < narrow.cellCount.length; i++) {
      if (narrow.cellCount[i] > 0) narrowTotal++;
      if (wide.cellCount[i] > 0) wideTotal++;
    }
    expect(wideTotal).toBeGreaterThanOrEqual(narrowTotal);
  });

  it("gully concentrates flow along valley axis", () => {
    // V-shaped valley: elevation = row*8 + |col - 15| * 4
    // Steep slope (~38°) with valley axis at col=15, walls rise steeply on both sides
    const dem = makeDEM(60, 30, (row, col) => row * 8 + Math.abs(col - 15) * 4);

    const result = runFlowPy(dem, [[59, 15]], {
      alphaAngleDeg: 20,
      exponent: 8,
      rStop: 3e-4,
    });

    // Flow should reach the midpoint
    let cellsReached = 0;
    for (let i = 0; i < result.cellCount.length; i++) {
      if (result.cellCount[i] > 0) cellsReached++;
    }
    expect(cellsReached).toBeGreaterThan(5);

    // Flux should be highest along valley axis (col=15) vs sides
    const axisFlux = result.rMax[30 * 30 + 15];
    const sideFlux = result.rMax[30 * 30 + 20];
    expect(axisFlux).toBeGreaterThanOrEqual(sideFlux);
  });

  it("deposition conserves mass (total deposition ≈ 1.0 per release cell)", () => {
    // Steep uniform slope — all mass must deposit somewhere
    const dem = makeDEM(50, 20, (row) => row * 5);
    const result = runFlowPy(dem, [[49, 10]], {
      alphaAngleDeg: 25,
      exponent: 8,
      rStop: 3e-4,
    });

    // Sum all deposition — should equal 1.0 (unit mass from one release cell)
    let totalDeposition = 0;
    for (let i = 0; i < result.deposition.length; i++) {
      totalDeposition += result.deposition[i];
    }
    // Allow small floating-point tolerance (mass lost to rStop cutoff)
    expect(totalDeposition).toBeGreaterThan(0.9);
    expect(totalDeposition).toBeLessThanOrEqual(1.01);
  });

  it("entrainment increases total deposited mass", () => {
    // Steep slope (>15°) so entrainment occurs along the track
    const dem = makeDEM(60, 20, (row) => row * 6);

    const noEntrain = runFlowPy(dem, [[59, 10]], {
      alphaAngleDeg: 20,
      exponent: 8,
      rStop: 3e-4,
    }, 1.0); // no entrainment

    const withEntrain = runFlowPy(dem, [[59, 10]], {
      alphaAngleDeg: 20,
      exponent: 8,
      rStop: 3e-4,
    }, 2.5); // 2.5× entrainment

    let totalNoEntrain = 0;
    let totalWithEntrain = 0;
    for (let i = 0; i < noEntrain.deposition.length; i++) {
      totalNoEntrain += noEntrain.deposition[i];
      totalWithEntrain += withEntrain.deposition[i];
    }

    // Without entrainment: ~1.0
    expect(totalNoEntrain).toBeGreaterThan(0.9);
    expect(totalNoEntrain).toBeLessThanOrEqual(1.01);

    // With 2.5× entrainment: total should be significantly more than 1.0
    expect(totalWithEntrain).toBeGreaterThan(totalNoEntrain * 1.5);
    // But shouldn't exceed a reasonable upper bound
    expect(totalWithEntrain).toBeLessThan(totalNoEntrain * 4);
  });

  it("deposition concentrates in runout zone, not at release", () => {
    // Realistic terrain: steep track transitioning to gentle runout
    // Rows 40-79: steep (~39°, slope 8m per 10m horizontal)
    // Rows 0-39:  gentle (~11°, slope 2m per 10m horizontal)
    const dem = makeDEM(80, 20, (row) =>
      row >= 40 ? 40 * 2 + (row - 40) * 8 : row * 2
    );
    const result = runFlowPy(dem, [[79, 10]], {
      alphaAngleDeg: 20,
      exponent: 8,
      rStop: 3e-4,
    });

    const releaseIdx = 79 * 20 + 10;
    const releaseDeposition = result.deposition[releaseIdx];

    // Find the cell with maximum deposition
    let maxDeposition = 0;
    let maxDepRow = 0;
    for (let i = 0; i < result.deposition.length; i++) {
      if (result.deposition[i] > maxDeposition) {
        maxDeposition = result.deposition[i];
        maxDepRow = Math.floor(i / 20);
      }
    }

    // Max deposition should be in or at the runout zone transition (rows ≤40),
    // not at the release (row 79) or in the steep track (rows 41-79)
    expect(maxDepRow).toBeLessThanOrEqual(40);
    // Release cell should have zero deposition (slope > alpha → acceleration zone)
    expect(releaseDeposition).toBe(0);
    // Peak deposition should be meaningful (not scattered residuals)
    expect(maxDeposition).toBeGreaterThan(0.01);
  });

  it("multiple release cells composite correctly", () => {
    // Steep slope so both paths travel far enough to overlap
    const dem = makeDEM(80, 20, (row) => row * 8);

    // Two adjacent release cells — their paths should overlap
    const single = runFlowPy(dem, [[79, 10]], {
      alphaAngleDeg: 15,
      exponent: 8,
      rStop: 3e-4,
    });
    const double = runFlowPy(dem, [[79, 10], [79, 11]], {
      alphaAngleDeg: 15,
      exponent: 8,
      rStop: 3e-4,
    });

    // Should have at least some cells reached by both release cells
    let maxCount = 0;
    for (let i = 0; i < double.cellCount.length; i++) {
      if (double.cellCount[i] > maxCount) maxCount = double.cellCount[i];
    }
    expect(maxCount).toBe(2);

    // Double-release should reach at least as many cells as single
    let singleCells = 0;
    let doubleCells = 0;
    for (let i = 0; i < single.cellCount.length; i++) {
      if (single.cellCount[i] > 0) singleCells++;
      if (double.cellCount[i] > 0) doubleCells++;
    }
    expect(doubleCells).toBeGreaterThanOrEqual(singleCells);

    // Two release cells → total deposition should be ≈ 2.0 (additive mass)
    let totalDep = 0;
    for (let i = 0; i < double.deposition.length; i++) {
      totalDep += double.deposition[i];
    }
    expect(totalDep).toBeGreaterThan(1.8);
    expect(totalDep).toBeLessThanOrEqual(2.01);
  });
});
