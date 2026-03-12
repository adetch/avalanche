// Package convert handles conversion of OpenFOAM solver output to the app's
// FlowPyGridResult JSON format (schemaVersion 1).
package convert

import (
	"bufio"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// ResultJSON is the output schema (schemaVersion 1) matching FlowPyGridResult.
type ResultJSON struct {
	SchemaVersion int          `json:"schemaVersion"`
	Origin        [2]float64   `json:"origin"`
	CellSize      float64      `json:"cellSize"`
	Cols          int          `json:"cols"`
	Rows          int          `json:"rows"`
	Deposition    []float32    `json:"deposition"`
	VMaxGrid      []float32    `json:"vMaxGrid"`
	PMaxGrid      []float32    `json:"pMaxGrid"`
	Metadata      ResultMeta   `json:"metadata"`
}

// ResultMeta holds solver run information.
type ResultMeta struct {
	SolverVersion    string  `json:"solverVersion"`
	Runtime          float64 `json:"runtime"`
	Steps            int     `json:"steps"`
	SimulationTime   float64 `json:"simulationTime"`
	MassConservation float64 `json:"massConservation"`
	MassInitial      float64 `json:"massInitial,omitempty"`
	MassEntrained    float64 `json:"massEntrained,omitempty"`
	MassDeposited    float64 `json:"massDeposited,omitempty"`
}

// GridSpec describes the DEM grid geometry, read from the input.json.
type GridSpec struct {
	Origin   [2]float64 // [lng, lat] SW corner
	CellSize float64
	Cols     int
	Rows     int
}

// InputJSON is a minimal representation of the solver input, used only to
// extract grid geometry.
type InputJSON struct {
	DEM struct {
		Origin   [2]float64 `json:"origin"`
		CellSize float64    `json:"cellSize"`
		Cols     int        `json:"cols"`
		Rows     int        `json:"rows"`
	} `json:"dem"`
}

// ConvertResult holds the conversion output before serialization.
type ConvertResult struct {
	Grid       GridSpec
	Deposition []float32
	VMaxGrid   []float32
	PMaxGrid   []float32
	Meta       ResultMeta
}

// ReadGridSpec reads grid geometry from an input.json file.
func ReadGridSpec(path string) (GridSpec, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return GridSpec{}, fmt.Errorf("reading input.json: %w", err)
	}
	var input InputJSON
	if err := json.Unmarshal(data, &input); err != nil {
		return GridSpec{}, fmt.Errorf("parsing input.json: %w", err)
	}
	if input.DEM.Cols <= 0 || input.DEM.Rows <= 0 {
		return GridSpec{}, fmt.Errorf("invalid grid dimensions: %dx%d", input.DEM.Cols, input.DEM.Rows)
	}
	return GridSpec{
		Origin:   input.DEM.Origin,
		CellSize: input.DEM.CellSize,
		Cols:     input.DEM.Cols,
		Rows:     input.DEM.Rows,
	}, nil
}

// ParseOpenFOAMScalar parses an OpenFOAM ASCII scalar field file (areaScalarField
// or volScalarField) and returns the internal field values.
func ParseOpenFOAMScalar(path string) ([]float64, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("opening field file %s: %w", path, err)
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 10*1024*1024)

	// Scan until we find "internalField"
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, "internalField") {
			return parseInternalScalar(line, scanner)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scanning %s: %w", path, err)
	}
	return nil, fmt.Errorf("no internalField found in %s", path)
}

// parseInternalScalar parses the internalField from an OpenFOAM scalar field.
// Handles both uniform and nonuniform formats.
func parseInternalScalar(firstLine string, scanner *bufio.Scanner) ([]float64, error) {
	// Check for uniform (but not nonuniform): "internalField   uniform 0;"
	parts := strings.Fields(firstLine)
	isUniform := false
	for _, p := range parts {
		if p == "uniform" {
			isUniform = true
			break
		}
	}
	if isUniform {
		for i, p := range parts {
			if p == "uniform" && i+1 < len(parts) {
				valStr := strings.TrimRight(parts[i+1], ";")
				v, err := strconv.ParseFloat(valStr, 64)
				if err != nil {
					return nil, fmt.Errorf("parsing uniform value: %w", err)
				}
				// For uniform, return single-element slice; caller expands to grid size.
				return []float64{v}, nil
			}
		}
		return nil, fmt.Errorf("malformed uniform internalField: %s", firstLine)
	}

	// Nonuniform: read count, then values between ( and )
	// Format: "internalField   nonuniform List<scalar>"
	// Next line(s): count, then "(", values, ")"
	// Or inline: count(val1 val2 ...)

	var count int

	// The count might be on the same line or the next line
	if strings.Contains(firstLine, "List<scalar>") {
		// Try to find count after "List<scalar>"
		idx := strings.Index(firstLine, "List<scalar>")
		rest := strings.TrimSpace(firstLine[idx+len("List<scalar>"):])
		if rest != "" {
			// Inline: "List<scalar>\n48" or "List<scalar> \n48"
			rest = strings.TrimRight(rest, ";")
			if n, err := strconv.Atoi(rest); err == nil {
				count = n
			}
		}
	}

	if count == 0 {
		// Count on next line
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" || line == "//" {
				continue
			}
			n, err := strconv.Atoi(line)
			if err != nil {
				return nil, fmt.Errorf("expected cell count, got: %q", line)
			}
			count = n
			break
		}
	}

	if count <= 0 {
		return nil, fmt.Errorf("invalid cell count: %d", count)
	}

	// Read past opening "("
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "(" {
			break
		}
	}

	// Read values until ")"
	values := make([]float64, 0, count)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == ")" || strings.HasPrefix(line, ")") {
			break
		}
		v, err := strconv.ParseFloat(line, 64)
		if err != nil {
			return nil, fmt.Errorf("parsing scalar value %q: %w", line, err)
		}
		values = append(values, v)
	}

	if len(values) != count {
		return nil, fmt.Errorf("expected %d values, got %d", count, len(values))
	}

	return values, nil
}

