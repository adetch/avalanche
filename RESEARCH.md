# Avalanche Path Estimation — Literature Research

## 1. Gradient Descent / Steepest-Path Approaches

### Problem with fixed-bearing profiles
The original implementation samples 16 compass directions at 50m from the crown and locks a single bearing for the entire 3km path. Real avalanche paths curve as they follow terrain — gullies turn, aspects shift, and ridgelines redirect flow.

### Modern approach: iterative gradient following
Analogous to hydrological flow-direction models. At each step, compute the local terrain gradient and take a step in the steepest descent direction.

**Algorithm:**
1. Start at crown point (highest point of starting zone)
2. Compute local gradient using **Horn (1981)** method on a 3x3 neighborhood:
   - `dz/dx = ((z_ne + 2*z_e + z_se) - (z_nw + 2*z_w + z_sw)) / (8 * cellsize)`
   - `dz/dy = ((z_sw + 2*z_s + z_se) - (z_nw + 2*z_n + z_ne)) / (8 * cellsize)`
   - Simplified for MapLibre (continuous elevation queries): **central differences**
   - `dz/dx = (z_east - z_west) / (2 * d)` where d = sample spacing
   - `dz/dy = (z_north - z_south) / (2 * d)`
3. Descent direction = negation of gradient vector → `atan2(-dz/dy, dz/dx)` → compass bearing
4. Apply **momentum smoothing** (70% gradient, 30% previous bearing) to dampen DEM noise
5. Step fixed distance (10m) in descent direction
6. Repeat until stopping criteria met

**Stopping criteria:**
- Terrain rises for 3+ consecutive steps
- Slope magnitude < ~2° for extended distance
- Maximum distance reached (3000-5000m)
- z-delta energy criterion from Flow-Py

