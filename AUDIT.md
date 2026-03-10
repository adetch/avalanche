# Avalanche Path Estimator — Deficiency Audit & Improvement Plan

## 1. Deficiency Audit

### CRITICAL — Affects correctness of core results

#### C1. No standard deviation / return period in alpha-beta model
**File:** `src/lib/avalanche/alpha-beta.ts:55`
**Current:** `α = 0.96β - 1.4`
**Problem:** This gives the *mean* runout. Approximately 50% of real avalanches at any given path will run further. The original Lied & Bakkehøi (1980) model includes σ ≈ 2.3°. Engineering practice uses `α = 0.96β - 1.4 - k·σ` where k depends on desired return period (k=1 for ~84th percentile, k=2 for ~97th / ~100-year).
**Impact:** The tool systematically underestimates extreme runout, which is the scenario users actually care about.
**Fix:** Add a `returnPeriod` or `confidenceLevel` parameter. Compute `α = 0.96β - 1.4 - k·σ` where σ=2.3. Display both mean and conservative runout on the map.

#### C2. Region-locked regression coefficients
**File:** `src/lib/avalanche/alpha-beta.ts:55`
**Current:** Hard-coded Norwegian coefficients (0.96, -1.4)
**Problem:** Published regional calibrations differ significantly:
| Region | a | b | σ | Source |
|--------|------|------|-----|--------|
| Norway | 0.96 | -1.4 | 2.3 | Lied & Bakkehøi (1980) |
| Canadian Rockies | 0.93 | -0.1 | 2.5 | McClung & Mears (1991) |
| Colorado | 0.92 | +0.3 | 2.2 | Mears (1989) |
| Iceland | 0.91 | -0.7 | 2.0 | Jóhannesson (1998) |
| Sierra Nevada | 0.91 | +1.2 | — | Mears (1992) |

Using Norwegian coefficients in Colorado could shift runout estimates by hundreds of meters.
**Fix:** Add a region selector (or auto-detect from coordinates). Store coefficient sets in a config object.

#### C3. D-size uses volume instead of mass — off by ~1 class
**File:** `src/lib/avalanche/destructive-size.ts`
**Current:** Volume thresholds (100, 1k, 10k, 100k m³) implicitly assume ~100 kg/m³ density.
**Problem:** The CAA/EAWS destructive size scale is mass-based. Typical slab density is 200–350 kg/m³. At 300 kg/m³, a 500 m³ avalanche has 150 tonnes — solidly D3 by mass, but the code classifies it as D2.
**Fix:** Introduce a snow density parameter. Compute mass = volume × density. Classify on mass thresholds (D1 <10t, D2 10–100t, D3 100–1000t, D4 1k–10kt, D5 >10kt).

#### C4. cos() fallback bug in volume computation
**File:** `src/lib/avalanche/compute.ts:98`
**Current:** `const slopeAreaFactor = 1 / Math.cos(slopeRad || 1)`
**Problem:** When `slopeRad` is 0 (flat terrain), the `||` operator falls through to `1` — that's 1 *radian* (57.3°), producing `1/cos(57.3°) ≈ 1.85×` area inflation on flat ground. On actual slopes, the code works correctly since `slopeRad` is truthy.
**Fix:** Change to `1 / Math.cos(slopeRad)` or `1 / (Math.cos(slopeRad) || 1)`. A 0° slope should produce factor = 1.0.

---

### HIGH — Affects quality / reliability of results

#### H1. Fixed entrainment factor (2.0×)
**File:** `src/lib/avalanche/volume.ts:1`
**Current:** Constant `DEFAULT_ENTRAINMENT_FACTOR = 2.0`
**Problem:** Entrainment varies widely by snow type, path confinement, and avalanche size:
- Dry loose: 1.5–2×
- Wet slab: 3–6× (Sovilla et al., 2006)
- Large channelized: up to 10× (Bartelt et al., 2012)
A fixed 2.0× is reasonable for dry slab but significantly underestimates wet or large events.
**Fix:** Make entrainment a function of snow type and estimated D-size. Expose as a user-adjustable parameter with sensible defaults per snow type preset.

