package convert

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
)

// setupTestCase creates a minimal OpenFOAM case directory with the given fields.
func setupTestCase(t *testing.T, grid GridSpec, h0Content, hContent, usContent string) string {
	t.Helper()
	dir := t.TempDir()

	// Write input.json
	input := InputJSON{}
	input.DEM.Origin = grid.Origin
	input.DEM.CellSize = grid.CellSize
	input.DEM.Cols = grid.Cols
	input.DEM.Rows = grid.Rows
	data, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(dir, "input.json"), data, 0644)

	// Create "0" directory with initial h
	if h0Content != "" {
		os.MkdirAll(filepath.Join(dir, "0"), 0755)
		os.WriteFile(filepath.Join(dir, "0", "h"), []byte(h0Content), 0644)
	}

	// Create time directory "45.2" with solver output
	timeDir := filepath.Join(dir, "45.2")
	os.MkdirAll(timeDir, 0755)

	if hContent != "" {
		os.WriteFile(filepath.Join(timeDir, "h"), []byte(hContent), 0644)
	}
	if usContent != "" {
		os.WriteFile(filepath.Join(timeDir, "Us"), []byte(usContent), 0644)
	}

	return dir
}

// Sample OpenFOAM scalar field (6 cells, matching sample_output.json first row)
const sampleScalarH = `FoamFile
{
    version     2.0;
    format      ascii;
    class       areaScalarField;
    object      h;
}
dimensions      [0 1 0 0 0 0 0];

internalField   nonuniform List<scalar>
6
(
0.42
0.65
1.10
0.95
0.50
0.22
)
;
`

const sampleScalarH0 = `FoamFile
{
    version     2.0;
    format      ascii;
    class       areaScalarField;
    object      h;
}
dimensions      [0 1 0 0 0 0 0];

internalField   nonuniform List<scalar>
6
(
1.5
1.5
1.5
1.5
0.0
0.0
)
;
`

const sampleVectorUs = `FoamFile
{
    version     2.0;
    format      ascii;
    class       areaVectorField;
    object      Us;
}
dimensions      [0 1 -1 0 0 0 0];

internalField   nonuniform List<vector>
6
(
(2.1 0.0 0.0)
(3.0 2.4 0.0)
(6.0 2.5 0.0)
(5.0 3.3 0.0)
(3.0 1.0 0.0)
(1.5 0.0 0.0)
)
;
`

func TestParseOpenFOAMScalar(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "h")
	os.WriteFile(path, []byte(sampleScalarH), 0644)

	values, err := ParseOpenFOAMScalar(path)
	if err != nil {
		t.Fatal(err)
	}

	expected := []float64{0.42, 0.65, 1.10, 0.95, 0.50, 0.22}
	if len(values) != len(expected) {
		t.Fatalf("expected %d values, got %d", len(expected), len(values))
	}
	for i, v := range values {
		if math.Abs(v-expected[i]) > 1e-6 {
			t.Errorf("value[%d]: expected %f, got %f", i, expected[i], v)
		}
	}
}

func TestParseOpenFOAMScalarUniform(t *testing.T) {
	dir := t.TempDir()
	content := `FoamFile
{
    version     2.0;
    format      ascii;
    class       areaScalarField;
    object      h;
}
dimensions      [0 1 0 0 0 0 0];

internalField   uniform 0;
`
	path := filepath.Join(dir, "h")
	os.WriteFile(path, []byte(content), 0644)

	values, err := ParseOpenFOAMScalar(path)
	if err != nil {
		t.Fatal(err)
	}

	if len(values) != 1 || values[0] != 0.0 {
		t.Errorf("expected uniform [0], got %v", values)
	}
}

func TestParseOpenFOAMVector(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "Us")
	os.WriteFile(path, []byte(sampleVectorUs), 0644)

	magnitudes, err := ParseOpenFOAMVector(path)
	if err != nil {
		t.Fatal(err)
	}

	if len(magnitudes) != 6 {
		t.Fatalf("expected 6 magnitudes, got %d", len(magnitudes))
	}

	// First vector: (2.1, 0, 0) -> mag = 2.1
	if math.Abs(magnitudes[0]-2.1) > 1e-6 {
		t.Errorf("magnitude[0]: expected 2.1, got %f", magnitudes[0])
	}

	// Second vector: (3.0, 2.4, 0) -> mag = sqrt(9 + 5.76) = sqrt(14.76) ≈ 3.842
	expected1 := math.Sqrt(3.0*3.0 + 2.4*2.4)
	if math.Abs(magnitudes[1]-expected1) > 1e-3 {
		t.Errorf("magnitude[1]: expected %f, got %f", expected1, magnitudes[1])
	}
}

