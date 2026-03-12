import { describe, it, expect } from "vitest";
import { runVoellmy2D } from "./voellmy-2d";
import type { VirtualDEM } from "@/lib/geo/virtual-dem";
import type { Voellmy2DParams } from "./voellmy-2d";

/** Helper: create a VirtualDEM with a given elevation function. */
function makeDEM(
  rows: number,
  cols: number,
  elevFn: (row: number, col: number) => number,
  cellSize = 10
): VirtualDEM {
  const elevation = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      elevation[r * cols + c] = elevFn(r, c);
    }
  }
  return {
    origin: [0, 0],
    cellSize,
    cols,
    rows,
    elevation,
    mPerDegLat: 111320,
    mPerDegLng: 111320,
  };
}

const DEFAULT_PARAMS: Voellmy2DParams = {
  mu: 0.3,
  xi: 1500,
  density: 250,
  entrainmentFactor: 1.0,
  maxTime: 60,
};

describe("runVoellmy2D", () => {
  it("flat terrain: mass stays at release cells", () => {
    const dem = makeDEM(20, 20, () => 100);
    const result = runVoellmy2D(dem, [[10, 10]], 1.0, DEFAULT_PARAMS);

    // On flat terrain, no gravity drive → flow stays put
    // Most deposition should be at or near the release cell
    const releaseIdx = 10 * 20 + 10;
    expect(result.deposition[releaseIdx]).toBeGreaterThan(0.5);
    expect(result.solverInfo?.type).toBe("voellmy-2d");
  });

  it("uniform slope: flow moves downslope and deposits", () => {
    // Slope: row 0 (south) is lowest, row 59 (north) is highest
    // 5m drop per 10m cell = ~26.6° slope
    const dem = makeDEM(60, 20, (row) => row * 5);
    const result = runVoellmy2D(dem, [[59, 10]], 1.0, DEFAULT_PARAMS);

    // Flow should reach cells below the release
    let reachedCells = 0;
    for (let i = 0; i < result.cellCount.length; i++) {
      if (result.cellCount[i] > 0) reachedCells++;
    }
    expect(reachedCells).toBeGreaterThan(5);

    // Deposition should be downslope of release
    let maxDepRow = 0;
    let maxDep = 0;
    for (let r = 0; r < 60; r++) {
      const dep = result.deposition[r * 20 + 10];
      if (dep > maxDep) { maxDep = dep; maxDepRow = r; }
    }
    expect(maxDepRow).toBeLessThan(59); // not at release
  });

  it("deposition is in absolute meters", () => {
    const dem = makeDEM(60, 20, (row) => row * 5);
    const result = runVoellmy2D(dem, [[59, 10]], 1.0, DEFAULT_PARAMS);

    // Find max deposition — should be in meter range, not dimensionless 0-1
    let maxDep = 0;
    for (let i = 0; i < result.deposition.length; i++) {
      if (result.deposition[i] > maxDep) maxDep = result.deposition[i];
    }
    // With 1m release depth, max deposit should be positive and reasonable
    expect(maxDep).toBeGreaterThan(0.01);
    expect(maxDep).toBeLessThan(50); // shouldn't be absurdly large
  });

  it("mass conservation (no entrainment)", () => {
    const dem = makeDEM(60, 20, (row) => row * 5);
    const result = runVoellmy2D(dem, [[59, 10]], 1.0, {
      ...DEFAULT_PARAMS,
      entrainmentFactor: 1.0,
    });

    // Sum deposited mass
    let totalDep = 0;
    for (let i = 0; i < result.deposition.length; i++) {
      totalDep += result.deposition[i];
    }
    // Should be close to initial mass (1.0m at one cell)
    // Mass lost at grid edges (open boundary) + diffusion spreading on small grids
    expect(totalDep).toBeGreaterThan(0.3);
    expect(totalDep).toBeLessThan(1.5);

    // Solver should report mass conservation
    expect(result.solverInfo?.massConservation).toBeDefined();
  });

  it("higher friction (mu) produces shorter runout", () => {
    const dem = makeDEM(80, 20, (row) => row * 5);

    const lowFriction = runVoellmy2D(dem, [[79, 10]], 1.0, {
      ...DEFAULT_PARAMS,
      mu: 0.15,
      maxTime: 60,
    });
    const highFriction = runVoellmy2D(dem, [[79, 10]], 1.0, {
      ...DEFAULT_PARAMS,
      mu: 0.5,
      maxTime: 60,
    });

    // Count cells reached
    let lowReached = 0, highReached = 0;
    for (let i = 0; i < lowFriction.cellCount.length; i++) {
      if (lowFriction.cellCount[i] > 0) lowReached++;
      if (highFriction.cellCount[i] > 0) highReached++;
    }
    expect(lowReached).toBeGreaterThanOrEqual(highReached);
  });

  it("entrainment increases total deposited mass", () => {
    // Steep slope (>15°) so entrainment occurs
    const dem = makeDEM(60, 20, (row) => row * 6);

    const noEntrain = runVoellmy2D(dem, [[59, 10]], 1.0, {
      ...DEFAULT_PARAMS,
      entrainmentFactor: 1.0,
      maxTime: 60,
    });
    const withEntrain = runVoellmy2D(dem, [[59, 10]], 1.0, {
      ...DEFAULT_PARAMS,
      entrainmentFactor: 2.5,
      maxTime: 60,
    });

    let totalNo = 0, totalWith = 0;
    for (let i = 0; i < noEntrain.deposition.length; i++) {
      totalNo += noEntrain.deposition[i];
      totalWith += withEntrain.deposition[i];
    }
    expect(totalWith).toBeGreaterThan(totalNo);
  });

  it("gully concentrates flow along valley axis", () => {
    // V-shaped valley: valley axis at col=15
    const dem = makeDEM(60, 30, (row, col) => row * 8 + Math.abs(col - 15) * 4);
    const result = runVoellmy2D(dem, [[59, 15]], 1.0, {
      ...DEFAULT_PARAMS,
      maxTime: 60,
    });

    // Max flow depth should be along valley axis
    let axisHMax = 0, sideHMax = 0;
    for (let r = 0; r < 60; r++) {
      const ah = result.hMax?.[r * 30 + 15] ?? 0;
      const sh = result.hMax?.[r * 30 + 20] ?? 0;
      if (ah > axisHMax) axisHMax = ah;
      if (sh > sideHMax) sideHMax = sh;
    }
    expect(axisHMax).toBeGreaterThanOrEqual(sideHMax);
  });

  it("solver converges and terminates", () => {
    const dem = makeDEM(40, 20, (row) => row * 5);
    const result = runVoellmy2D(dem, [[39, 10]], 1.0, DEFAULT_PARAMS);

    expect(result.solverInfo?.timeSteps).toBeGreaterThan(0);
    expect(result.solverInfo?.timeSteps).toBeLessThanOrEqual(5000);
  });

  it("no NaN values in output", () => {
    const dem = makeDEM(40, 20, (row) => row * 5);
    const result = runVoellmy2D(dem, [[39, 10]], 1.0, DEFAULT_PARAMS);

    for (let i = 0; i < result.deposition.length; i++) {
      expect(isNaN(result.deposition[i])).toBe(false);
      expect(result.deposition[i]).toBeGreaterThanOrEqual(0);
    }
    if (result.vMaxGrid) {
      for (let i = 0; i < result.vMaxGrid.length; i++) {
        expect(isNaN(result.vMaxGrid[i])).toBe(false);
      }
    }
  });

  it("tracks max velocity and pressure", () => {
    const dem = makeDEM(60, 20, (row) => row * 5);
    const result = runVoellmy2D(dem, [[59, 10]], 1.0, DEFAULT_PARAMS);

    // Should have recorded max velocity somewhere
    let maxV = 0;
    if (result.vMaxGrid) {
      for (let i = 0; i < result.vMaxGrid.length; i++) {
        if (result.vMaxGrid[i] > maxV) maxV = result.vMaxGrid[i];
      }
    }
    expect(maxV).toBeGreaterThan(0);

    // Should have recorded max pressure
    let maxP = 0;
    if (result.pMaxGrid) {
      for (let i = 0; i < result.pMaxGrid.length; i++) {
        if (result.pMaxGrid[i] > maxP) maxP = result.pMaxGrid[i];
      }
    }
    expect(maxP).toBeGreaterThan(0);
  });

  it("steep-to-gentle transition deposits in runout zone", () => {
    // Rows 40-79: steep (~39°, 8m per 10m)
    // Rows 0-39: gentle (~11°, 2m per 10m)
    const dem = makeDEM(80, 20, (row) =>
      row >= 40 ? 40 * 2 + (row - 40) * 8 : row * 2
    );
    const result = runVoellmy2D(dem, [[79, 10]], 1.0, {
      ...DEFAULT_PARAMS,
      maxTime: 120,
    });

    // Find the row with max deposition
    let maxDepRow = 0;
    let maxDep = 0;
    for (let r = 0; r < 80; r++) {
      for (let c = 0; c < 20; c++) {
        const dep = result.deposition[r * 20 + c];
        if (dep > maxDep) { maxDep = dep; maxDepRow = r; }
      }
    }

    // Peak deposit should be in or near the transition zone (rows ~30-45)
    // Not at the release (row 79) or at the far end (row 0)
    expect(maxDepRow).toBeLessThan(60);
    expect(maxDep).toBeGreaterThan(0.01);
  });
});