#### H2. No snow density parameter
**Files:** `volume.ts`, `destructive-size.ts`, store, UI
**Current:** No density input exists anywhere. Volume is computed as area × depth × entrainment without any density consideration.
**Problem:** Density ranges from ~50 kg/m³ (fresh dry) to ~500 kg/m³ (wet settled). This 10× range directly affects mass, D-size, and (in more advanced models) runout energy.
**Fix:** Add a density parameter to the store and UI. Use it in mass-based D-size classification. Offer presets by snow type (see Snow Settings section below).

#### H3. Fall-line direction is coarse
**File:** `src/lib/avalanche/fall-line.ts`
**Current:** 16 compass directions at 50m radius → 22.5° angular resolution.
**Problem:** True fall-line can be missed by up to ~11°. Over a 1km runout, 11° lateral error displaces the path by ~190m.
**Fix:** Two-stage approach: coarse 16-direction sweep, then fine ±15° sweep at 2° intervals around the winner. Or compute gradient from 4 nearest DEM samples.

#### H4. Gentle-terrain runout overestimation
**File:** `src/lib/avalanche/alpha-beta.ts:86-102`
**Current:** If terrain never drops below the alpha line, `wasBelow` never triggers, and the function returns the last profile point (3000m).
**Problem:** On gentle terrain where the alpha line runs above the surface for the entire profile, the code reports the maximum possible runout distance — a false extreme.
**Fix:** Also check for the point where the alpha line is closest to the terrain (minimum gap). If `wasBelow` never triggers, return the closest-approach point instead of the profile end.

#### H5. Profile extraction terminates prematurely at counter-slopes
**File:** `src/lib/avalanche/profile.ts:36`
**Current:** Stops when 3 consecutive points go uphill.
**Problem:** Runout zones commonly include short uphill sections (moraines, opposing valley walls). McClung & Schaerer (2006) document avalanches running partway up opposing slopes. The current logic would cut the profile short and miss the actual deposition area.
**Fix:** Increase uphill tolerance to 5+ points, or allow uphill sections up to a maximum elevation gain (e.g., 30m above a local minimum).

---

### MEDIUM — Affects usability and user understanding

#### M1. No snow type / condition presets
**Current:** Only two inputs: snow depth and slope angle.
**Problem:** Users have no way to express whether they're looking at a dry slab, wet slab, wind slab, or loose snow scenario. These conditions dramatically change density, entrainment, and (in dynamic models) friction parameters.
**Fix:** Add a snow type selector with presets (see Section 2 below).

#### M2. Runout zone width is arbitrary
**File:** `src/lib/avalanche/zones.ts:71`
**Current:** `widthMeters * 1.5` — a hard-coded multiplier.
**Problem:** Lateral spreading depends on confinement. Channelized paths don't spread; open slopes may spread 3×+.
**Fix:** Classify path confinement from terrain (detect gully walls from cross-slope profile) and adjust multiplier: channelized → 1.0×, open slope → 2.0–2.5×.

#### M3. No confidence / uncertainty display
**Current:** Single runout line shown on map.
**Problem:** Users see a precise-looking answer for an inherently uncertain estimate. No indication of model limitations.
**Fix:** Display runout as a gradient/band: mean α, α-1σ, α-2σ. Color-code from "likely" to "possible" to "extreme".

#### M4. Starting zone identified from polygon vertices only
**File:** `src/lib/avalanche/compute.ts:37`
**Current:** Crown = highest vertex of the user-drawn polygon.
**Problem:** If the user draws imprecisely, the crown could be the wrong point. The actual highest terrain within the polygon may differ from the highest vertex.
**Fix:** Sample a grid of points within the polygon and find the true highest point inside the starting zone, not just among vertices.