func TestParseOpenFOAMVectorUniform(t *testing.T) {
	dir := t.TempDir()
	content := `FoamFile
{
    version     2.0;
    format      ascii;
    class       areaVectorField;
    object      Us;
}
dimensions      [0 1 -1 0 0 0 0];

internalField   uniform (0 0 0);
`
	path := filepath.Join(dir, "Us")
	os.WriteFile(path, []byte(content), 0644)

	magnitudes, err := ParseOpenFOAMVector(path)
	if err != nil {
		t.Fatal(err)
	}

	if len(magnitudes) != 1 || magnitudes[0] != 0.0 {
		t.Errorf("expected uniform [0], got %v", magnitudes)
	}
}

func TestFindLatestTimeDir(t *testing.T) {
	dir := t.TempDir()
	// Create time directories
	for _, name := range []string{"0", "10.5", "25", "45.2", "constant", "system"} {
		os.MkdirAll(filepath.Join(dir, name), 0755)
	}

	path, simTime, err := FindLatestTimeDir(dir)
	if err != nil {
		t.Fatal(err)
	}

	if filepath.Base(path) != "45.2" {
		t.Errorf("expected latest time dir '45.2', got %q", filepath.Base(path))
	}
	if math.Abs(simTime-45.2) > 1e-6 {
		t.Errorf("expected simTime 45.2, got %f", simTime)
	}
}

func TestFindLatestTimeDirNoTimeDirs(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "0"), 0755)
	os.MkdirAll(filepath.Join(dir, "constant"), 0755)
	os.MkdirAll(filepath.Join(dir, "system"), 0755)

	_, _, err := FindLatestTimeDir(dir)
	if err == nil {
		t.Error("expected error for no time directories")
	}
}

func TestConvertOutput(t *testing.T) {
	grid := GridSpec{
		Origin:   [2]float64{-116.8425, 51.042},
		CellSize: 15,
		Cols:     6,
		Rows:     1,
	}

	caseDir := setupTestCase(t, grid, sampleScalarH0, sampleScalarH, sampleVectorUs)

	result, err := ConvertOutput(caseDir, 250.0, 0.85)
	if err != nil {
		t.Fatal(err)
	}

	// Check grid spec is preserved
	if result.Grid.Origin != grid.Origin {
		t.Errorf("origin mismatch: %v", result.Grid.Origin)
	}
	if result.Grid.CellSize != 15 {
		t.Errorf("cellSize: expected 15, got %f", result.Grid.CellSize)
	}

	// Check deposition values
	if len(result.Deposition) != 6 {
		t.Fatalf("expected 6 deposition values, got %d", len(result.Deposition))
	}
	if math.Abs(float64(result.Deposition[0])-0.42) > 1e-5 {
		t.Errorf("deposition[0]: expected 0.42, got %f", result.Deposition[0])
	}
	if math.Abs(float64(result.Deposition[2])-1.10) > 1e-5 {
		t.Errorf("deposition[2]: expected 1.10, got %f", result.Deposition[2])
	}

	// Check velocity magnitudes
	if len(result.VMaxGrid) != 6 {
		t.Fatalf("expected 6 vMax values, got %d", len(result.VMaxGrid))
	}
	if math.Abs(float64(result.VMaxGrid[0])-2.1) > 1e-3 {
		t.Errorf("vMax[0]: expected 2.1, got %f", result.VMaxGrid[0])
	}

	// Check pressure: p = 0.5 * 250 * v^2 / 1000
	expectedP0 := float32(0.5 * 250.0 * 2.1 * 2.1 / 1000.0)
	if math.Abs(float64(result.PMaxGrid[0]-expectedP0)) > 1e-3 {
		t.Errorf("pMax[0]: expected %f, got %f", expectedP0, result.PMaxGrid[0])
	}

	// Check metadata
	if result.Meta.SolverVersion != "openfoam-avalanche@2312" {
		t.Errorf("solver version: %s", result.Meta.SolverVersion)
	}
	if math.Abs(result.Meta.SimulationTime-45.2) > 1e-6 {
		t.Errorf("simulation time: expected 45.2, got %f", result.Meta.SimulationTime)
	}
	if result.Meta.Steps != 2 { // "0" and "45.2"
		t.Errorf("steps: expected 2, got %d", result.Meta.Steps)
	}

	// Check mass conservation
	if result.Meta.MassInitial <= 0 {
		t.Error("expected positive initial mass")
	}
	if result.Meta.MassConservation <= 0 {
		t.Error("expected positive mass conservation ratio")
	}
}

