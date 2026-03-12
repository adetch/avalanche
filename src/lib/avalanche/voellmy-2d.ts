import type { VirtualDEM } from "@/lib/geo/virtual-dem";
import type { FlowPyGridResult } from "@/types";

/**
 * MinVoellmy 2D shallow water solver for avalanche deposition.
 *
 * Solves depth-averaged Saint-Venant equations with Voellmy friction
 * on the existing VirtualDEM grid. Based on Hergarten (2024) MinVoellmy
 * and Christen et al. (2010) RAMMS.
 *
 * Key features:
 * - 8-neighbor D∞ advection: splits flux between two bracketing directions
 *   for smooth diagonal flow (eliminates 4-neighbor staircase artifacts)
 * - Depth-dependent friction (simplified RKE model, Bartelt et al. 2015)
 * - Self-calibrating entrainment targeting entrainmentFactor × initial mass
 * - Hydrostatic pressure gradient prevents pile-up in terrain depressions
 *
 * The final flow depth h(x,y) IS the deposition depth — no post-processing.
 */

const G = 9.81;
const THIN = 0.001;  // 1mm wet/dry threshold
const H_STOP = 0.01; // 1cm hard stop — flow below this is deposited
const CFL = 0.4;
const MAX_STEPS = 5000;
const MU_DEPTH_CAP = 5;
const ENTRAIN_TAN = Math.tan(15 * Math.PI / 180);
const TWO_PI = 2 * Math.PI;
const SECTOR_SIZE = Math.PI / 4;
const COM_STOP_SPEED = 0.9; // m/s center-of-mass speed threshold
const MOVE_SPEED = 0.6; // m/s: counts as "moving mass"
const MOVE_MASS_FRAC_STOP = 0.05; // stop when <5% of mass is moving
const RUNOUT_TAN = Math.tan(15 * Math.PI / 180); // runout zone begins ~15-20°
const RUNOUT_WIDTH = Math.tan(5 * Math.PI / 180); // smooth transition width (~5°)
const RUNOUT_MU_GAIN = 2.0; // up to 3x mu on gentle slopes
const MIN_STOP_TIME = 8.0; // seconds before applying global stop criteria

// 8 directions ordered by angle: E=0°, NE=45°, N=90°, NW=135°, W=180°, SW=225°, S=270°, SE=315°
const DIR_DC = [1, 1, 0, -1, -1, -1, 0, 1];
const DIR_DR = [0, 1, 1, 1, 0, -1, -1, -1];

export interface Voellmy2DParams {
  mu: number;
  xi: number;
  density: number;
  entrainmentFactor: number;
  maxTime?: number;
}

