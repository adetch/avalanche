/**
 * Fast local coordinate offset using flat-Earth approximation.
 *
 * For distances <5km the error vs. geodesic is <0.1%.
 * Replaces turf.destination() which does full Vincenty geodesic math.
 */

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const EARTH_RADIUS_M = 6371000;

/**
 * Offset a [lng, lat] by a distance (meters) and bearing (degrees, 0=N, 90=E).
 * Returns a new [lng, lat].
 */
export function offsetPoint(
  lngLat: [number, number],
  distanceM: number,
  bearingDeg: number
): [number, number] {
  const bearingRad = bearingDeg * DEG_TO_RAD;
  const latRad = lngLat[1] * DEG_TO_RAD;

  // Meters per degree at this latitude
  const mPerDegLat = EARTH_RADIUS_M * DEG_TO_RAD;
  const mPerDegLng = EARTH_RADIUS_M * DEG_TO_RAD * Math.cos(latRad);

  const dNorth = distanceM * Math.cos(bearingRad); // meters north
  const dEast = distanceM * Math.sin(bearingRad);  // meters east

  const newLat = lngLat[1] + dNorth / mPerDegLat;
  const newLng = lngLat[0] + dEast / mPerDegLng;

  return [newLng, newLat];
}

/**
 * Compute bearing (degrees, 0=N) from point a to point b.
 * Fast flat-Earth version for short distances.
 */
export function fastBearing(
  a: [number, number],
  b: [number, number]
): number {
  const latRad = a[1] * DEG_TO_RAD;
  const dLng = (b[0] - a[0]) * Math.cos(latRad);
  const dLat = b[1] - a[1];
  let bearing = Math.atan2(dLng, dLat) * RAD_TO_DEG;
  if (bearing < 0) bearing += 360;
  return bearing;
}

/**
 * Compute distance (meters) between two [lng, lat] points.
 * Fast flat-Earth version for short distances.
 */
export function fastDistance(
  a: [number, number],
  b: [number, number]
): number {
  const latRad = ((a[1] + b[1]) / 2) * DEG_TO_RAD;
  const dLat = (b[1] - a[1]) * DEG_TO_RAD * EARTH_RADIUS_M;
  const dLng = (b[0] - a[0]) * DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(latRad);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}