func TestConvertOutputMissingH(t *testing.T) {
	grid := GridSpec{
		Origin:   [2]float64{-116.0, 51.0},
		CellSize: 15,
		Cols:     6,
		Rows:     1,
	}

	// No h file, only Us — converter should still fail plausibility (no deposition)
	caseDir := setupTestCase(t, grid, "", "", sampleVectorUs)

	_, err := ConvertOutput(caseDir, 250.0, 1.0)
	if err == nil {
		t.Error("expected plausibility error for missing h (zero deposition)")
	}
}

func TestConvertOutputMissingUs(t *testing.T) {
	grid := GridSpec{
		Origin:   [2]float64{-116.0, 51.0},
		CellSize: 15,
		Cols:     6,
		Rows:     1,
	}

	// h present, no Us
	caseDir := setupTestCase(t, grid, "", sampleScalarH, "")

	result, err := ConvertOutput(caseDir, 250.0, 1.0)
	if err != nil {
		t.Fatal(err)
	}

	// Deposition should have values
	if result.Deposition[0] == 0 {
		t.Error("expected non-zero deposition from h field")
	}

	// VMax and PMax should be all zeros
	for i, v := range result.VMaxGrid {
		if v != 0 {
			t.Errorf("vMax[%d]: expected 0, got %f", i, v)
		}
	}
	for i, p := range result.PMaxGrid {
		if p != 0 {
			t.Errorf("pMax[%d]: expected 0, got %f", i, p)
		}
	}
}

func TestWriteResultJSON(t *testing.T) {
	result := &ConvertResult{
		Grid: GridSpec{
			Origin:   [2]float64{-116.8425, 51.042},
			CellSize: 15,
			Cols:     3,
			Rows:     2,
		},
		Deposition: []float32{0.42, 0.65, 1.10, 0.18, 0.35, 0.72},
		VMaxGrid:   []float32{2.1, 3.8, 6.5, 5.4, 8.2, 14.1},
		PMaxGrid:   []float32{0.55, 1.81, 5.28, 3.65, 8.41, 24.88},
		Meta: ResultMeta{
			SolverVersion:    "openfoam-avalanche@2312",
			Runtime:          0.85,
			Steps:            312,
			SimulationTime:   45.2,
			MassConservation: 0.94,
			MassInitial:      4.8,
			MassDeposited:    7.9,
		},
	}

	dir := t.TempDir()
	outPath := filepath.Join(dir, "result.json")

	err := WriteResultJSON(result, outPath)
	if err != nil {
		t.Fatal(err)
	}

	// Read back and validate
	data, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatal(err)
	}

	var out ResultJSON
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}

	if out.SchemaVersion != 1 {
		t.Errorf("schemaVersion: expected 1, got %d", out.SchemaVersion)
	}
	if out.Cols != 3 || out.Rows != 2 {
		t.Errorf("grid dimensions: expected 3x2, got %dx%d", out.Cols, out.Rows)
	}
	if len(out.Deposition) != 6 {
		t.Errorf("deposition length: expected 6, got %d", len(out.Deposition))
	}
	if len(out.VMaxGrid) != 6 {
		t.Errorf("vMaxGrid length: expected 6, got %d", len(out.VMaxGrid))
	}
	if len(out.PMaxGrid) != 6 {
		t.Errorf("pMaxGrid length: expected 6, got %d", len(out.PMaxGrid))
	}
	if out.Metadata.SolverVersion != "openfoam-avalanche@2312" {
		t.Errorf("solver version: %s", out.Metadata.SolverVersion)
	}
	if out.Metadata.MassConservation != 0.94 {
		t.Errorf("mass conservation: expected 0.94, got %f", out.Metadata.MassConservation)
	}
}

