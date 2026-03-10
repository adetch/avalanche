import type { SnowProfile } from "@/types";

/**
 * Snow type presets with physical parameters.
 * Sources: Bartelt et al. (1999), Salm et al. (1990), Sovilla et al. (2006)
 */
export const SNOW_PROFILES: SnowProfile[] = [
  {
    id: "dry-slab",
    label: "Dry Slab",
    density: 250,
    entrainmentFactor: 2.0,
    frictionMu: 0.3,
    frictionXi: 1500,
  },
  {
    id: "dry-loose",
    label: "Dry Loose",
    density: 80,
    entrainmentFactor: 1.5,
    frictionMu: 0.4,
    frictionXi: 2000,
  },
  {
    id: "wind-slab",
    label: "Wind Slab",
    density: 350,
    entrainmentFactor: 2.0,
    frictionMu: 0.3,
    frictionXi: 1500,
  },
  {
    id: "wet-slab",
    label: "Wet Slab",
    density: 400,
    entrainmentFactor: 3.5,
    frictionMu: 0.35,
    frictionXi: 1000,
  },
  {
    id: "wet-loose",
    label: "Wet Loose",
    density: 350,
    entrainmentFactor: 3.0,
    frictionMu: 0.45,
    frictionXi: 800,
  },
  {
    id: "glide",
    label: "Glide",
    density: 450,
    entrainmentFactor: 4.0,
    frictionMu: 0.25,
    frictionXi: 1200,
  },
];

export const DEFAULT_SNOW_PROFILE = SNOW_PROFILES[0]; // Dry Slab

export function findSnowProfile(id: string): SnowProfile | undefined {
  return SNOW_PROFILES.find((p) => p.id === id);
}
