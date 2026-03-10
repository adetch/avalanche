/**
 * Classify avalanche destructive size (D1–D5)
 * based on estimated mass in tonnes (CAA/EAWS scale).
 *
 * Mass thresholds (tonnes):
 * D1: < 10 t        Relatively harmless to people
 * D2: 10–100 t      Could bury/injure/kill a person
 * D3: 100–1,000 t   Could destroy a car or small building
 * D4: 1k–10k t      Could destroy a railway car or large building
 * D5: > 10k t       Could destroy a village or 40 ha of forest
 */
export function classifyDestructiveSize(
  massTonnes: number
): 1 | 2 | 3 | 4 | 5 {
  if (massTonnes < 10) return 1;
  if (massTonnes < 100) return 2;
  if (massTonnes < 1_000) return 3;
  if (massTonnes < 10_000) return 4;
  return 5;
}

export const DESTRUCTIVE_SIZE_INFO: Record<
  1 | 2 | 3 | 4 | 5,
  { label: string; description: string; color: string }
> = {
  1: {
    label: "D1",
    description: "Relatively harmless to people",
    color: "#22C55E",
  },
  2: {
    label: "D2",
    description: "Could bury, injure, or kill a person",
    color: "#EAB308",
  },
  3: {
    label: "D3",
    description: "Could destroy a car or small building",
    color: "#F97316",
  },
  4: {
    label: "D4",
    description: "Could destroy a large building",
    color: "#EF4444",
  },
  5: {
    label: "D5",
    description: "Could destroy a village or 40 ha of forest",
    color: "#7F1D1D",
  },
};