// ParseOpenFOAMVector parses an OpenFOAM ASCII vector field file and returns
// the magnitude of each vector.
func ParseOpenFOAMVector(path string) ([]float64, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("opening field file %s: %w", path, err)
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 10*1024*1024)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, "internalField") {
			return parseInternalVector(line, scanner)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scanning %s: %w", path, err)
	}
	return nil, fmt.Errorf("no internalField found in %s", path)
}

// parseInternalVector parses the internalField from an OpenFOAM vector field,
// returning the magnitude of each vector.
func parseInternalVector(firstLine string, scanner *bufio.Scanner) ([]float64, error) {
	// Uniform (but not nonuniform): "internalField   uniform (0 0 0);"
	vParts := strings.Fields(firstLine)
	isUniform := false
	for _, p := range vParts {
		if p == "uniform" {
			isUniform = true
			break
		}
	}
	if isUniform {
		parenStart := strings.Index(firstLine, "(")
		parenEnd := strings.Index(firstLine, ")")
		if parenStart >= 0 && parenEnd > parenStart {
			inner := firstLine[parenStart+1 : parenEnd]
			comps := strings.Fields(inner)
			if len(comps) < 2 {
				return nil, fmt.Errorf("expected at least 2 vector components, got %d", len(comps))
			}
			mag := vectorMagnitude(comps)
			return []float64{mag}, nil
		}
		return nil, fmt.Errorf("malformed uniform vector: %s", firstLine)
	}

	// Nonuniform List<vector>
	var count int
	if strings.Contains(firstLine, "List<vector>") {
		idx := strings.Index(firstLine, "List<vector>")
		rest := strings.TrimSpace(firstLine[idx+len("List<vector>"):])
		rest = strings.TrimRight(rest, ";")
		if rest != "" {
			if n, err := strconv.Atoi(rest); err == nil {
				count = n
			}
		}
	}

	if count == 0 {
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			n, err := strconv.Atoi(line)
			if err != nil {
				return nil, fmt.Errorf("expected cell count for vector field, got: %q", line)
			}
			count = n
			break
		}
	}

	if count <= 0 {
		return nil, fmt.Errorf("invalid cell count for vector: %d", count)
	}

	// Read past "("
	for scanner.Scan() {
		if strings.TrimSpace(scanner.Text()) == "(" {
			break
		}
	}

	magnitudes := make([]float64, 0, count)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == ")" || strings.HasPrefix(line, ")") {
			break
		}
		// Vector line: "(vx vy vz)" or "(vx vy)"
		line = strings.Trim(line, "()")
		comps := strings.Fields(line)
		if len(comps) < 2 {
			return nil, fmt.Errorf("malformed vector: %q", line)
		}
		magnitudes = append(magnitudes, vectorMagnitude(comps))
	}

	if len(magnitudes) != count {
		return nil, fmt.Errorf("expected %d vectors, got %d", count, len(magnitudes))
	}

	return magnitudes, nil
}

func vectorMagnitude(comps []string) float64 {
	var sum float64
	for _, c := range comps {
		v, err := strconv.ParseFloat(c, 64)
		if err != nil {
			continue
		}
		sum += v * v
	}
	return math.Sqrt(sum)
}

// FindLatestTimeDir finds the latest time directory in an OpenFOAM case.
// OpenFOAM writes output to directories named by timestamp (e.g., "0", "0.5", "45.2").
func FindLatestTimeDir(caseDir string) (string, float64, error) {
	entries, err := os.ReadDir(caseDir)
	if err != nil {
		return "", 0, fmt.Errorf("reading case directory: %w", err)
	}

	type timeEntry struct {
		name string
		val  float64
	}
	var times []timeEntry
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		// Skip non-numeric directories and "0" (initial conditions)
		val, err := strconv.ParseFloat(name, 64)
		if err != nil || val <= 0 {
			continue
		}
		times = append(times, timeEntry{name: name, val: val})
	}

	if len(times) == 0 {
		return "", 0, fmt.Errorf("no time directories found in %s", caseDir)
	}

	sort.Slice(times, func(i, j int) bool {
		return times[i].val > times[j].val
	})

	latest := times[0]
	return filepath.Join(caseDir, latest.name), latest.val, nil
}

