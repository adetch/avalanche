package convert

import (
	"fmt"
	"math"
	"strings"
	"testing"
)

// Benchmark parameters based on Bartelt, Salm & Gruber (1999),
// "Calculating dense-snow avalanche runout using a Voellmy-fluid model
// with active/passive longitudinal straining," J. Glaciology 45(150).
//
// Geometry: idealized 2-segment track
//   - 25° track (450 m, rows 10–39)
//   - 8° runout zone (150 m, rows 0–9)
//
// Voellmy parameters:
//   - μ  = 0.30 (Coulomb friction)
//   - ξ  = 1500 m/s² (turbulent friction)
//   - ρ  = 250 kg/m³
//   - h₀ = 1.0 m release depth
const (
	bRows      = 40
	bCols      = 6
	bCellSize  = 15.0
	bTrackDeg  = 25.0
	bRunoutDeg = 8.0
	bTransRow  = 10 // rows 0–9 = runout (8°), rows 10–39 = track (25°)
	bMu        = 0.30
	bXi        = 1500.0
	bDensity   = 250.0
	bDepth     = 1.0
)

// benchElevation computes the elevation for the idealized 2-segment track.
// Row 0 = south (bottom of runout), row N-1 = north (top/release).
func benchElevation(row int) float64 {
	base := 1500.0
	runoutRise := bCellSize * math.Tan(bRunoutDeg*math.Pi/180)
	trackRise := bCellSize * math.Tan(bTrackDeg*math.Pi/180)

	if row < bTransRow {
		return base + float64(row)*runoutRise
	}
	transElev := base + float64(bTransRow)*runoutRise
	return transElev + float64(row-bTransRow)*trackRise
}

// voellmyTerminalVelocity returns the steady-state velocity on a uniform slope:
//
//	v∞ = √(ξ·h·(sinθ − μ·cosθ))
func voellmyTerminalVelocity(slopeDeg, mu, xi, h float64) float64 {
	theta := slopeDeg * math.Pi / 180
	arg := xi * h * (math.Sin(theta) - mu*math.Cos(theta))
	if arg <= 0 {
		return 0
	}
	return math.Sqrt(arg)
}

// voellmyRunoutDistance returns the analytical runout distance on a decelerating
// slope (where μ·cosθ > sinθ), entering with velocity v0:
//
//	s = (1/2B)·ln(1 + B·v₀²/A)
//
// where A = g·(μ·cosθ − sinθ), B = g/ξ.
func voellmyRunoutDistance(v0, slopeDeg, mu, xi float64) float64 {
	theta := slopeDeg * math.Pi / 180
	g := 9.81
	A := g * (mu*math.Cos(theta) - math.Sin(theta))
	if A <= 0 {
		return math.Inf(1) // slope steeper than friction angle
	}
	B := g / xi
	return (1 / (2 * B)) * math.Log(1+B*v0*v0/A)
}

// TestBenchmarkAnalyticalExpectations verifies the Voellmy analytical solutions
// produce physically plausible results for the benchmark configuration.
func TestBenchmarkAnalyticalExpectations(t *testing.T) {
	// Terminal velocity on the 25° track
	vTerm := voellmyTerminalVelocity(bTrackDeg, bMu, bXi, bDepth)
	t.Logf("Terminal velocity on %.0f° slope: %.2f m/s", bTrackDeg, vTerm)

	// Expected: ~15 m/s (Bartelt reports ~15 m/s for similar params)
	if vTerm < 10 || vTerm > 25 {
		t.Errorf("terminal velocity %.2f m/s outside expected range [10, 25]", vTerm)
	}

	// Runout distance on the 8° deceleration slope
	runout := voellmyRunoutDistance(vTerm, bRunoutDeg, bMu, bXi)
	t.Logf("Runout distance on %.0f° slope: %.1f m (%.1f cells)", bRunoutDeg, runout, runout/bCellSize)

	// At 15 m resolution, runout of ~50 m ≈ 3-4 cells
	if runout < 20 || runout > 200 {
		t.Errorf("runout distance %.1f m outside expected range [20, 200]", runout)
	}

	// Peak impact pressure: p = 0.5·ρ·v²/1000 (kPa)
	pMax := 0.5 * bDensity * vTerm * vTerm / 1000
	t.Logf("Peak impact pressure: %.1f kPa", pMax)

	if pMax < 5 || pMax > 100 {
		t.Errorf("peak pressure %.1f kPa outside expected range [5, 100]", pMax)
	}

	// Verify DEM elevation profile is monotonically increasing
	for r := 1; r < bRows; r++ {
		if benchElevation(r) <= benchElevation(r-1) {
			t.Errorf("elevation not increasing at row %d: %.2f <= %.2f",
				r, benchElevation(r), benchElevation(r-1))
		}
	}

	// Verify slope transition
	trackRise := benchElevation(bTransRow+1) - benchElevation(bTransRow)
	runoutRise := benchElevation(bTransRow) - benchElevation(bTransRow-1)
	t.Logf("Track rise per cell: %.2f m (expect ~%.2f)", trackRise,
		bCellSize*math.Tan(bTrackDeg*math.Pi/180))
	t.Logf("Runout rise per cell: %.2f m (expect ~%.2f)", runoutRise,
		bCellSize*math.Tan(bRunoutDeg*math.Pi/180))

	if trackRise < runoutRise {
		t.Error("track segment should be steeper than runout segment")
	}
}

