import type { VirtualDEM } from "@/lib/geo/virtual-dem";
import { getElevation } from "@/lib/geo/virtual-dem";
import type { FlowPyGridResult } from "@/types";

/**
 * Flow-Py: 2D gravitational mass-flow routing simulation.
 *
 * Based on D'Amboise et al. (2022), using:
 * - Holmgren (1994) Multiple-Flow-Direction (MFD) routing
 * - Z-delta energy tracking with alpha-angle stopping criterion
 * - Persistence (momentum) weighting to limit lateral spread
 *
 * Each release cell is processed independently and results are composited
 * via max(zDelta), max(R), and sum(cellCount).
 */

export interface FlowPyParams {
  /** Runout angle in degrees (controls stopping distance). Lower = longer runout. */
  alphaAngleDeg: number;
  /** Holmgren MFD exponent. 8 = avalanche-typical, 1 = maximum spread */
  exponent: number;
  /** Flux cutoff threshold. Flow stops when R drops below this. */
  rStop: number;
}

export const DEFAULT_FLOW_PY_PARAMS: FlowPyParams = {
  alphaAngleDeg: 25,
  exponent: 8,
  rStop: 3e-4,
};

// 8-neighbor offsets: [dRow, dCol, distance_factor]
// N, NE, E, SE, S, SW, W, NW
const NEIGHBORS: [number, number, number][] = [
  [1, 0, 1],           // N
  [1, 1, Math.SQRT2],  // NE
  [0, 1, 1],           // E
  [-1, 1, Math.SQRT2], // SE
  [-1, 0, 1],          // S
  [-1, -1, Math.SQRT2],// SW
  [0, -1, 1],          // W
  [1, -1, Math.SQRT2], // NW
];

// Direction angles for each neighbor (radians, 0=N, clockwise)
const NEIGHBOR_ANGLES: number[] = [
  0,                    // N
  Math.PI / 4,          // NE
  Math.PI / 2,          // E
  (3 * Math.PI) / 4,    // SE
  Math.PI,              // S
  (5 * Math.PI) / 4,    // SW
  (3 * Math.PI) / 2,    // W
  (7 * Math.PI) / 4,    // NW
];

/**
 * Run the Flow-Py simulation on a virtual DEM.
 *
 * @param dem - Virtual DEM grid
 * @param releaseCells - Array of [row, col] release cells
 * @param params - Algorithm parameters
 * @returns FlowPyGridResult with intensity grids
 */
export function runFlowPy(
  dem: VirtualDEM,
  releaseCells: [number, number][],
  params: FlowPyParams = DEFAULT_FLOW_PY_PARAMS
): FlowPyGridResult {
  const { cols, rows } = dem;
  const totalCells = rows * cols;

  // Output grids (composited across all release cells)
  const zMaxDelta = new Float32Array(totalCells);
  const rMax = new Float32Array(totalCells);
  const cellCount = new Uint16Array(totalCells);
  // Mass-balance deposition: summed across release cells (additive — mass accumulates)
  const deposition = new Float32Array(totalCells);

  const tanAlpha = Math.tan((params.alphaAngleDeg * Math.PI) / 180);

  for (const [startRow, startCol] of releaseCells) {
    propagateSingleRelease(dem, startRow, startCol, params, tanAlpha, zMaxDelta, rMax, cellCount, deposition);
  }

  return {
    origin: dem.origin,
    cellSize: dem.cellSize,
    cols,
    rows,
    zMaxDelta,
    rMax,
    cellCount,
    deposition,
  };
}

/**
 * Pre-sort all grid cells by descending elevation.
 * Returns array of flat indices sorted highest-first.
 */
function buildElevationOrder(dem: VirtualDEM): number[] {
  const { cols, rows } = dem;
  const indices: number[] = [];
  for (let i = 0; i < rows * cols; i++) {
    if (!isNaN(dem.elevation[i])) {
      indices.push(i);
    }
  }
  indices.sort((a, b) => dem.elevation[b] - dem.elevation[a]);
  return indices;
}

/**
 * Propagate flow from a single release cell.
 *
 * Uses the original Flow-Py approach: process ALL grid cells in strict
 * descending elevation order. This guarantees every parent cell has been
 * processed before its children, so flux accumulation from multiple
 * parents is correct without needing a priority queue.
 */