// ConvertOutput reads OpenFOAM output from a case directory and produces
// a ConvertResult ready for JSON serialization.
//
// Expected case layout:
//
//	caseDir/
//	  input.json          – original job input (for grid geometry)
//	  <time>/h            – deposition depth field (areaScalarField)
//	  <time>/Us           – surface velocity field (areaVectorField)
//
// If h is missing, deposition is filled with zeros.
// If Us is missing, vMaxGrid and pMaxGrid are filled with zeros.
func ConvertOutput(caseDir string, density float64, wallClockSec float64) (*ConvertResult, error) {
	// Read grid spec from input.json
	inputPath := filepath.Join(caseDir, "input.json")
	grid, err := ReadGridSpec(inputPath)
	if err != nil {
		return nil, fmt.Errorf("reading grid spec: %w", err)
	}

	n := grid.Rows * grid.Cols

	// Find latest time directory
	timeDir, simTime, err := FindLatestTimeDir(caseDir)
	if err != nil {
		return nil, fmt.Errorf("finding time directory: %w", err)
	}

	// Parse deposition (h field)
	deposition := make([]float32, n)
	hPath := filepath.Join(timeDir, "h")
	if hValues, err := ParseOpenFOAMScalar(hPath); err == nil {
		deposition = expandToFloat32(hValues, n)
	}
	// If missing, deposition stays zero — graceful handling

	// Parse velocity (Us field)
	vMax := make([]float32, n)
	usPath := filepath.Join(timeDir, "Us")
	if vValues, err := ParseOpenFOAMVector(usPath); err == nil {
		vMax = expandToFloat32(vValues, n)
	}

	// Compute impact pressure: p = 0.5 * density * v^2 / 1000 (kPa)
	pMax := make([]float32, n)
	for i, v := range vMax {
		pMax[i] = float32(0.5 * float64(density) * float64(v) * float64(v) / 1000.0)
	}

	// Compute mass conservation
	var massDeposited float64
	for _, d := range deposition {
		massDeposited += float64(d)
	}

	// Count timesteps from time directories
	steps := countTimeSteps(caseDir)

	meta := ResultMeta{
		SolverVersion:    "openfoam-avalanche@2312",
		Runtime:          wallClockSec,
		Steps:            steps,
		SimulationTime:   simTime,
		MassConservation: 1.0, // Will be updated if we can read initial mass
		MassDeposited:    massDeposited,
	}

	// Try to read initial conditions for mass conservation
	zeroDir := filepath.Join(caseDir, "0")
	h0Path := filepath.Join(zeroDir, "h")
	if h0Values, err := ParseOpenFOAMScalar(h0Path); err == nil {
		h0 := expandToFloat32(h0Values, n)
		var massInitial float64
		for _, d := range h0 {
			massInitial += float64(d)
		}
		meta.MassInitial = massInitial
		if massInitial > 0 {
			meta.MassConservation = massDeposited / massInitial
		}
	}

	return &ConvertResult{
		Grid:       grid,
		Deposition: deposition,
		VMaxGrid:   vMax,
		PMaxGrid:   pMax,
		Meta:       meta,
	}, nil
}

// expandToFloat32 converts float64 values to a float32 slice of length n.
// If values has one element (uniform), it's expanded to fill n cells.
// If values length matches n, it's converted directly.
func expandToFloat32(values []float64, n int) []float32 {
	out := make([]float32, n)
	if len(values) == 1 {
		v := float32(values[0])
		for i := range out {
			out[i] = v
		}
		return out
	}
	count := len(values)
	if count > n {
		count = n
	}
	for i := 0; i < count; i++ {
		out[i] = float32(values[i])
	}
	return out
}

// countTimeSteps counts the number of time directories (excluding "0") in a case.
func countTimeSteps(caseDir string) int {
	entries, err := os.ReadDir(caseDir)
	if err != nil {
		return 0
	}
	count := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if _, err := strconv.ParseFloat(e.Name(), 64); err == nil {
			count++
		}
	}
	return count
}

// WriteResultJSON serializes a ConvertResult to a result.json file.
func WriteResultJSON(result *ConvertResult, outputPath string) error {
	out := ResultJSON{
		SchemaVersion: 1,
		Origin:        result.Grid.Origin,
		CellSize:      result.Grid.CellSize,
		Cols:          result.Grid.Cols,
		Rows:          result.Grid.Rows,
		Deposition:    result.Deposition,
		VMaxGrid:      result.VMaxGrid,
		PMaxGrid:      result.PMaxGrid,
		Metadata:      result.Meta,
	}

	data, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling result JSON: %w", err)
	}

	if err := os.WriteFile(outputPath, data, 0644); err != nil {
		return fmt.Errorf("writing result.json: %w", err)
	}

	return nil
}
