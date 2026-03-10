const DEFAULT_ENTRAINMENT_FACTOR = 2.0;

/**
 * Estimate avalanche volume in cubic meters.
 *
 * @param areaSqMeters - Starting zone area in m²
 * @param snowDepthCm - Slab depth in centimeters
 * @param entrainmentFactor - Multiplier for snow picked up along the track (default 2.0)
 */
export function computeVolume(
  areaSqMeters: number,
  snowDepthCm: number,
  entrainmentFactor: number = DEFAULT_ENTRAINMENT_FACTOR
): number {
  const snowDepthMeters = snowDepthCm / 100;
  return areaSqMeters * snowDepthMeters * entrainmentFactor;
}