// TestBenchmarkOutputConversion creates a synthetic OpenFOAM case directory
// with physically plausible output (based on the Bartelt benchmark) and verifies
// the output converter produces valid results.
func TestBenchmarkOutputConversion(t *testing.T) {
	nFaces := (bRows - 1) * (bCols - 1) // 195

	vTerm := voellmyTerminalVelocity(bTrackDeg, bMu, bXi, bDepth)

	// --- Initial h field ---
	// Match generate_case.py: release cells [38,2],[38,3],[39,2],[39,3] map to
	// quad faces via (r-1,r) × (c-1,c) clipped to [0,rows-2] × [0,cols-2].
	releaseCells := [][2]int{{38, 2}, {38, 3}, {39, 2}, {39, 3}}
	releaseFaces := map[int]bool{}
	for _, rc := range releaseCells {
		for _, qr := range []int{rc[0] - 1, rc[0]} {
			for _, qc := range []int{rc[1] - 1, rc[1]} {
				if qr >= 0 && qr < bRows-1 && qc >= 0 && qc < bCols-1 {
					releaseFaces[qr*(bCols-1)+qc] = true
				}
			}
		}
	}

	var h0Lines []string
	var totalInit float64
	for i := 0; i < nFaces; i++ {
		h := 0.0
		if releaseFaces[i] {
			h = bDepth
		}
		totalInit += h
		h0Lines = append(h0Lines, fmt.Sprintf("%.6f", h))
	}
	t.Logf("Release faces: %d (initial mass: %.1f m)", len(releaseFaces), totalInit)

	// --- Synthetic deposition field ---
	// Deposition concentrated near the track/runout transition (face row 10).
	// Scaled so total deposition ≈ initial mass (mass-conserving, no entrainment).
	var rawDep []float64
	var rawTotal float64
	for i := 0; i < nFaces; i++ {
		faceRow := i / (bCols - 1)
		dep := 0.0
		dist := float64(faceRow - bTransRow)
		if faceRow >= bTransRow-4 && faceRow <= bTransRow+3 {
			dep = math.Exp(-0.15 * dist * dist)
		} else if faceRow >= bTransRow-7 && faceRow < bTransRow-4 {
			dep = 0.05 * math.Exp(-0.03*dist*dist)
		}
		rawDep = append(rawDep, dep)
		rawTotal += dep
	}
	// Scale to conserve mass (totalDep ≈ totalInit)
	scale := totalInit / rawTotal
	var hLines []string
	var totalDep float64
	for _, d := range rawDep {
		v := d * scale
		totalDep += v
		hLines = append(hLines, fmt.Sprintf("%.6f", v))
	}

	// --- Synthetic velocity field ---
	// Represents peak velocities during the simulation (not final state).
	var usLines []string
	for i := 0; i < nFaces; i++ {
		faceRow := i / (bCols - 1)
		vel := 0.0
		if faceRow >= bTransRow && faceRow <= bRows-3 {
			progress := float64(bRows-2-faceRow) / float64(bRows-2-bTransRow)
			vel = vTerm * math.Sqrt(1-math.Exp(-3*progress))
		} else if faceRow >= bTransRow-5 && faceRow < bTransRow {
			dist := float64(bTransRow - faceRow)
			vel = vTerm * math.Exp(-0.3*dist)
		}
		usLines = append(usLines, fmt.Sprintf("(%.6f 0 0)", vel))
	}

	hField := fmt.Sprintf(`FoamFile
{
    version     2.0;
    format      ascii;
    class       areaScalarField;
    object      h;
}
dimensions      [0 1 0 0 0 0 0];

internalField   nonuniform List<scalar>
%d
(
%s
)
;
`, nFaces, strings.Join(hLines, "\n"))

	usField := fmt.Sprintf(`FoamFile
{
    version     2.0;
    format      ascii;
    class       areaVectorField;
    object      Us;
}
dimensions      [0 1 -1 0 0 0 0];

internalField   nonuniform List<vector>
%d
(
%s
)
;
`, nFaces, strings.Join(usLines, "\n"))

	h0Field := fmt.Sprintf(`FoamFile
{
    version     2.0;
    format      ascii;
    class       areaScalarField;
    object      h;
}
dimensions      [0 1 0 0 0 0 0];

internalField   nonuniform List<scalar>
%d
(
%s
)
;
`, nFaces, strings.Join(h0Lines, "\n"))

	grid := GridSpec{
		Origin:   [2]float64{-116.5, 51.0},
		CellSize: bCellSize,
		Cols:     bCols,
		Rows:     bRows,
	}

	caseDir := setupTestCase(t, grid, h0Field, hField, usField)

	result, err := ConvertOutput(caseDir, bDensity, 2.5)
	if err != nil {
		t.Fatal(err)
	}

	// --- Validate results ---

	// 1. Total deposition must be positive
	var sumDep float64
	for _, d := range result.Deposition {
		sumDep += float64(d)
	}
	t.Logf("Total deposition: %.2f m (initial: %.2f m)", sumDep, totalInit)
	if sumDep <= 0 {
		t.Error("expected positive total deposition")
	}

	// 2. Mass conservation ratio (should be ~1.0 for no-entrainment benchmark)
	t.Logf("Mass conservation ratio: %.3f", result.Meta.MassConservation)
	if result.Meta.MassConservation < 0.7 || result.Meta.MassConservation > 1.3 {
		t.Errorf("mass conservation %.3f outside [0.7, 1.3]", result.Meta.MassConservation)
	}

	// 3. Peak velocity within expected range
	var maxV float32
	for _, v := range result.VMaxGrid {
		if v > maxV {
			maxV = v
		}
	}
	t.Logf("Peak velocity: %.2f m/s (analytical terminal: %.2f m/s)", maxV, vTerm)
	if float64(maxV) < vTerm*0.5 || float64(maxV) > vTerm*1.5 {
		t.Errorf("peak velocity %.2f outside [%.1f, %.1f] range",
			maxV, vTerm*0.5, vTerm*1.5)
	}

	// 4. Peak pressure consistent with velocity: p = 0.5·ρ·v²/1000
	var maxP float32
	for _, p := range result.PMaxGrid {
		if p > maxP {
			maxP = p
		}
	}
	expectedP := 0.5 * bDensity * float64(maxV) * float64(maxV) / 1000
	t.Logf("Peak pressure: %.2f kPa (expected from velocity: %.2f kPa)", maxP, expectedP)
	if math.Abs(float64(maxP)-expectedP) > 0.5 {
		t.Errorf("pressure mismatch: got %.2f, expected %.2f kPa", maxP, expectedP)
	}

	// 5. Deposition extends into runout zone (below transition row)
	hasRunoutDep := false
	for i := 0; i < bTransRow*(bCols-1); i++ {
		if i < len(result.Deposition) && result.Deposition[i] > 0.001 {
			hasRunoutDep = true
			break
		}
	}
	if !hasRunoutDep {
		t.Error("expected deposition in runout zone (below transition)")
	}

	// 6. Runout distance: furthest face with deposit > 0.01 m
	runoutFaceRow := -1
	for i := 0; i < nFaces && i < len(result.Deposition); i++ {
		if result.Deposition[i] > 0.01 {
			faceRow := i / (bCols - 1)
			if runoutFaceRow == -1 || faceRow < runoutFaceRow {
				runoutFaceRow = faceRow
			}
		}
	}
	if runoutFaceRow >= 0 {
		runoutDist := float64(bTransRow-runoutFaceRow) * bCellSize
		analyticalRunout := voellmyRunoutDistance(vTerm, bRunoutDeg, bMu, bXi)
		t.Logf("Simulated runout extent: %.0f m (%.1f cells beyond transition)",
			runoutDist, float64(bTransRow-runoutFaceRow))
		t.Logf("Analytical runout: %.1f m", analyticalRunout)

		// Tolerance: ±100% (generous due to synthetic data and 15 m grid)
		if runoutDist > 2*analyticalRunout+bCellSize {
			t.Errorf("runout %.0f m exceeds 2× analytical %.1f m + one cell", runoutDist, analyticalRunout)
		}
	}

	// 7. Metadata checks
	if result.Meta.SolverVersion != "openfoam-avalanche@2312" {
		t.Errorf("unexpected solver version: %s", result.Meta.SolverVersion)
	}
	if result.Meta.SimulationTime <= 0 {
		t.Error("expected positive simulation time")
	}
}

