import type { ElevationPoint, SnowProfile } from "@/types";

const G = 9.81; // m/s²

export interface VoellmyResult {
  /** Velocity at each profile point (m/s). 0 where flow hasn't reached or has stopped. */
  velocity: number[];
  /** Maximum velocity along the path (m/s) */
  maxVelocity: number;
  /** Impact pressure at each profile point (kPa). P = 0.5 * density * v² */
  pressure: number[];
  /** Maximum impact pressure (kPa) */
  maxPressure: number;
  /** Dynamic runout distance (m from crown) — where velocity drops to 0 */
  dynamicRunout: number;
  /** Index of the dynamic runout point in the profile */
  dynamicRunoutIdx: number;
}

/**
 * 1D Voellmy friction model along an existing elevation profile.
 *
 * Computes velocity evolution using the Voellmy rheology:
 *   acceleration = g·sin(θ) - μ·g·cos(θ) - g·v²/(ξ·h)
 *
 * where:
 *   θ = local slope angle
 *   μ = Coulomb friction coefficient
 *   ξ = turbulent friction coefficient (m/s²)
 *   h = flow depth (m)
 *   v = flow velocity (m/s)
 *
 * Uses explicit Euler integration with adaptive time stepping (CFL condition).
 * Based on the MinVoellmy approach (Hergarten 2024).
 *
 * @param profile - Elevation profile points from crown
 * @param snowProfile - Snow conditions (density, mu, xi)
 * @param releaseDepthM - Initial slab depth in meters
 * @param releaseLength - Length of release zone along profile (meters)
 */
export function runVoellmy1D(
  profile: ElevationPoint[],
  snowProfile: SnowProfile,
  releaseDepthM: number,
  releaseLength: number = 100
): VoellmyResult {
  const n = profile.length;
  if (n < 3) {
    return {
      velocity: new Array(n).fill(0),
      maxVelocity: 0,
      pressure: new Array(n).fill(0),
      maxPressure: 0,
      dynamicRunout: 0,
      dynamicRunoutIdx: 0,
    };
  }

  const { frictionMu: mu, frictionXi: xi, density } = snowProfile;

  // Compute local slope at each profile point
  const slopes = computeLocalSlopes(profile);

  // Step size between profile points (assumed uniform from gradient-following)
  const ds = profile.length > 1
    ? (profile[profile.length - 1].distanceFromCrown - profile[0].distanceFromCrown) / (n - 1)
    : 10;

  // Initialize: velocity = 0 everywhere, flow depth = releaseDepth in release zone
  const velocity = new Array(n).fill(0);
  const flowDepth = new Array(n).fill(0);

  // Set initial release zone (first releaseLength meters)
  const releaseCells = Math.max(1, Math.floor(releaseLength / ds));
  for (let i = 0; i < Math.min(releaseCells, n); i++) {
    flowDepth[i] = releaseDepthM;
  }

  // Time stepping
  const maxTime = 600; // 10 minutes max simulation time
  const minDt = 0.01;
  const maxDt = 1.0;
  let t = 0;
  let converged = false;

  while (t < maxTime && !converged) {
    // CFL-based adaptive time step
    const vMax = Math.max(...velocity.map(Math.abs), 0.1);
    const dt = Math.min(maxDt, Math.max(minDt, 0.5 * ds / vMax));
    t += dt;

    let anyMoving = false;

    // Forward sweep: update velocity based on forces, then advect
    for (let i = 0; i < n; i++) {
      const h = flowDepth[i];
      if (h < 0.01) continue; // no snow here

      const sinTheta = Math.sin(slopes[i]);
      const cosTheta = Math.cos(slopes[i]);
      const v = velocity[i];

      // Voellmy acceleration
      // Driving force: gravity component along slope
      const gravDrive = G * sinTheta;
      // Coulomb friction: opposes motion, proportional to normal force
      const coulombDrag = mu * G * cosTheta;
      // Turbulent friction: velocity-dependent
      const turbDrag = h > 0.01 ? (G * v * v) / (xi * h) : 0;

      // Net acceleration
      const accel = gravDrive - coulombDrag - turbDrag;

      // Update velocity
      let vNew = v + accel * dt;
      if (vNew < 0) vNew = 0; // flow can't go backwards

      velocity[i] = vNew;

      if (vNew > 0.1) anyMoving = true;

      // Simple advection: move mass downstream
      if (vNew > 0 && i < n - 1) {
        const massFlux = h * vNew * dt / ds;
        const transfer = Math.min(massFlux, h * 0.5); // limit to half the cell
        flowDepth[i] -= transfer;
        flowDepth[i + 1] += transfer;
      }
    }

    if (!anyMoving) converged = true;
  }

  // Final pass: compute max velocity and pressure at each point from the
  // time-integrated result. Since we only track final state, re-run a
  // steady-state velocity estimate at each point using the energy balance.
  const steadyVelocity = computeSteadyStateVelocity(profile, slopes, mu, xi, releaseDepthM, snowProfile.entrainmentFactor);
  const pressureArr = steadyVelocity.map((v) => 0.5 * density * v * v / 1000); // Pa → kPa

  // Find dynamic runout: last point with meaningful velocity
  let dynamicRunoutIdx = 0;
  let maxVelocity = 0;
  let maxPressure = 0;
  for (let i = 0; i < n; i++) {
    if (steadyVelocity[i] > 0.5) {
      dynamicRunoutIdx = i;
    }
    if (steadyVelocity[i] > maxVelocity) maxVelocity = steadyVelocity[i];
    if (pressureArr[i] > maxPressure) maxPressure = pressureArr[i];
  }

  const dynamicRunout = profile[dynamicRunoutIdx]?.distanceFromCrown ?? 0;

  return {
    velocity: steadyVelocity,
    maxVelocity,
    pressure: pressureArr,
    maxPressure,
    dynamicRunout,
    dynamicRunoutIdx,
  };
}