export function runVoellmy2D(
  dem: VirtualDEM,
  releaseCells: [number, number][],
  snowDepthM: number,
  params: Voellmy2DParams
): FlowPyGridResult {
  const { cols, rows, cellSize, elevation } = dem;
  const n = rows * cols;
  const dx = cellSize;
  const { mu, xi, density, entrainmentFactor } = params;
  const maxTime = params.maxTime ?? 120;

  // --- Smooth DEM to remove micro-terrain noise ---
  // MapLibre terrain tiles at 15m have quantization artifacts and single-cell
  // depressions that create fake micro-channels. A 2-pass 3×3 average removes
  // these while preserving large-scale terrain shape (~45m effective radius).
  const smoothedElev = smoothElevation(elevation, rows, cols, 2);

  // --- Pre-compute terrain slopes from smoothed DEM ---
  const dzdx = new Float32Array(n);
  const dzdy = new Float32Array(n);
  const cosSlope = new Float32Array(n);
  precomputeSlopes(smoothedElev, rows, cols, dx, dzdx, dzdy, cosSlope);

  // --- State arrays ---
  let h = new Float32Array(n);
  let vx = new Float32Array(n);
  let vy = new Float32Array(n);
  let hNew = new Float32Array(n);
  let vxNew = new Float32Array(n);
  let vyNew = new Float32Array(n);

  // 8 outgoing mass values per cell
  const outMass = new Float32Array(n * 8);

  // Output accumulators
  const hMax = new Float32Array(n);
  const speedMax = new Float32Array(n);
  const pressMax = new Float32Array(n);

  // --- Initialize release cells ---
  let initialMassSum = 0;
  for (const [r, c] of releaseCells) {
    const idx = r * cols + c;
    if (idx >= 0 && idx < n && !isNaN(elevation[idx])) {
      h[idx] = snowDepthM;
      initialMassSum += snowDepthM;
    }
  }
  if (initialMassSum <= 0) {
    return emptyResult(dem);
  }

  const hRef = Math.max(snowDepthM * 0.3, 0.1);

  // --- Entrainment setup (self-calibrating target-based) ---
  // Instead of calibrating erosion rate to grid size (which fails because the
  // flow only touches a small fraction of steep cells), we track total entrained
  // mass and approach (entrainmentFactor - 1) × initialMass exponentially.
  let snowpack: Float32Array | null = null;
  let totalEntrained = 0;
  const entrainmentTarget = (entrainmentFactor - 1) * initialMassSum;

  if (entrainmentFactor > 1) {
    snowpack = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (!isNaN(elevation[i])) snowpack[i] = snowDepthM;
    }
    for (const [r, c] of releaseCells) {
      snowpack[r * cols + c] = 0;
    }
  }

  // Erosion time constant: approach target with ~95% reached by end of sim.
  // rate = -ln(0.05) / maxTime ≈ 3 / maxTime
  const erosionRate = 3.0 / maxTime;

  // --- Time integration ---
  let t = 0;
  let nSteps = 0;

  while (t < maxTime && nSteps < MAX_STEPS) {
    // Adaptive CFL timestep
    let maxWave = 0.5;
    for (let i = 0; i < n; i++) {
      if (h[i] <= THIN) continue;
      const speed = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
      const wave = speed + Math.sqrt(G * h[i]);
      if (wave > maxWave) maxWave = wave;
    }
    let dt = CFL * dx / maxWave;
    dt = Math.min(dt, maxTime - t, 2.0);
    if (dt < 1e-4) break;

    // Step 1: Gravity + hydrostatic pressure gradient
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (h[i] <= H_STOP) continue;

        let ax = -G * dzdx[i];
        let ay = -G * dzdy[i];

        const hE = (c < cols - 1 && !isNaN(elevation[i + 1])) ? h[i + 1] : h[i];
        const hW = (c > 0 && !isNaN(elevation[i - 1])) ? h[i - 1] : h[i];
        const hN = (r < rows - 1 && !isNaN(elevation[i + cols])) ? h[i + cols] : h[i];
        const hS = (r > 0 && !isNaN(elevation[i - cols])) ? h[i - cols] : h[i];

        ax -= G * (hE - hW) / (2 * dx);
        ay -= G * (hN - hS) / (2 * dx);

        vx[i] += dt * ax;
        vy[i] += dt * ay;
      }
    }

    // Step 2: Voellmy friction with depth-dependent enhancement
    for (let i = 0; i < n; i++) {
      if (h[i] <= H_STOP) {
        vx[i] = 0;
        vy[i] = 0;
        continue;
      }
      const speed = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
      if (speed < 1e-8) continue;

      const depthFactor = h[i] < hRef ? Math.min(hRef / h[i], MU_DEPTH_CAP) : 1;
      const tanS = Math.sqrt(dzdx[i] * dzdx[i] + dzdy[i] * dzdy[i]);
      const runoutT = Math.max(0, Math.min(1, (RUNOUT_TAN - tanS) / RUNOUT_WIDTH));
      const runoutFactor = 1 + RUNOUT_MU_GAIN * runoutT * runoutT * (3 - 2 * runoutT); // smoothstep
      const effectiveMu = mu * depthFactor * runoutFactor;
      const coulomb = effectiveMu * G * cosSlope[i];
      const turbulent = G * speed * speed / (xi * h[i]);
      const decel = coulomb + turbulent;
      const factor = 1 / (1 + dt * decel / speed);
      vx[i] *= factor;
      vy[i] *= factor;
    }

    // Step 3: Entrainment (self-calibrating target-based)
    // Two-pass: compute total flow intensity, then distribute erosion
    // proportionally so more entrainment where flow is deep and fast.
    if (snowpack && totalEntrained < entrainmentTarget) {
      // How much mass to entrain this step (exponential approach to target)
      const remaining = entrainmentTarget - totalEntrained;
      const stepFraction = 1 - Math.exp(-erosionRate * dt);
      const massThisStep = remaining * stepFraction;

      // Pass 1: sum flow intensity on steep cells
      let totalIntensity = 0;
      for (let i = 0; i < n; i++) {
        if (h[i] <= THIN || snowpack[i] <= 0) continue;
        const tanS = Math.sqrt(dzdx[i] * dzdx[i] + dzdy[i] * dzdy[i]);
        if (tanS < ENTRAIN_TAN) continue;
        const speed = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
        totalIntensity += speed * h[i];
      }

      // Pass 2: erode proportional to intensity
      if (totalIntensity > 0) {
        for (let i = 0; i < n; i++) {
          if (h[i] <= THIN || snowpack[i] <= 0) continue;
          const tanS = Math.sqrt(dzdx[i] * dzdx[i] + dzdy[i] * dzdy[i]);
          if (tanS < ENTRAIN_TAN) continue;
          const speed = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
          const intensity = speed * h[i];
          const erode = Math.min(massThisStep * intensity / totalIntensity, snowpack[i]);
          if (erode > 0) {
            h[i] += erode;
            snowpack[i] -= erode;
            totalEntrained += erode;
          }
        }
      }
    }

    // Step 4: 8-neighbor D∞ advection
    advect8(h, vx, vy, elevation, rows, cols, dx, dt, outMass, hNew, vxNew, vyNew);

    [h, hNew] = [hNew, h];
    [vx, vxNew] = [vxNew, vx];
    [vy, vyNew] = [vyNew, vy];

    // Step 5: Explicit diffusion — models lateral spreading of granular debris.
    // Prevents single-cell mass concentration from terrain micro-channeling.
    // Only applied to cells with substantial deposit (> 5cm) and low speed
    // to avoid spreading thin residuals or active flow in the track.
    const DIFF_COEFF = 0.3 * dx; // m²/s — scales with grid resolution
    const diffFactor = DIFF_COEFF * dt / (dx * dx);
    if (diffFactor > 0 && diffFactor < 0.25) {
      for (let i = 0; i < n; i++) {
        hNew[i] = h[i];
        if (h[i] <= 0.05) continue; // only diffuse meaningful deposits
        const sp = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
        if (sp > 1.0) continue; // don't diffuse fast-moving flow
        const tanS = Math.sqrt(dzdx[i] * dzdx[i] + dzdy[i] * dzdy[i]);
        if (tanS < 0.02) continue; // avoid spreading on (near-)flat terrain
        const ri = (i / cols) | 0;
        const ci = i % cols;
        const hC = h[i];
        const hE = ci < cols - 1 ? h[i + 1] : hC;
        const hW = ci > 0 ? h[i - 1] : hC;
        const hN = ri < rows - 1 ? h[i + cols] : hC;
        const hS = ri > 0 ? h[i - cols] : hC;
        hNew[i] = hC + diffFactor * (hE + hW + hN + hS - 4 * hC);
      }
      for (let i = 0; i < n; i++) h[i] = Math.max(hNew[i], 0);
    }

    // Step 6: Update maxima
    for (let i = 0; i < n; i++) {
      if (h[i] > hMax[i]) hMax[i] = h[i];
      if (h[i] > THIN) {
        const sp = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
        if (sp > speedMax[i]) speedMax[i] = sp;
        const p = 0.5 * density * sp * sp / 1000;
        if (p > pressMax[i]) pressMax[i] = p;
      }
    }

    t += dt;
    nSteps++;

    let maxSpeed = 0;
    let totalMass = 0;
    let movingMass = 0;
    let sumU = 0;
    let sumV = 0;
    let sumTanSlope = 0;
    for (let i = 0; i < n; i++) {
      if (h[i] > THIN) {
        const sp = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
        const m = h[i];
        totalMass += m;
        sumU += m * vx[i];
        sumV += m * vy[i];
        sumTanSlope += m * Math.sqrt(dzdx[i] * dzdx[i] + dzdy[i] * dzdy[i]);
        if (sp > MOVE_SPEED) movingMass += m;
        if (sp > maxSpeed) maxSpeed = sp;
      }
    }
    const comSpeed = totalMass > 0 ? Math.sqrt(sumU * sumU + sumV * sumV) / totalMass : 0;
    const movingFrac = totalMass > 0 ? movingMass / totalMass : 0;
    const avgTanSlope = totalMass > 0 ? sumTanSlope / totalMass : 0;
    if (
      t > MIN_STOP_TIME &&
      avgTanSlope < RUNOUT_TAN &&
      maxSpeed < 1.0 &&
      (comSpeed < COM_STOP_SPEED || movingFrac < MOVE_MASS_FRAC_STOP)
    ) {
      break;
    }
  }

  const entrainPct = entrainmentTarget > 0 ? (totalEntrained / entrainmentTarget * 100).toFixed(0) : '0';
  console.log(
    `[voellmy-2d] ${nSteps} steps, t=${t.toFixed(1)}s, mu=${mu}, xi=${xi}, entrained=${totalEntrained.toFixed(2)}m/${entrainmentTarget.toFixed(2)}m (${entrainPct}%)`
  );

  // --- Clean up thin residuals (use lower threshold than H_STOP to preserve
  //     diffusion-spread deposits that are still physically meaningful) ---
  for (let i = 0; i < n; i++) {
    if (h[i] < 0.002) h[i] = 0; // 2mm threshold
  }

  // --- Mass conservation ---
  let finalMassSum = 0;
  for (let i = 0; i < n; i++) finalMassSum += h[i];
  const totalInputMass = initialMassSum + totalEntrained;
  const massBalanceError = totalInputMass > 0 ? (finalMassSum - totalInputMass) / totalInputMass : 0;

  const cellCount = new Uint16Array(n);
  const zMaxDelta = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    cellCount[i] = hMax[i] > THIN ? 1 : 0;
    zMaxDelta[i] = speedMax[i];
  }

  return {
    origin: dem.origin,
    cellSize: dem.cellSize,
    cols,
    rows,
    zMaxDelta,
    rMax: speedMax,
    cellCount,
    deposition: h,
    hMax,
    vMaxGrid: speedMax,
    pMaxGrid: pressMax,
    solverInfo: {
      type: 'voellmy-2d',
      simulationTime: t,
      timeSteps: nSteps,
      massConservation: initialMassSum > 0 ? finalMassSum / initialMassSum : 1,
      massInitial: initialMassSum,
      massEntrained: totalEntrained,
      massDeposited: finalMassSum,
      massBalanceError,
    },
  };
}