func TestWriteResultJSONRoundTrip(t *testing.T) {
	// Verify that written JSON conforms to the output schema in SCHEMA.md:
	// schemaVersion, origin, cellSize, cols, rows, deposition, vMaxGrid, pMaxGrid, metadata
	result := &ConvertResult{
		Grid: GridSpec{
			Origin:   [2]float64{-116.8425, 51.042},
			CellSize: 15,
			Cols:     6,
			Rows:     8,
		},
		Deposition: make([]float32, 48),
		VMaxGrid:   make([]float32, 48),
		PMaxGrid:   make([]float32, 48),
		Meta: ResultMeta{
			SolverVersion:    "openfoam-avalanche@2312",
			Runtime:          2.5,
			Steps:            500,
			SimulationTime:   120.0,
			MassConservation: 0.92,
		},
	}

	dir := t.TempDir()
	outPath := filepath.Join(dir, "result.json")
	err := WriteResultJSON(result, outPath)
	if err != nil {
		t.Fatal(err)
	}

	// Parse as raw JSON and check all required fields
	data, _ := os.ReadFile(outPath)
	var raw map[string]interface{}
	json.Unmarshal(data, &raw)

	requiredFields := []string{"schemaVersion", "origin", "cellSize", "cols", "rows", "deposition", "vMaxGrid", "pMaxGrid", "metadata"}
	for _, f := range requiredFields {
		if _, ok := raw[f]; !ok {
			t.Errorf("missing required field: %s", f)
		}
	}

	meta, ok := raw["metadata"].(map[string]interface{})
	if !ok {
		t.Fatal("metadata is not an object")
	}
	metaFields := []string{"solverVersion", "runtime", "steps", "simulationTime", "massConservation"}
	for _, f := range metaFields {
		if _, ok := meta[f]; !ok {
			t.Errorf("missing required metadata field: %s", f)
		}
	}
}

// ---------------------------------------------------------------------------
// Plausibility validation tests
// ---------------------------------------------------------------------------

func TestValidatePlausibility_Healthy(t *testing.T) {
	dep := []float32{0.0, 0.5, 1.2, 0.3, 0.0, 0.0}
	vel := []float32{0.0, 5.0, 12.0, 8.0, 0.0, 0.0}
	meta := ResultMeta{
		MassInitial:      6.0,
		MassDeposited:    2.0,
		MassConservation: 2.0 / 6.0,
	}
	if err := validatePlausibility(dep, vel, meta); err != nil {
		t.Errorf("expected no error for healthy result, got: %v", err)
	}
}

func TestValidatePlausibility_NoFlow(t *testing.T) {
	dep := make([]float32, 6) // all zeros
	vel := make([]float32, 6)
	meta := ResultMeta{MassInitial: 6.0, MassDeposited: 0.0, MassConservation: 0.0}
	err := validatePlausibility(dep, vel, meta)
	if err == nil {
		t.Error("expected error for zero deposition (no flow)")
	}
}

func TestValidatePlausibility_NegativeDepth(t *testing.T) {
	dep := []float32{0.5, -0.1, 0.0}
	vel := []float32{5.0, 3.0, 0.0}
	meta := ResultMeta{MassInitial: 1.0, MassDeposited: 0.4, MassConservation: 0.4}
	err := validatePlausibility(dep, vel, meta)
	if err == nil {
		t.Error("expected error for negative deposition")
	}
}

func TestValidatePlausibility_ExtremeDepth(t *testing.T) {
	dep := []float32{0.5, 150.0, 0.0}
	vel := []float32{5.0, 3.0, 0.0}
	meta := ResultMeta{MassInitial: 1.0, MassDeposited: 150.5, MassConservation: 150.5}
	err := validatePlausibility(dep, vel, meta)
	if err == nil {
		t.Error("expected error for 150m deposition depth")
	}
}

func TestValidatePlausibility_ExtremeVelocity(t *testing.T) {
	dep := []float32{0.5, 1.0, 0.0}
	vel := []float32{5.0, 250.0, 0.0}
	meta := ResultMeta{MassInitial: 1.0, MassDeposited: 1.5, MassConservation: 1.5}
	err := validatePlausibility(dep, vel, meta)
	if err == nil {
		t.Error("expected error for 250 m/s velocity")
	}
}

func TestValidatePlausibility_MassExplosion(t *testing.T) {
	dep := []float32{0.5, 1.0, 0.3}
	vel := []float32{5.0, 3.0, 1.0}
	meta := ResultMeta{MassInitial: 0.2, MassDeposited: 1.8, MassConservation: 9.0}
	err := validatePlausibility(dep, vel, meta)
	if err == nil {
		t.Error("expected error for 9x mass growth")
	}
}

func TestConvertOutput_FieldSizeMismatch(t *testing.T) {
	// Simulate the bug: grid says 4x3=12 but field has 6 values (wrong mesh)
	grid := GridSpec{
		Origin:   [2]float64{0, 0},
		CellSize: 15,
		Cols:     4,
		Rows:     3,
	}
	caseDir := setupTestCase(t, grid, "", sampleScalarH, sampleVectorUs)

	_, err := ConvertOutput(caseDir, 250.0, 1.0)
	if err == nil {
		t.Error("expected error when field size (6) doesn't match grid (12)")
	}
}