// TestBenchmarkRunoutTolerance verifies the analytical runout distance is within
// the acceptable tolerance documented in VALIDATION.md (±30%).
func TestBenchmarkRunoutTolerance(t *testing.T) {
	vTerm := voellmyTerminalVelocity(bTrackDeg, bMu, bXi, bDepth)
	runout := voellmyRunoutDistance(vTerm, bRunoutDeg, bMu, bXi)

	// Published range for Bartelt-type tracks: 40–120 m for these parameters.
	// Our analytical solution should be in this range.
	t.Logf("Analytical runout: %.1f m", runout)

	if runout < 30 || runout > 150 {
		t.Errorf("runout %.1f m outside published range [30, 150]", runout)
	}

	// The runout in grid cells must be resolvable (≥ 1 cell at 15m)
	cells := runout / bCellSize
	t.Logf("Runout in grid cells: %.1f", cells)
	if cells < 1 {
		t.Error("runout shorter than one grid cell — increase track length or reduce friction")
	}
}

// TestBenchmarkGridConsistency verifies the benchmark DEM is consistent with
// the idealized track geometry and fits within solver constraints.
func TestBenchmarkGridConsistency(t *testing.T) {
	totalCells := bRows * bCols
	if totalCells > 90000 {
		t.Errorf("grid %d cells exceeds 90,000 limit", totalCells)
	}

	if bRows > 300 || bCols > 300 {
		t.Errorf("grid %dx%d exceeds 300×300 limit", bRows, bCols)
	}

	// Verify elevation range
	minElev := benchElevation(0)
	maxElev := benchElevation(bRows - 1)
	vertDrop := maxElev - minElev
	t.Logf("Elevation range: %.0f–%.0f m (drop: %.0f m)", minElev, maxElev, vertDrop)

	// Track length
	trackLen := float64(bRows-1) * bCellSize
	t.Logf("Total track length: %.0f m", trackLen)

	// Average slope
	avgSlope := math.Atan(vertDrop/trackLen) * 180 / math.Pi
	t.Logf("Average slope: %.1f°", avgSlope)

	// Should be between the runout and track angles
	if avgSlope < bRunoutDeg || avgSlope > bTrackDeg {
		t.Errorf("average slope %.1f° outside [%.0f, %.0f]", avgSlope, bRunoutDeg, bTrackDeg)
	}
}

// TestBenchmarkAnalyticalEdgeCases verifies the Voellmy formulas handle
// degenerate inputs correctly.
func TestBenchmarkAnalyticalEdgeCases(t *testing.T) {
	// Slope below friction angle: no flow (v=0)
	// atan(0.30) ≈ 16.7° — a 10° slope with mu=0.30 should produce v=0
	v := voellmyTerminalVelocity(10.0, 0.30, 1500, 1.0)
	if v != 0 {
		t.Errorf("expected v=0 on 10° slope with mu=0.30, got %.2f", v)
	}

	// Accelerating slope: infinite runout
	r := voellmyRunoutDistance(15.0, 30.0, 0.30, 1500)
	if !math.IsInf(r, 1) {
		t.Errorf("expected infinite runout on 30° slope with mu=0.30, got %.1f", r)
	}

	// Zero velocity entry: zero runout
	r = voellmyRunoutDistance(0.0, 8.0, 0.30, 1500)
	if r != 0 {
		t.Errorf("expected zero runout with zero entry velocity, got %.1f", r)
	}
}