/**
 * Smooth DEM elevation with repeated 3×3 averaging passes.
 * Removes single-cell terrain noise and quantization artifacts from
 * MapLibre terrain tiles. Preserves NaN boundaries.
 */
function smoothElevation(
  elevation: Float32Array,
  rows: number,
  cols: number,
  passes: number
): Float32Array {
  const n = rows * cols;
  let src = new Float32Array(elevation);
  let dst = new Float32Array(n);

  for (let p = 0; p < passes; p++) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (isNaN(src[i])) { dst[i] = NaN; continue; }
        let sum = 0;
        let count = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const nr = r + dr, nc = c + dc;
            if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
            const val = src[nr * cols + nc];
            if (!isNaN(val)) { sum += val; count++; }
          }
        }
        dst[i] = sum / count;
      }
    }
    [src, dst] = [dst, src];
  }
  return src;
}

function precomputeSlopes(
  elevation: Float32Array,
  rows: number,
  cols: number,
  dx: number,
  dzdx: Float32Array,
  dzdy: Float32Array,
  cosSlope: Float32Array
): void {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const zC = elevation[i];
      if (isNaN(zC)) {
        cosSlope[i] = 1;
        continue;
      }

      const zE = c < cols - 1 ? elevation[i + 1] : NaN;
      const zW = c > 0 ? elevation[i - 1] : NaN;
      const eOk = !isNaN(zE);
      const wOk = !isNaN(zW);
      if (eOk && wOk) dzdx[i] = (zE - zW) / (2 * dx);
      else if (eOk) dzdx[i] = (zE - zC) / dx;
      else if (wOk) dzdx[i] = (zC - zW) / dx;

      const zN = r < rows - 1 ? elevation[(r + 1) * cols + c] : NaN;
      const zS = r > 0 ? elevation[(r - 1) * cols + c] : NaN;
      const nOk = !isNaN(zN);
      const sOk = !isNaN(zS);
      if (nOk && sOk) dzdy[i] = (zN - zS) / (2 * dx);
      else if (nOk) dzdy[i] = (zN - zC) / dx;
      else if (sOk) dzdy[i] = (zC - zS) / dx;

      const slopeSq = dzdx[i] * dzdx[i] + dzdy[i] * dzdy[i];
      cosSlope[i] = 1 / Math.sqrt(1 + slopeSq);
    }
  }
}