func TestExpandToFloat32Uniform(t *testing.T) {
	result := expandToFloat32([]float64{3.14}, 5)
	if len(result) != 5 {
		t.Fatalf("expected 5 values, got %d", len(result))
	}
	for i, v := range result {
		if math.Abs(float64(v)-3.14) > 1e-5 {
			t.Errorf("value[%d]: expected 3.14, got %f", i, v)
		}
	}
}

func TestExpandToFloat32NonUniform(t *testing.T) {
	values := []float64{1.0, 2.0, 3.0}
	result := expandToFloat32(values, 3)
	if len(result) != 3 {
		t.Fatalf("expected 3 values, got %d", len(result))
	}
	for i, v := range result {
		if float64(v) != values[i] {
			t.Errorf("value[%d]: expected %f, got %f", i, values[i], v)
		}
	}
}

func TestExpandToFloat32Truncate(t *testing.T) {
	// If OpenFOAM outputs more cells than our grid (shouldn't happen, but handle gracefully)
	values := []float64{1.0, 2.0, 3.0, 4.0, 5.0}
	result := expandToFloat32(values, 3)
	if len(result) != 3 {
		t.Fatalf("expected 3 values, got %d", len(result))
	}
}

func TestReadGridSpec(t *testing.T) {
	dir := t.TempDir()
	input := `{
		"schemaVersion": 1,
		"dem": {
			"origin": [-116.8425, 51.042],
			"cellSize": 15,
			"cols": 6,
			"rows": 8
		}
	}`
	path := filepath.Join(dir, "input.json")
	os.WriteFile(path, []byte(input), 0644)

	grid, err := ReadGridSpec(path)
	if err != nil {
		t.Fatal(err)
	}

	if grid.Origin[0] != -116.8425 || grid.Origin[1] != 51.042 {
		t.Errorf("origin: %v", grid.Origin)
	}
	if grid.CellSize != 15 {
		t.Errorf("cellSize: %f", grid.CellSize)
	}
	if grid.Cols != 6 || grid.Rows != 8 {
		t.Errorf("dimensions: %dx%d", grid.Cols, grid.Rows)
	}
}

func TestReadGridSpecInvalid(t *testing.T) {
	dir := t.TempDir()
	input := `{"dem": {"origin": [0,0], "cellSize": 15, "cols": 0, "rows": 8}}`
	path := filepath.Join(dir, "input.json")
	os.WriteFile(path, []byte(input), 0644)

	_, err := ReadGridSpec(path)
	if err == nil {
		t.Error("expected error for zero cols")
	}
}

func TestPressureCalculation(t *testing.T) {
	// Verify p = 0.5 * density * v^2 / 1000 (kPa)
	density := 250.0
	velocity := 10.0 // m/s
	expected := 0.5 * density * velocity * velocity / 1000.0 // = 12.5 kPa

	grid := GridSpec{Origin: [2]float64{0, 0}, CellSize: 15, Cols: 1, Rows: 1}

	// Create a case with known velocity and deposition
	dir := t.TempDir()
	inputData, _ := json.Marshal(InputJSON{DEM: struct {
		Origin   [2]float64 `json:"origin"`
		CellSize float64    `json:"cellSize"`
		Cols     int        `json:"cols"`
		Rows     int        `json:"rows"`
	}{Origin: grid.Origin, CellSize: grid.CellSize, Cols: grid.Cols, Rows: grid.Rows}})
	os.WriteFile(filepath.Join(dir, "input.json"), inputData, 0644)

	timeDir := filepath.Join(dir, "10")
	os.MkdirAll(timeDir, 0755)

	hContent := `FoamFile
{
    version     2.0;
    format      ascii;
    class       areaScalarField;
    object      h;
}
dimensions      [0 1 0 0 0 0 0];

internalField   nonuniform List<scalar>
1
(
0.5
)
;
`
	usContent := `FoamFile
{
    version     2.0;
    format      ascii;
    class       areaVectorField;
    object      Us;
}
dimensions      [0 1 -1 0 0 0 0];

internalField   nonuniform List<vector>
1
(
(10.0 0.0 0.0)
)
;
`
	os.WriteFile(filepath.Join(timeDir, "h"), []byte(hContent), 0644)
	os.WriteFile(filepath.Join(timeDir, "Us"), []byte(usContent), 0644)

	result, err := ConvertOutput(dir, density, 1.0)
	if err != nil {
		t.Fatal(err)
	}

	if math.Abs(float64(result.PMaxGrid[0])-expected) > 0.01 {
		t.Errorf("pressure: expected %.2f kPa, got %.2f kPa", expected, result.PMaxGrid[0])
	}
}
