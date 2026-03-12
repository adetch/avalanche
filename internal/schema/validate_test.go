package schema

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func repoRoot() string {
	_, f, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(f), "..", "..")
}

func TestParseSampleInput(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(repoRoot(), "docs", "solver", "sample_input.json"))
	if err != nil {
		t.Fatalf("read sample_input.json: %v", err)
	}
	input, err := ParseInput(data)
	if err != nil {
		t.Fatalf("ParseInput: %v", err)
	}
	if err := ValidateInput(input); err != nil {
		t.Fatalf("ValidateInput: %v", err)
	}
	if input.SchemaVersion != 1 {
		t.Errorf("schemaVersion = %d, want 1", input.SchemaVersion)
	}
	if input.DEM.Rows != 8 || input.DEM.Cols != 6 {
		t.Errorf("DEM size = %dx%d, want 8x6", input.DEM.Rows, input.DEM.Cols)
	}
	if len(input.ReleaseCells) != 4 {
		t.Errorf("releaseCells len = %d, want 4", len(input.ReleaseCells))
	}
}

func TestValidateInput_SchemaVersion(t *testing.T) {
	input := validInput()
	input.SchemaVersion = 2
	err := ValidateInput(input)
	if err == nil || !strings.Contains(err.Error(), "schemaVersion") {
		t.Errorf("expected schemaVersion error, got %v", err)
	}
}

func TestValidateInput_DEMBounds(t *testing.T) {
	input := validInput()
	input.DEM.Rows = 0
	if err := ValidateInput(input); err == nil {
		t.Error("expected error for rows=0")
	}

	input = validInput()
	input.DEM.Rows = 301
	if err := ValidateInput(input); err == nil {
		t.Error("expected error for rows=301")
	}

	input = validInput()
	input.DEM.Cols = 301
	if err := ValidateInput(input); err == nil {
		t.Error("expected error for cols=301")
	}
}

func TestValidateInput_DEMGridLimit(t *testing.T) {
	input := validInput()
	input.DEM.Rows = 300
	input.DEM.Cols = 301 // exceeds 90000
	if err := ValidateInput(input); err == nil {
		t.Error("expected error for grid > 90000")
	}
}

func TestValidateInput_EmptyReleaseCells(t *testing.T) {
	input := validInput()
	input.ReleaseCells = nil
	if err := ValidateInput(input); err == nil {
		t.Error("expected error for empty releaseCells")
	}
}

func TestValidateInput_ReleaseCellsOutOfBounds(t *testing.T) {
	input := validInput()
	input.ReleaseCells = [][2]int{{99, 0}}
	if err := ValidateInput(input); err == nil {
		t.Error("expected error for out-of-bounds release cell")
	}
}

func TestValidateInput_SnowDepth(t *testing.T) {
	input := validInput()
	input.SnowDepthM = 0
	if err := ValidateInput(input); err == nil {
		t.Error("expected error for snowDepthM=0")
	}
}

func TestValidateInput_SnowProfileRanges(t *testing.T) {
	tests := []struct {
		name string
		mod  func(*Input)
	}{
		{"density low", func(i *Input) { i.SnowProfile.Density = 79 }},
		{"density high", func(i *Input) { i.SnowProfile.Density = 451 }},
		{"entrainment low", func(i *Input) { i.SnowProfile.EntrainmentFactor = 0.9 }},
		{"entrainment high", func(i *Input) { i.SnowProfile.EntrainmentFactor = 4.1 }},
		{"mu low", func(i *Input) { i.SnowProfile.FrictionMu = 0.24 }},
		{"mu high", func(i *Input) { i.SnowProfile.FrictionMu = 0.46 }},
		{"xi low", func(i *Input) { i.SnowProfile.FrictionXi = 799 }},
		{"xi high", func(i *Input) { i.SnowProfile.FrictionXi = 2001 }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			input := validInput()
			tt.mod(input)
			if err := ValidateInput(input); err == nil {
				t.Error("expected validation error")
			}
		})
	}
}

func TestValidateInput_EmptyProfile(t *testing.T) {
	input := validInput()
	input.PrimaryPath.Profile = nil
	if err := ValidateInput(input); err == nil {
		t.Error("expected error for empty profile")
	}
}

func validInput() *Input {
	return &Input{
		SchemaVersion: 1,
		DEM: DEM{
			Origin:   [2]float64{-116.84, 51.04},
			CellSize: 15,
			Rows:     2,
			Cols:     2,
			Elevation: []any{
				float64(2000), float64(2010),
				float64(2020), float64(2030),
			},
		},
		ReleaseCells: [][2]int{{1, 0}},
		StartingZone: StartingZone{
			Type:        "Polygon",
			Coordinates: [][][2]float64{{{-116.84, 51.04}, {-116.83, 51.04}, {-116.83, 51.05}, {-116.84, 51.05}, {-116.84, 51.04}}},
		},
		SnowDepthM: 1.2,
		SnowProfile: SnowProfile{
			ID:                "test",
			Label:             "Test",
			Density:           250,
			EntrainmentFactor: 2.0,
			FrictionMu:        0.3,
			FrictionXi:        1500,
		},
		RegionCoefficients: RegionCoefficients{
			ID:     "test",
			Label:  "Test",
			A:      0.93,
			B:      -1.85,
			Sigma:  2.5,
			Source: "Test (2024)",
		},
		PrimaryPath: PrimaryPath{
			CrownPoint:  ElevationPoint{LngLat: [2]float64{-116.84, 51.04}, Elevation: 2030},
			BetaPoint:   ElevationPoint{LngLat: [2]float64{-116.84, 51.04}, Elevation: 2010},
			RunoutPoint: ElevationPoint{LngLat: [2]float64{-116.84, 51.04}, Elevation: 2000},
			Profile:     []ElevationPoint{{LngLat: [2]float64{-116.84, 51.04}, Elevation: 2030}},
		},
	}
}