/**
 * 8-neighbor D∞ advection (mass-conserving).
 *
 * For each cell, compute the velocity angle and split flux between the two
 * bracketing directions (out of 8). This eliminates the staircase artifacts
 * of 4-neighbor advection on diagonal terrain. Based on D∞ flow routing
 * (Tarboton 1997) adapted for velocity-based mass transport.
 */
function advect8(
  h: Float32Array,
  vx: Float32Array,
  vy: Float32Array,
  elevation: Float32Array,
  rows: number,
  cols: number,
  dx: number,
  dt: number,
  outMass: Float32Array,
  hNew: Float32Array,
  vxNew: Float32Array,
  vyNew: Float32Array
): void {
  const n = rows * cols;
  const dtdx = dt / dx;

  // Phase 1: compute outgoing mass per cell using D∞ direction bracketing
  outMass.fill(0);

  for (let i = 0; i < n; i++) {
    if (h[i] <= THIN) continue;

    const ux = vx[i];
    const uy = vy[i];
    const speed = Math.sqrt(ux * ux + uy * uy);
    if (speed < 1e-8) continue;

    const r = (i / cols) | 0;
    const c = i % cols;

    // Velocity angle in [0, 2π)
    let angle = Math.atan2(uy, ux);
    if (angle < 0) angle += TWO_PI;

    // Bracketing sector: two adjacent directions that bound the velocity angle
    const sector = Math.floor(angle / SECTOR_SIZE) % 8;
    const nextSector = (sector + 1) % 8;
    const alpha = (angle - sector * SECTOR_SIZE) / SECTOR_SIZE;

    // Check if each direction is blocked by a NaN wall
    const nc1 = c + DIR_DC[sector], nr1 = r + DIR_DR[sector];
    const inBounds1 = nc1 >= 0 && nc1 < cols && nr1 >= 0 && nr1 < rows;
    const blocked1 = inBounds1 && isNaN(elevation[nr1 * cols + nc1]);

    const nc2 = c + DIR_DC[nextSector], nr2 = r + DIR_DR[nextSector];
    const inBounds2 = nc2 >= 0 && nc2 < cols && nr2 >= 0 && nr2 < rows;
    const blocked2 = inBounds2 && isNaN(elevation[nr2 * cols + nc2]);

    // Redirect blocked flux to the other direction
    let w1: number, w2: number;
    if (blocked1 && blocked2) continue; // both walls, no outflow
    else if (blocked1) { w1 = 0; w2 = 1; }
    else if (blocked2) { w1 = 1; w2 = 0; }
    else { w1 = 1 - alpha; w2 = alpha; }

    const dist1 = (sector & 1) ? Math.SQRT2 : 1;
    const dist2 = (nextSector & 1) ? Math.SQRT2 : 1;
    let f1 = (speed * dtdx / dist1) * w1;
    let f2 = (speed * dtdx / dist2) * w2;
    const total = f1 + f2;
    if (total > 0.9) {
      const s = 0.9 / total;
      f1 *= s;
      f2 *= s;
    }
    const o = i * 8;
    if (f1 > 0.001) outMass[o + sector] = h[i] * f1;
    if (f2 > 0.001) outMass[o + nextSector] = h[i] * f2;
  }

  // Phase 2: apply fluxes — update h, transport momentum with mass
  for (let i = 0; i < n; i++) {
    const o = i * 8;
    let mOut = 0;
    for (let d = 0; d < 8; d++) mOut += outMass[o + d];

    let hSum = h[i] - mOut;
    let huSum = hSum * vx[i];
    let hvSum = hSum * vy[i];

    const r = (i / cols) | 0;
    const c = i % cols;

    // Incoming from each of 8 neighbors
    for (let d = 0; d < 8; d++) {
      const nc = c + DIR_DC[d];
      const nr = r + DIR_DR[d];
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
      const j = nr * cols + nc;

      // Inverse direction: if we look east to neighbor, their west flux comes to us
      const inv = (d + 4) & 7; // (d+4) % 8 using bitmask
      const m = outMass[j * 8 + inv];
      if (m > 0) {
        hSum += m;
        huSum += m * vx[j];
        hvSum += m * vy[j];
      }
    }

    hNew[i] = Math.max(hSum, 0);
    if (hNew[i] > THIN) {
      vxNew[i] = huSum / hNew[i];
      vyNew[i] = hvSum / hNew[i];
    } else {
      hNew[i] = 0;
      vxNew[i] = 0;
      vyNew[i] = 0;
    }
  }
}

function emptyResult(dem: VirtualDEM): FlowPyGridResult {
  const n = dem.rows * dem.cols;
  return {
    origin: dem.origin,
    cellSize: dem.cellSize,
    cols: dem.cols,
    rows: dem.rows,
    zMaxDelta: new Float32Array(n),
    rMax: new Float32Array(n),
    cellCount: new Uint16Array(n),
    deposition: new Float32Array(n),
    solverInfo: { type: 'voellmy-2d', simulationTime: 0, timeSteps: 0, massConservation: 1 },
  };
}