### Key references
- Horn, B.K.P. (1981). "Hill shading and the reflectance map." *Proceedings of the IEEE*, 69(1), 14-47.
- [Flow-Py](https://github.com/avaframe/FlowPy) — open-source gravitational mass flow simulation using gradient-following with persistence (Mergili et al., 2022, GMD)
- [TauDEM D8 Flow Directions](https://hydrology.usu.edu/taudem/taudem5/help53/D8FlowDirections.html)

---

## 2. Alpha-Beta Model (Lied & Bakkehoi 1980)

### Historical development
- **Lied & Bakkehoi (1980):** Original study on 111 Norwegian paths
- **Bakkehoi et al. (1983):** Extended to 206 paths → α = 0.96β − 1.4° (R=0.92, SD=2.3°)
- **McClung & Lied (1987):** Introduced runout ratio model using Gumbel extreme value distribution

### Full regression equation (AvaFrame)
```
α_j = k1 * β + k2 * z'' + k3 * H0 + k4 + j * SD
```
Where:
- **β**: Angle from starting point to beta point (where slope first drops below 10°)
- **z''**: Second derivative of quadratic fit to path profile (curvature)
- **H0**: Vertical drop from quadratic fit
- **k1, k2, k3, k4**: Regional regression coefficients
- **SD**: Standard deviation of the regression
- **j**: -1, 0, +1 for confidence bands

### AvaFrame standard coefficients
- **Standard avalanche:** k1=1.05, k2=-3130.0, k3=0.0, k4=-2.38, SD=1.25
- **Small avalanche:** k1=0.933, k2=0.0, k3=0.0088, k4=-5.02, SD=2.36
- **Simplified (Norwegian):** α = 0.96β − 1.4° (SD=2.3°) — most widely used

### Beta point detection
1. Extract path profile (s, z) where s is horizontal distance
2. Resample to uniform spacing (10m)
3. Compute local slope at each point
4. Find first point where slope drops below 10°
5. **Stability check:** slope must remain below 10° for at least dsMin=30m
6. β angle = atan((z_crown − z_beta) / s_beta)

### Quadratic profile fit (for extended equation)
1. Fit `z = a*s² + b*s + c` using least squares
2. `z'' = 2a` (constant second derivative)
3. `H0 = max(poly(s)) - min(poly(s))`

### Regional alpha angles (100-year events)
| Region | Mean α | N | Climate |
|--------|--------|---|---------|
| Western Norway | ~28.2° | 113 | Maritime |
| Coastal Alaska | ~25.4° | 52 | Maritime |
| Canadian Rockies/Purcells | ~27.8° | 127 | Continental |
| Colorado | ~22.1° | 130 | Continental |
| Sierra Nevada | ~20.1° | 90 | Maritime |

Key finding: alpha angles do **not** depend systematically on climate regime — terrain geometry dominates.

### Key references
- Lied, K. & Bakkehøi, S. (1980). "Empirical calculations of snow-avalanche run-out distance based on topographic parameters." *Journal of Glaciology*, 26(94), 165-177.
- Bakkehøi, S., Domaas, U. & Lied, K. (1983). "Calculation of snow avalanche runout distance." *Annals of Glaciology*, 4, 24-29.
- McClung, D.M. & Lied, K. (1987). "Statistical and geometrical definition of snow avalanche runout." *Cold Regions Science and Technology*, 13(2), 107-119.
- [AvaFrame com2AB documentation](https://docs.avaframe.org/en/1.9/moduleCom2AB.html)

---

## 3. Multi-Aspect Detection

### The problem
A user-drawn starting zone polygon may span a ridge, wrap around a bowl, or cover terrain with varying aspects. The current code picks one fall-line direction from the highest point.

### Standard approaches

**A. Dominant Aspect from Area-Weighted Average:**
- Compute local aspect at grid points within polygon
- Circular mean (vector averaging to handle 0°/360° wrap)
- Works for roughly planar starting zones

**B. Multiple Flow Paths (Flow-Py, AutoATES):**
- Treat every cell in starting zone as a potential release cell
- Route flow downhill from every cell independently
- Merge into envelope representing full affected area
- Most physically realistic

**C. Aspect Clustering:**
- Compute aspect at grid of points
- If standard deviation > 45°, flag as multi-aspect
- Split into clusters, run separate paths
- Alert user

### Recommendation for this tool
- Compute gradient at crown point AND several other polygon points
- If aspects consistent (within ~30°), use gradient at crown
- If divergent, warn user or run 2-3 representative paths
- Report aspect range as diagnostic

---

## 4. Diagnostic Information for Avalanche Path Analysis

### Terrain parameters at key points
- **Aspect** (compass bearing) at crown, beta, runout — shows wind-loading exposure
- **Slope angle** at crown (25-55° for slabs), beta (~10°), runout
- **Starting zone inclination** (θ): average upper slope
- **Elevation** at crown, beta, runout

### Path geometry
- **Vertical drop** (H): crown minus runout elevation
- **Horizontal runout distance**
- **Track length**: actual path distance (> horizontal due to slope)
- **Beta and alpha angles**
- **Profile curvature (y'')**: quadratic fit second derivative. Positive = concave (bowl), negative = convex

### Confinement and width
- **Confinement ratio** (Rmax/Tmin): starting zone width / min track width
- **Track width** at narrowest point
- **Runout fan width**: typically 1.5x track width for confined paths

### Curvature types
- **Profile curvature**: rate of change of slope along path. Positive = convex (decelerating), negative = concave (accelerating)
- **Plan curvature**: cross-slope. Positive = convergent (gully), negative = divergent (ridge)

### Quality/confidence indicators
- Profile point count
- DEM resolution
- Beta point stability (clean threshold crossing vs. oscillation)
- Aspect consistency along path
- Regression confidence bands (j * SD)

### Key references
- [Avalanche.org Terrain Encyclopedia](https://avalanche.org/avalanche-encyclopedia/terrain/)
- Sovilla, B. et al. (2006). "Snow entrainment in natural avalanches." *Cold Regions Science and Technology*
- McClung, D.M. & Schaerer, P. (2006). *The Avalanche Handbook*, 3rd ed. The Mountaineers Books.

---

## 5. Implementation: Gradient-Following Profile

### Changes from fixed-bearing approach
- Profile naturally follows gullies, curves around ridges, tracks aspect changes
- `lngLat` coordinates trace actual path on terrain, not a straight line
- Zone polygons accurately follow terrain
- `distanceFromCrown` = actual path length, not straight-line distance
- `fallLineAzimuth` becomes initial bearing at crown (path direction evolves)

### DEM noise mitigation
1. Larger sampling radius for gradient (30-50m)
2. Momentum/persistence: weight new direction with previous (e.g., 70% gradient + 30% previous), similar to Flow-Py's persistence term

### Profile resampling
AvaFrame resamples to uniform 10m horizontal spacing. Gradient-following inherently produces uniform points with constant step size.

---

## 6. Avalanche Release Mechanics and Starting Zone Identification

### 6.1 Terrain controls on release (hierarchy of importance)

**Slope angle** dominates. Schweizer & Jamieson (2001) analyzed 809 human-triggered avalanches:
median 39°, IQR 37-41°, mean 38.8° ± 3.8°. The classic 25-60° is the outer envelope;
the operational zone is **30-45°** with peak frequency at **36-40°**.

Automated PRA thresholds:
- Frequent (10-30yr): 30-60° (Bühler et al., 2018)
- Extreme (100-300yr): 28-60° (Bühler et al., 2018)
- Veitinger et al. (2016) fuzzy: peak membership at 35-45°

**Profile curvature** (downslope): Convex surfaces create tensile stress concentrations
favoring fracture. Concave surfaces promote accumulation and compressive support.

**Plan curvature** (cross-slope): Concave (bowls, gullies) = concentrated snow deposition,
frequent small releases. Planar/convex = less frequent but larger releases (Maggioni & Gruber, 2003).

**Distance to ridge**: Only terrain within **600m of a ridge** should be considered as
potential release area (Duvillier et al., 2023).

**Surface roughness**: Acts as anchor. Snow depth dependent — terrain too rough at 50cm
may release at 200cm. Veitinger et al. (2016) multi-scale roughness parameter captures this.
Bühler et al. (2018): curvature > 6 rad/100hm prevents fracture propagation.

**Wind loading**: Direct loading (over ridges, deposits on lee) and cross-loading (along ridges,
deposits in lateral features). Winstral et al. (2002) shelter index quantifies this.

### 6.2 Crown fracture position

Crown fractures form at or near **convex rollovers** — where slope transitions from gentle to steep:

- Meloche et al. (2025): "the crown starts at the beginning of the convex roll where the slope
  angle is starting to reduce." Crack arrest and slab tensile failure caused by slope angle reduction.
- McClung (1981): Convex slopes create tensile stress from differential creep rates.
- Schweizer et al. (2003): "slope angle variations such as convex downslope curvature provoke
  stress concentrations that favor avalanche formation."

The crown is **NOT necessarily at the highest point**:
- Shallow, soft slabs fracture **at** the convexity
- Stiff, thick slabs can propagate their crown **above** the convexity into gentler terrain
- Very large events (D3+) can have crowns extending to the ridge crest

### 6.3 Slab dimensions (McClung 2009)

Field measurements of dry snow slab avalanches:
- Width/Depth ratio: mean 106-113 (slabs ~100x wider than deep)
- Width/Length ratio: mean ~2.1 (slabs ~2x wider than long)
- Length/Depth ratio: mean ~100
- All dimensions follow log-normal distributions

### 6.4 What the alpha-beta model assumes about the start point

The alpha angle is defined as "the angle from the **highest point of the crown face** to the toe
of debris" (McClung & Schaerer 2006; Avalanche Center Glossary). The model was calibrated against
observed events where crown positions were known. Using the highest point is therefore:
- **Correct** for the alpha-beta model's calibration basis
- **Conservative** (predicts longer runout than centroid-based start)

### 6.5 How professional tools define the release

| Tool | Release strategy |
|------|-----------------|
| **Alpha-beta** | Highest point of observed crown face |
| **AvaFrame com1DFA** | Entire polygon simultaneously (SPH block release) |
| **RAMMS** | Entire polygon, depth-averaged shallow water equations |
| **Flow-Py** | Every cell independently → composite envelope |
| **Bühler et al. (2018)** | Automated PRA: slope + roughness + curvature + aspect segmentation |

### 6.6 PRA delineation methods

**Veitinger et al. (2016)** — Fuzzy logic:
- Three inputs: slope angle, multi-scale roughness, wind shelter index
- Fuzzy membership functions combined with AND (minimum operator)
- Multi-scale roughness captures snow-depth-dependent terrain smoothing
- PSS validation score: 76.2%

**Bühler et al. (2018)** — OBIA (Object-Based Image Analysis):
- Multi-resolution segmentation weighting **aspect changes 3x** more than slope
- Region-growing to merge objects with similar aspect
- Mean PRA area: 9,750 m² (frequent), 22,850 m² (extreme)
- Minimum PRA: 500 m². Optimal DEM resolution: 5m
- PSS validation score: 79.5%

**Duvillier et al. (2023)** — Watershed delineation:
- Slope 28-60°, distance to ridge <600m
- Watershed algorithm segments terrain into individual PRA polygons
- Ridges identified using geomorphon algorithm
- Minimum PRA: 6,250 m². Works at 25m DEM resolution
- True positive rates: 80-87% (numbers), 92-94% (areas)

### 6.7 Implications for crown point selection

The current tool uses the highest polygon vertex. Recommended improvements:

1. **Primary**: Find the highest point along the **convex rollover** within the polygon
   (point of maximum profile convexity — where slope steepens most rapidly)
2. **Secondary**: Compute from the polygon's highest terrain point (conservative, alpha-beta consistent)
3. **Validation**: Warn if mean slope outside 28-60°, area outside 500-50,000 m², or multi-aspect

### Key references
- Schweizer, J., Jamieson, B. & Schneebeli, M. (2003). "Snow avalanche formation." *Reviews of Geophysics*, 41(4).
- Schweizer, J. & Jamieson, B. (2001). "Snow cover properties for skier triggering." *Cold Regions Science and Technology*, 33(2-3).
- Meloche, A. et al. (2025). "Modeling crack arrest in snow slab avalanches." *JGR Earth Surface*.
- McClung, D.M. (2009). "Dimensions of dry snow slab avalanches." *JGR*, 114.
- Veitinger, J., Purves, R.S. & Sovilla, B. (2016). "Potential slab avalanche release area identification from estimated winter terrain." *NHESS*, 16, 2211-2225.
- Bühler, Y. et al. (2018). "Automated snow avalanche release area delineation." *NHESS*, 18, 3235-3251.
- Duvillier, C. et al. (2023). "PRA identification based on watershed delineation." *NHESS*, 23, 1383-1400.
- Maggioni, M. & Gruber, U. (2003). "Influence of topographic parameters on release dimension and frequency." *Cold Regions Science and Technology*.
- Winstral, A., Elder, K. & Davis, R. (2002). "Spatial snow modeling of wind-redistributed snow." *Hydrological Processes*.

---

## 7. Multi-Cell Release and Flow Models

### 7.1 Flow-Py (AvaFrame com4FlowPy)

D'Amboise et al. (2022). Empirical mass-flow routing — no physics equations, no time stepping.

**Core algorithm — Holmgren (1994) MFD routing:**
```
T_i = tan(phi_i)^exp / SUM_n[tan(phi_n)^exp]    for all downslope neighbors
```
- `exp = 1`: maximum spreading (hydrology)
- `exp = 8`: recommended for avalanches on ~10m DEM
- `exp → ∞`: converges to D8 (single neighbor)

Differs from D-infinity (Tarboton 1997), which routes to exactly 1-2 cells.
Flow-Py MFD can route to all 8 simultaneously.

**Z-delta energy criterion (stopping):**
```
Z_delta_n = Z_delta_b + (Z_b - Z_n) - S_bn * tan(alpha)
```
Where `alpha` is a user-set runout angle (typically 25-30°). Flow stops when `Z_delta ≤ 0`.
Geometrically equivalent to the classical alpha-angle: flow stops when the line from
release at angle `alpha` meets the terrain.

**Persistence (momentum):**
```
P_i = SUM_p(Z_delta_p * max(0, cos(angle_pbn - pi)))
```
- Forward direction gets `P = 1.0`
- 45° deviation gets `P = cos(45°) = 0.707`
- 90°+ gets `P = 0` (no backward flow)
- Effectively limits to **3 forward cells** per parent

**Combined routing:**
```
R_i = [T_i * P_i / SUM_n(T_n * P_n)] * R_b
```

**Release cell handling:** Each cell independent. No interaction during computation.
Composited at output via: Z_max_delta, R_max, cell count (CC), Z_sum_delta.

**Key parameters:**
| Parameter | Typical Value | Role |
|-----------|---------------|------|
| `alpha` | 25° (large) / 30° (small) | Runout distance |
| `exp` | 8 | Lateral spreading |
| `R_stop` | 3 × 10⁻⁴ | Flux cutoff |

### 7.2 RAMMS — Depth-Averaged Shallow Water + Voellmy Friction

Christen, Kowalski & Bartelt (2010). Full 2D physics simulation.

**Voellmy friction:**
```
S_f = μ · ρ · g · H · cos(φ) + ρ · g · U² / ξ
```
- **μ** (Coulomb): velocity-independent, dominates at stopping. Range: 0.155 (extreme) to 0.40 (small)
- **ξ** (turbulent, m/s²): velocity-squared, dominates at speed. Range: 800-3000

**Swiss guideline parameter ranges:**
| Event | μ | ξ (m/s²) |
|-------|------|----------|
| Small/frequent | 0.30-0.40 | 1000-1500 |
| Medium | 0.20-0.30 | 1500-2500 |
| Large/extreme | 0.155 | 2500-3000 |

Block release (entire polygon at t=0). Finite volume method, 5-25m grid, CFL-governed time stepping.
**Not browser-feasible** — requires complete DEM raster + thousands of time steps.

### 7.3 AvaFrame com1DFA — SPH Particle Method

AvaFrame (2023). Mixed particle-grid method.

Particles carry mass, position, velocity. Grid computes flow thickness and pressure.
Bilinear interpolation between particles and grid. Uses spiky SPH kernel.
**Not browser-feasible** — expensive neighbor searches + time stepping.

### 7.4 MinVoellmy — Lightweight Voellmy Model

Hergarten (2024). Deliberately minimal implementation:
- ~100 lines of core code (MATLAB/Python, portable to TypeScript)
- First-order upwind scheme (simple, stable, diffusive)
- Self-stabilizing fronts (Voellmy rheology prevents numerical instabilities)
- Explicit Euler time-stepping with CFL-based adaptive dt
- No external dependencies

**Potentially browser-feasible** on a virtual grid: 200×100 cells × ~100 time steps
could run in 1-3 seconds in JavaScript.

### 7.5 r.randomwalk — Stochastic Flow Routing

Mergili, Krenn & Chu (2015). Constrained random walks:
- Direction sampled from probability distribution (slope + persistence weighted)
- 1000+ walkers per release cell
- Impact probability = fraction of walkers reaching each cell
- Naturally produces probabilistic output
- Computationally more expensive than Flow-Py (many walkers per cell)

---

## 8. Multi-Path Approaches for the Alpha-Beta Model

### 8.1 Multi-path alpha-beta envelope

Simplest multi-cell extension of the current tool:
1. Sample 5-15 release points across polygon (weighted by slope angle)
2. For each, follow steepest descent to extract profile
3. Compute alpha-beta independently for each path
4. Composite: union of buffered centerlines, color by path density
5. Report runout range (min/median/max across paths)

~10,000-30,000 elevation queries. Well within browser budget (<5 seconds).

### 8.2 Path weighting strategies

- **By slope angle**: Cells >38° (peak slab frequency) get higher weight
- **By elevation**: Higher cells have more potential energy → longer runout
- **By area**: Wider release sections produce more mass; uniform sampling handles this naturally
- **By aspect**: Leeward aspects more loaded (if wind data available)

### 8.3 Combining paths into probability map

Each path produces a Gaussian distribution of runout distances centered on `alpha_0` with
spread `SD`. Overlay distributions to create a continuous probability surface:
- 50th percentile: mean alpha runout
- 84th percentile: alpha - 1σ
- 98th percentile: alpha - 2σ

---

## 9. Virtual-Grid Strategy for Browser Implementation

Key insight: MapLibre provides point queries, not a raster. But we can create one on-demand:

1. **Define bounding box** around release polygon, extending ~3km downslope
2. **Sample regular grid** at 15-20m resolution (~15,000-25,000 queries, ~1-2s)
3. **Run grid-based algorithm** (Flow-Py or MinVoellmy) on in-memory grid
4. **Map results** back to geographic coordinates for display

**Elevation query budgets:**

| Approach | Queries | Browser Time | Physics |
|----------|---------|-------------|---------|
| Single alpha-beta (current) | ~1,500 | <1s | Statistical |
| Multi-path alpha-beta | ~15,000 | 2-3s | Statistical |
| Virtual-grid Flow-Py | ~20,000 | 3-5s | Empirical-energy |
| Virtual-grid MinVoellmy | ~20,000 | 3-8s | Physics-based |
| Full RAMMS/com1DFA | N/A | Hours | Full physics |

---

## 10. Recommended Enhancement Path

### Phase 1 (Current): Multi-path alpha-beta envelope
- Extend current gradient-following to multiple release points
- Show path ensemble with probability bands
- Low implementation complexity, significant accuracy improvement

### Phase 2: Virtual-grid Flow-Py
- Sample DEM grid on-demand from MapLibre
- Implement Holmgren MFD routing + z-delta stopping + persistence
- Adds lateral spread, terrain channeling, intensity mapping
- Comparable to AutoATES regional hazard indication quality

### Phase 3: Virtual-grid MinVoellmy
- Lightweight Voellmy dynamic model on same virtual grid
- Time-evolving flow depth and velocity fields
- Maximum flow depth, velocity, and pressure at each cell
- ~100 lines of core numerics, portable from Hergarten (2024)

### Phase 4 (Aspirational): WebGPU-accelerated simulation
- Move finite-volume solver to GPU compute shaders
- 500×500+ grids at interactive rates
- Real-time parameter exploration

### Key references
- D'Amboise, C.J.L. et al. (2022). "Flow-Py v1.0." *GMD*, 15, 2423-2439.
- Holmgren, P. (1994). "Multiple-flow direction algorithms." *Hydrological Processes*, 8, 327-334.
- Christen, M., Kowalski, J. & Bartelt, P. (2010). "RAMMS: numerical simulation of dense snow avalanches." *Cold Regions Science and Technology*, 63(1-2), 1-14.
- Hergarten, S. (2024). "MinVoellmy v1." *GMD*, 17, 781-795.
- Mergili, M., Krenn, J. & Chu, H.-J. (2015). "r.randomwalk v1." *GMD*, 8, 4027-4043.
- Toft, H.B. et al. (2024). "AutoATES v2.0." *NHESS*, 24, 1779-1799.
- Horton, P. et al. (2013). "Flow-R." *NHESS*, 13, 869-885.
