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

  const tanAlpha = Math.tan((params.alphaAngleDeg * Math.PI) / 180);

  for (const [startRow, startCol] of releaseCells) {
    propagateSingleRelease(dem, startRow, startCol, params, tanAlpha, zMaxDelta, rMax, cellCount);
  }

  return {
    origin: dem.origin,
    cellSize: dem.cellSize,
    cols,
    rows,
    zMaxDelta,
    rMax,
    cellCount,
  };
}

/**
 * Propagate flow from a single release cell using BFS in descending elevation order.
 */
function propagateSingleRelease(
  dem: VirtualDEM,
  startRow: number,
  startCol: number,
  params: FlowPyParams,
  tanAlpha: number,
  outZMaxDelta: Float32Array,
  outRMax: Float32Array,
  outCellCount: Uint16Array
): void {
  const { cols, rows } = dem;
  const { exponent, rStop } = params;

  // Per-release-cell local state
  // zDelta[idx] = max z-delta energy received at this cell from this release
  const localZDelta = new Float32Array(rows * cols);
  const localR = new Float32Array(rows * cols);
  // Track the parent direction at each cell for persistence calculation
  const parentAngle = new Float32Array(rows * cols).fill(-1);
  const visited = new Uint8Array(rows * cols);

  const startIdx = startRow * cols + startCol;
  const startElev = getElevation(dem, startRow, startCol);
  if (isNaN(startElev)) return;

  // Initialize release cell
  localZDelta[startIdx] = 0; // starts at zero energy
  localR[startIdx] = 1.0;    // full flux
  parentAngle[startIdx] = -1; // no parent direction

  // BFS queue: [row, col, elevation] sorted by descending elevation
  // Use a simple queue that we process in elevation order
  const queue: [number, number][] = [[startRow, startCol]];
  const inQueue = new Uint8Array(rows * cols);
  inQueue[startIdx] = 1;

  // Process cells from highest to lowest elevation
  while (queue.length > 0) {
    // Find highest-elevation cell in queue (simple scan; adequate for avalanche-scale grids)
    let bestIdx = 0;
    let bestElev = -Infinity;
    for (let q = 0; q < queue.length; q++) {
      const elev = getElevation(dem, queue[q][0], queue[q][1]);
      if (elev > bestElev) {
        bestElev = elev;
        bestIdx = q;
      }
    }

    const [r, c] = queue[bestIdx];
    queue[bestIdx] = queue[queue.length - 1];
    queue.pop();

    const idx = r * cols + c;
    if (visited[idx]) continue;
    visited[idx] = 1;

    const cellElev = getElevation(dem, r, c);
    if (isNaN(cellElev)) continue;

    const cellR = localR[idx];
    const cellZDelta = localZDelta[idx];
    if (cellR < rStop) continue;

    // Composite into output
    if (cellZDelta > outZMaxDelta[idx]) outZMaxDelta[idx] = cellZDelta;
    if (cellR > outRMax[idx]) outRMax[idx] = cellR;
    outCellCount[idx]++;

    // Find downslope neighbors and compute terrain routing
    const downslopeNeighbors: {
      ni: number; // neighbor index in NEIGHBORS array
      row: number;
      col: number;
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

      const nElev = getElevation(dem, nr, nc);
      if (isNaN(nElev)) continue;
      if (nElev >= cellElev) continue; // only downslope

      const dist = distFactor * dem.cellSize;
      const drop = cellElev - nElev;
      const tanPhi = drop / dist;
      if (tanPhi <= 0) continue;

      const tanPhiExp = Math.pow(tanPhi, exponent);
      sumTanPhiExp += tanPhiExp;

      downslopeNeighbors.push({ ni, row: nr, col: nc, tanPhi, dist, elev: nElev });
    }

    if (downslopeNeighbors.length === 0 || sumTanPhiExp === 0) continue;

    // Compute persistence weights
    const hasParent = parentAngle[idx] >= 0;
    const pAngle = parentAngle[idx];

    let sumTP = 0;
    const neighborTP: number[] = [];

    for (const n of downslopeNeighbors) {
      // Terrain routing weight
      const T = Math.pow(n.tanPhi, exponent) / sumTanPhiExp;

      // Persistence weight
      let P = 1.0;
      if (hasParent) {
        // Angle of flow from parent to this cell
        const flowAngle = pAngle;
        // Angle from this cell to neighbor
        const neighborAngle = NEIGHBOR_ANGLES[n.ni];
        // Angular difference (how much this neighbor deviates from the flow direction)
        let angleDiff = neighborAngle - flowAngle;
        // Normalize to [-PI, PI]
        while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
        while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
        // Persistence: cos of deviation, clamped to 0 for backward directions
        P = Math.max(0, Math.cos(angleDiff));
      }

      const tp = T * P;
      neighborTP.push(tp);
      sumTP += tp;
    }

    if (sumTP === 0) continue;

    // Route flux and energy to each neighbor
    for (let i = 0; i < downslopeNeighbors.length; i++) {
      const n = downslopeNeighbors[i];
      const nIdx = n.row * cols + n.col;

      // Combined routing fraction
      const fraction = neighborTP[i] / sumTP;
      const nR = cellR * fraction;

      if (nR < rStop) continue;

      // Z-delta energy: gain from elevation drop, lose from friction (tan(alpha) × distance)
      const nZDelta = cellZDelta + (cellElev - n.elev) - n.dist * tanAlpha;

      if (nZDelta <= 0) continue; // flow stops

      // Update neighbor if this path gives more energy or flux
      if (nZDelta > localZDelta[nIdx] || localR[nIdx] === 0) {
        localZDelta[nIdx] = Math.max(localZDelta[nIdx], nZDelta);
        localR[nIdx] = Math.max(localR[nIdx], nR);
        parentAngle[nIdx] = NEIGHBOR_ANGLES[n.ni]; // direction from current cell to neighbor

        if (!inQueue[nIdx] && !visited[nIdx]) {
          queue.push([n.row, n.col]);
          inQueue[nIdx] = 1;
        }
      }
    }
  }
}
