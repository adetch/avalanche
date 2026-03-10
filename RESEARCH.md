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