#### M5. Maximum profile distance too short for D5 events
**File:** `src/lib/avalanche/profile.ts` (via `compute.ts:48`)
**Current:** `maxDistanceMeters = 3000`
**Problem:** Documented D4/D5 runouts exceed 5km. The 3km cap truncates extreme events.
**Fix:** Scale max distance by estimated D-size or terrain drop. Use 5000m default.

---

### LOW — Minor improvements

#### L1. Slope angle input is display-only, not used
**File:** `src/lib/avalanche/compute.ts:31` — `_slopeAngle` parameter is unused.
**Problem:** The UI lets users see slope angle but the DEM-computed value overrides it. The underscore-prefixed parameter suggests awareness, but the user has no way to override a bad DEM reading.
**Fix:** Either remove the parameter entirely or allow user override when DEM data is suspect.

#### L2. 180° fallback for fall-line direction
**File:** `src/lib/avalanche/fall-line.ts:16`
**Current:** Falls back to due south when elevation query fails.
**Problem:** Arbitrary; could produce results on the wrong side of a ridge.
**Fix:** Return null and surface an error to the user instead of silently producing wrong results.

#### L3. Beta point threshold is non-standard for some regions
**File:** `src/lib/avalanche/alpha-beta.ts:4`
**Current:** 10° threshold.
**Problem:** Some authors use 24° for the β-point in North American terrain analysis (the start-zone-to-track transition). The 10° definition (track-to-runout) is correct per the original Norwegian method but may confuse practitioners trained on the 24° convention.
**Fix:** Document which convention is used. Consider exposing as an advanced parameter.

---

## 2. Snow Type / Parameters Settings Design

### Proposed Snow Type Presets

Add a `SnowProfile` type that bundles the physical parameters affecting calculations:

```typescript
interface SnowProfile {
  id: string;
  label: string;
  description: string;
  density: number;         // kg/m³ — for mass-based D-size
  entrainmentFactor: number; // multiplier on initial volume
  frictionMu: number;       // Coulomb friction (for future dynamic model)
  frictionXi: number;       // turbulent friction (for future dynamic model)
}
```

#### Preset values (derived from literature):

| Preset | Density | Entrainment | μ | ξ (m/s²) | Source |
|--------|---------|-------------|------|----------|--------|
| Dry loose | 80 | 1.5 | 0.40 | 2000 | Bartelt et al. (1999) |
| Dry slab | 250 | 2.0 | 0.30 | 1500 | Salm et al. (1990) |
| Wind slab | 350 | 2.0 | 0.30 | 1500 | — |
| Wet slab | 400 | 3.5 | 0.35 | 1000 | Sovilla et al. (2006) |
| Wet loose | 350 | 3.0 | 0.45 | 800 | — |
| Glide | 450 | 4.0 | 0.25 | 1200 | — |
| Custom | user | user | user | user | — |

#### UI Approach

Add a **"Snow Conditions"** collapsible section to the ControlPanel between "Snow Depth" and "Starting Zone":

```
┌─────────────────────────────┐
│ Snow Conditions             │
│                             │
│ Type: [Dry Slab ▾]         │
│                             │
│ Density     250 kg/m³   ●  │  ← slider, auto-set by preset
│ Entrainment 2.0×        ●  │  ← slider, auto-set by preset
│                             │
│ ▸ Advanced                  │  ← collapsed by default
│   μ (Coulomb)   0.30       │
│   ξ (Turbulent) 1500       │
└─────────────────────────────┘
```

- Selecting a preset fills in all values
- User can then adjust individual sliders (switches to "Custom" label)
- Advanced friction params hidden until expanded (future use with Voellmy model)

#### Store changes

Add to `useAvalancheStore`:
```typescript
snowProfile: SnowProfile;     // active profile
setSnowProfile: (p: SnowProfile) => void;
setSnowDensity: (d: number) => void;
setEntrainment: (e: number) => void;
```

#### Calculation changes

- `computeVolume()` — use `snowProfile.entrainmentFactor` instead of constant 2.0
- `classifyDestructiveSize()` — accept mass (volume × density), re-threshold on mass scale
- Display both volume and mass in ResultsDisplay

