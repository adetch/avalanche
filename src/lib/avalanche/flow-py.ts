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
  params: FlowPyParams = DEFAULT_FLOW_PY_PARAMS,
  /** Mass multiplier from snow entrainment along the track (Sovilla et al. 2006). 1.0 = no entrainment. */
  entrainmentFactor: number = 1.0
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

  // Compute per-cell entrainment rate from the overall factor.
  // Model: mass grows exponentially through steep cells (track zone).
  // (1 + rate)^N = entrainmentFactor, where N = estimated steep cells on path.
  // Estimate N from grid: typical path traverses ~50% of rows.
  const entrainmentRate = entrainmentFactor > 1
    ? Math.pow(entrainmentFactor, 1 / Math.max(rows * 0.5, 10)) - 1
    : 0;

  for (const [startRow, startCol] of releaseCells) {
    propagateSingleRelease(dem, startRow, startCol, params, tanAlpha, entrainmentRate, zMaxDelta, rMax, cellCount, deposition);
  }

  // Post-processing: redistribute deposition into a physically plausible pattern.
  //
  // The raw mass-balance (influx - outflux) gives the correct TOTAL mass budget
  // but distributes it as tiny residuals at every cell boundary. Real avalanche
  // deposits form a concentrated tongue in the runout zone.
  //
  // Sovilla et al. (2010): deposit area ≈ 2-5× release area, depth inversely
  // correlates with slope angle. Bartelt et al. (2012): deposition occurs where
  // flow velocity drops below a critical threshold.
  redistributeDeposition(deposition, rMax, dem, tanAlpha, params.rStop);

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
 * Redistribute raw mass-balance deposition into a physically plausible pattern.
 *
 * Raw deposition (influx - outflux) scatters tiny residuals at every cell boundary
 * because MFD routing is nearly lossless on smooth terrain. This function concentrates
 * the same total mass into the runout zone where the avalanche actually deposits.
 *
 * Design principle: Flow-Py (D'Amboise et al. 2022) is a path-extent model, not a
 * deposition model. The rMax field is spatially continuous and follows the flow
 * topology, making it the best available proxy for deposit distribution. We use it
 * directly (linear, not squared) to preserve the connected spatial structure that
 * higher powers and hard thresholds destroy on real terrain.
 *
 * Weight = rMax × softDecel(slope, alpha)
 *   - rMax: linear flow intensity preserves connected tongue shape across
 *     bifurcating channels on real terrain
 *   - softDecel: smooth sigmoid-like ramp from 0 (steep track) to 1 (gentle runout),
 *     avoids the hard cutoff at slope = alpha that creates checkerboard artifacts
 *     where cell-by-cell slope varies on real terrain
 *
 * No thresholds or area caps — these fragment deposits on complex terrain.
 * Falls back to raw mass-balance if no deceleration zone exists.
 * Total deposited mass is preserved (mass conservation).
 */
function redistributeDeposition(
  deposition: Float32Array,
  rMax: Float32Array,
  dem: VirtualDEM,
  tanAlpha: number,
  rStop: number
): void {
  const { cols, rows, cellSize, elevation } = dem;
  const totalCells = rows * cols;

  // Sum raw mass-balance deposition (the correct total mass budget)
  let totalMass = 0;
  for (let i = 0; i < totalCells; i++) {
    totalMass += deposition[i];
  }
  if (totalMass <= 0) return;

  // Smooth deceleration transition width: ~30% of tanAlpha.
  // This creates a gradual ramp (~5° wide for alpha=22°) instead of a
  // hard cutoff at slope = alpha. Real avalanche deposits don't start
  // abruptly — the flow decelerates over a transition zone as slope
  // decreases below the friction-equivalent angle.
  const transitionWidth = tanAlpha * 0.3;

  // Compute deposition weights.
  // rMax is used linearly (not squared or cubed) because:
  // - It preserves the connected spatial structure of MFD routing
  // - Higher powers (rMax², rMax⁴) amplify differences between flow
  //   channels, creating isolated dots on real terrain where flow
  //   bifurcates around ridges and terrain features
  // - The natural rMax gradient (high at centerline, low at edges)
  //   already provides adequate lateral concentration
  let sumWeight = 0;
  const weight = new Float32Array(totalCells);

  for (let i = 0; i < totalCells; i++) {
    if (rMax[i] < rStop) continue;

    const r = Math.floor(i / cols);
    const c = i % cols;

    // Compute local slope (max downhill gradient to any neighbor)
    let maxTanPhi = 0;
    for (let ni = 0; ni < 8; ni++) {
      const [dr, dc, distFactor] = NEIGHBORS[ni];
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const nElev = elevation[nr * cols + nc];
      if (isNaN(nElev)) continue;
      const drop = elevation[i] - nElev;
      if (drop <= 0) continue;
      const tanPhi = drop / (distFactor * cellSize);
      if (tanPhi > maxTanPhi) maxTanPhi = tanPhi;
    }

    // Smooth deceleration factor: 0 in steep track, ramps to 1 in gentle runout.
    // Linear ramp over transitionWidth centered at slope = alpha.
    // Saturates at 1.0 when slope drops ~30% below alpha-equivalent angle.
    const decelFactor = Math.max(0, Math.min(1,
      (tanAlpha - maxTanPhi) / transitionWidth));
    if (decelFactor <= 0) continue;

    weight[i] = rMax[i] * decelFactor;
    sumWeight += weight[i];
  }

  // If no deceleration zone found (uniform steep terrain), keep raw deposition
  if (sumWeight <= 0) return;

  // Redistribute total mass according to weights
  for (let i = 0; i < totalCells; i++) {
    deposition[i] = (weight[i] / sumWeight) * totalMass;
  }
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
// Minimum slope for entrainment to occur (~15°, typical track zone threshold)
const ENTRAIN_SLOPE_TAN = Math.tan(15 * Math.PI / 180);

function propagateSingleRelease(
  dem: VirtualDEM,
  startRow: number,
  startCol: number,
  params: FlowPyParams,
  tanAlpha: number,
  entrainmentRate: number,
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
    let cellMass = massIn[idx];

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

    // Slope-dependent entrainment (Sovilla et al. 2006):
    // On steep track slopes, the avalanche erodes additional snow from the surface.
    // Mass grows as it travels through the track zone, then deposits in the runout.
    if (entrainmentRate > 0 && cellMass > 0) {
      let maxTanPhi = 0;
      for (const n of downslopeNeighbors) {
        if (n.tanPhi > maxTanPhi) maxTanPhi = n.tanPhi;
      }
      if (maxTanPhi > ENTRAIN_SLOPE_TAN) {
        const entrained = cellMass * entrainmentRate;
        cellMass += entrained;
      }
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