function propagateSingleRelease(
  dem: VirtualDEM,
  startRow: number,
  startCol: number,
  params: FlowPyParams,
  tanAlpha: number,
  outZMaxDelta: Float32Array,
  outRMax: Float32Array,
  outCellCount: Uint16Array,
  outDeposition: Float32Array
): void {
  const { cols, rows } = dem;
  const { exponent, rStop } = params;
  const totalCells = rows * cols;

  // Per-release-cell grids
  const localZDelta = new Float32Array(totalCells);
  const localR = new Float32Array(totalCells);
  // Track incoming flow direction for persistence (weighted sum of parent directions)
  const flowDirX = new Float32Array(totalCells); // sum of sin(angle) * weight
  const flowDirY = new Float32Array(totalCells); // sum of cos(angle) * weight

  // Mass tracking: SUM-accumulated influx for mass conservation
  // (separate from localR which uses MAX-accumulation per Flow-Py spec)
  const massIn = new Float32Array(totalCells);

  const startIdx = startRow * cols + startCol;
  const startElev = getElevation(dem, startRow, startCol);
  if (isNaN(startElev)) return;

  // Initialize release cell
  localZDelta[startIdx] = startElev; // z_delta = elevation above alpha line origin
  localR[startIdx] = 1.0;
  massIn[startIdx] = 1.0; // unit mass enters at release

  // Get cells in descending elevation order
  const order = buildElevationOrder(dem);

  // Process every cell in elevation order
  for (const idx of order) {
    const cellR = localR[idx];
    if (cellR < rStop) {
      // Flow died here — all accumulated mass deposits
      if (massIn[idx] > 0) {
        outDeposition[idx] += massIn[idx];
      }
      continue;
    }

    const r = Math.floor(idx / cols);
    const c = idx % cols;
    const cellElev = dem.elevation[idx];
    const cellZDelta = localZDelta[idx];
    const cellMass = massIn[idx];

    // Composite into output (R-max, z-delta-max, cell count)
    if (cellZDelta > outZMaxDelta[idx]) outZMaxDelta[idx] = cellZDelta;
    if (cellR > outRMax[idx]) outRMax[idx] = cellR;
    outCellCount[idx]++;

    // Find downslope neighbors and compute terrain routing weights
    const downslopeNeighbors: {
      ni: number;
      idx: number;
      tanPhi: number;
      dist: number;
      elev: number;
    }[] = [];

    let sumTanPhiExp = 0;

    for (let ni = 0; ni < 8; ni++) {
      const [dr, dc, distFactor] = NEIGHBORS[ni];
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;

      const nIdx = nr * cols + nc;
      const nElev = dem.elevation[nIdx];
      if (isNaN(nElev)) continue;
      if (nElev >= cellElev) continue; // only downslope

      const dist = distFactor * dem.cellSize;
      const drop = cellElev - nElev;
      const tanPhi = drop / dist;
      if (tanPhi <= 0) continue;

      const tanPhiExp = Math.pow(tanPhi, exponent);
      sumTanPhiExp += tanPhiExp;

      downslopeNeighbors.push({ ni, idx: nIdx, tanPhi, dist, elev: nElev });
    }

    if (downslopeNeighbors.length === 0 || sumTanPhiExp === 0) {
      // No downslope neighbors — all mass deposits here
      outDeposition[idx] += cellMass;
      continue;
    }

    // Compute persistence weights from accumulated flow direction
    const hasMomentum = flowDirX[idx] !== 0 || flowDirY[idx] !== 0;
    const incomingAngle = hasMomentum
      ? Math.atan2(flowDirX[idx], flowDirY[idx])
      : -1;

    let sumTP = 0;
    const neighborTP: number[] = [];

    for (const n of downslopeNeighbors) {
      const T = Math.pow(n.tanPhi, exponent) / sumTanPhiExp;

      let P = 1.0;
      if (hasMomentum) {
        const neighborAngle = NEIGHBOR_ANGLES[n.ni];
        let angleDiff = neighborAngle - incomingAngle;
        while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
        while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
        P = Math.max(0, Math.cos(angleDiff));
      }

      const tp = T * P;
      neighborTP.push(tp);
      sumTP += tp;
    }

    if (sumTP === 0) {
      outDeposition[idx] += cellMass;
      continue;
    }

    // Route flux, energy, and mass to each downslope neighbor
    let totalMassRouted = 0;

    for (let i = 0; i < downslopeNeighbors.length; i++) {
      const n = downslopeNeighbors[i];
      const fraction = neighborTP[i] / sumTP;
      const nR = cellR * fraction;

      if (nR < rStop) continue;

      const nZDelta = cellZDelta + (cellElev - n.elev) - n.dist * tanAlpha;

      if (nZDelta <= 0) continue; // flow stops (below alpha line)

      // R-max accumulation (standard Flow-Py)
      if (nR > localR[n.idx]) {
        localR[n.idx] = nR;
      }
      if (nZDelta > localZDelta[n.idx]) {
        localZDelta[n.idx] = nZDelta;
      }

      // Mass: SUM-accumulation (conservation of mass)
      const nMass = cellMass * fraction;
      massIn[n.idx] += nMass;
      totalMassRouted += nMass;

      // Flow direction vector (weighted by flux for persistence)
      const outAngle = NEIGHBOR_ANGLES[n.ni];
      flowDirX[n.idx] += nR * Math.sin(outAngle);
      flowDirY[n.idx] += nR * Math.cos(outAngle);
    }

    // Mass that couldn't route onward deposits at this cell
    // (due to rStop cutoff, z-delta exhaustion, or persistence blocking)
    const deposited = cellMass - totalMassRouted;
    if (deposited > 0) {
      outDeposition[idx] += deposited;
    }
  }
}