/**
 * Compute steady-state velocity at each profile point using the Voellmy
 * energy balance (no time-stepping needed for the equilibrium speed).
 *
 * At each point along the path, the equilibrium velocity is:
 *   v² = ξ·h·(sin(θ) - μ·cos(θ))  when sin(θ) > μ·cos(θ)
 *
 * Below the equilibrium slope angle (where friction exceeds gravity),
 * velocity decays based on available kinetic energy.
 *
 * Path-varying entrainment: flow depth grows in the track zone (slope > 10°)
 * as the avalanche erodes and incorporates snow from the snowpack. In the
 * runout zone (slope < 10°), entrainment stops and deposition begins.
 * Based on Sovilla et al. (2006) entrainment model.
 */
function computeSteadyStateVelocity(
  profile: ElevationPoint[],
  slopes: number[],
  mu: number,
  xi: number,
  flowDepthM: number,
  entrainmentFactor: number
): number[] {
  const n = profile.length;
  const v = new Array(n).fill(0);

  // Track kinetic energy (0.5 * v²) along the path
  let kineticEnergy = 0;
  let currentDepth = flowDepthM;

  // Entrainment rate: how much depth grows per meter of travel in the track zone.
  // Total growth = entrainmentFactor × releaseDepth over the full track.
  // We distribute this proportionally per step.
  const trackSlopeThreshold = (10 * Math.PI) / 180; // 10° in radians

  // Estimate track length (distance where slope > 10°) for rate normalization
  let trackLength = 0;
  for (let i = 1; i < n; i++) {
    if (slopes[i] > trackSlopeThreshold) {
      trackLength +=
        profile[i].distanceFromCrown - profile[i - 1].distanceFromCrown;
    }
  }

  // Entrainment rate: total additional depth divided over track length
  // (entrainmentFactor - 1) because factor=1 means no extra snow picked up
  const extraDepth = flowDepthM * Math.max(entrainmentFactor - 1, 0);
  const entrainmentRate = trackLength > 0 ? extraDepth / trackLength : 0;

  // Deposition rate in runout zone: lose depth gradually
  let runoutLength = 0;
  for (let i = 1; i < n; i++) {
    if (slopes[i] <= trackSlopeThreshold) {
      runoutLength +=
        profile[i].distanceFromCrown - profile[i - 1].distanceFromCrown;
    }
  }
  // Deposit enough to halve the flow depth over the runout zone
  const depositionRate =
    runoutLength > 0 ? (currentDepth * 0.5) / runoutLength : 0;

  for (let i = 1; i < n; i++) {
    const ds =
      profile[i].distanceFromCrown - profile[i - 1].distanceFromCrown;
    if (ds <= 0) continue;

    // Path-varying entrainment
    if (slopes[i] > trackSlopeThreshold) {
      // Track zone: erode and incorporate snow
      currentDepth += entrainmentRate * ds;
    } else {
      // Runout zone: gradual deposition
      currentDepth = Math.max(currentDepth - depositionRate * ds, flowDepthM * 0.3);
    }

    const sinTheta = Math.sin(slopes[i]);
    const cosTheta = Math.cos(slopes[i]);

    // Net force per unit mass along the slope
    const vPrev = Math.sqrt(2 * Math.max(kineticEnergy, 0));
    const turbDrag =
      currentDepth > 0.01 ? (G * vPrev * vPrev) / (xi * currentDepth) : 0;
    const netAccel = G * sinTheta - mu * G * cosTheta - turbDrag;

    // Update kinetic energy: ΔKE = force · distance
    kineticEnergy += netAccel * ds;
    if (kineticEnergy < 0) kineticEnergy = 0;

    v[i] = Math.sqrt(2 * kineticEnergy);
  }

  return v;
}

/**
 * Compute local slope angle (radians) at each profile point.
 */
function computeLocalSlopes(profile: ElevationPoint[]): number[] {
  const n = profile.length;
  const slopes = new Array(n).fill(0);

  for (let i = 0; i < n - 1; i++) {
    const ds =
      profile[i + 1].distanceFromCrown - profile[i].distanceFromCrown;
    const dz = profile[i].elevation - profile[i + 1].elevation;
    if (ds > 0) {
      slopes[i] = Math.atan2(dz, ds);
    }
  }
  // Last point inherits from previous
  if (n > 1) slopes[n - 1] = slopes[n - 2];

  return slopes;
}