---

## 3. Prioritized Implementation Plan

Priority is ordered by: impact on result correctness × effort, with safety-critical items first.

### Phase 1 — Critical Fixes (correctness)

| # | Task | Deficiency | Effort |
|---|------|-----------|--------|
| 1.1 | Fix cos() fallback bug | C4 | 5 min |
| 1.2 | Add σ term to alpha-beta model | C1 | 1 hr |
| 1.3 | Add snow type presets + density param | C3, H1, H2, M1 | 3 hr |
| 1.4 | Switch D-size to mass-based thresholds | C3 | 30 min |
| 1.5 | Add regional coefficient sets | C2 | 1 hr |

**Deliverable:** Correct core model with configurable snow conditions. All results become physically reasonable across regions and snow types.

### Phase 2 — Reliability Improvements

| # | Task | Deficiency | Effort |
|---|------|-----------|--------|
| 2.1 | Fix gentle-terrain runout overestimation | H4 | 1 hr |
| 2.2 | Improve fall-line resolution (two-stage sweep) | H3 | 1 hr |
| 2.3 | Increase uphill tolerance in profile extraction | H5 | 30 min |
| 2.4 | Return error instead of 180° fallback | L2 | 15 min |
| 2.5 | Sample grid inside polygon for true crown point | M4 | 1 hr |

**Deliverable:** Robust path calculation that handles edge cases without silent failures or wild overestimates.

### Phase 3 — User Understanding

| # | Task | Deficiency | Effort |
|---|------|-----------|--------|
| 3.1 | Display runout uncertainty band (mean, 1σ, 2σ) | M3 | 2 hr |
| 3.2 | Show mass alongside volume in results | H2 | 30 min |
| 3.3 | Increase max profile distance to 5km | M5 | 15 min |
| 3.4 | Add path confinement detection for zone width | M2 | 2 hr |

**Deliverable:** Users see uncertainty in results and understand the range of possible outcomes.

### Phase 4 — Polish & Advanced

| # | Task | Deficiency | Effort |
|---|------|-----------|--------|
| 4.1 | Allow user slope override when DEM is suspect | L1 | 30 min |
| 4.2 | Document beta-point convention in UI tooltip | L3 | 15 min |
| 4.3 | Add Voellmy dynamic friction model (uses μ, ξ from snow profile) | Future | 8 hr |
| 4.4 | Auto-detect region from coordinates for coefficient selection | C2 | 2 hr |

**Deliverable:** Professional-grade estimator with dynamic modeling capability.

---

## Summary of Changes by File

| File | Phase | Changes |
|------|-------|---------|
| `src/types/index.ts` | 1 | Add `SnowProfile`, `RegionCoefficients` types |
| `src/lib/avalanche/alpha-beta.ts` | 1, 2 | Add σ, regional coefficients, fix gentle-terrain edge case |
| `src/lib/avalanche/volume.ts` | 1 | Accept `SnowProfile`, use variable entrainment |
| `src/lib/avalanche/destructive-size.ts` | 1 | Switch to mass-based thresholds |
| `src/lib/avalanche/compute.ts` | 1, 2 | Fix cos() bug, pass snow profile through pipeline |
| `src/lib/avalanche/fall-line.ts` | 2 | Two-stage sweep, return null on failure |
| `src/lib/avalanche/profile.ts` | 2, 3 | Increase uphill tolerance, increase max distance |
| `src/lib/avalanche/zones.ts` | 3 | Path confinement detection |
| `src/store/useAvalancheStore.ts` | 1 | Add `snowProfile` state and actions |
| `src/components/Panel/SnowTypeSelector.tsx` | 1 | **New** — snow type preset picker |
| `src/components/Panel/ControlPanel.tsx` | 1 | Integrate SnowTypeSelector |
| `src/components/Panel/ResultsDisplay.tsx` | 1, 3 | Show mass, show uncertainty band legend |
| `src/components/Map/PathOverlay.tsx` | 3 | Render uncertainty bands on map |
