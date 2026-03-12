package schema

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
)

type ElevationPoint struct {
	LngLat            [2]float64 `json:"lngLat"`
	Elevation         float64    `json:"elevation"`
	DistanceFromCrown float64    `json:"distanceFromCrown"`
}

type DEM struct {
	Origin    [2]float64 `json:"origin"`
	CellSize  float64    `json:"cellSize"`
	Rows      int        `json:"rows"`
	Cols      int        `json:"cols"`
	Elevation []any      `json:"elevation"` // float64 or null
}

type StartingZone struct {
	Type        string        `json:"type"`
	Coordinates [][][2]float64 `json:"coordinates"`
}

type SnowProfile struct {
	ID                string  `json:"id"`
	Label             string  `json:"label"`
	Density           float64 `json:"density"`
	EntrainmentFactor float64 `json:"entrainmentFactor"`
	FrictionMu        float64 `json:"frictionMu"`
	FrictionXi        float64 `json:"frictionXi"`
}

type RegionCoefficients struct {
	ID     string  `json:"id"`
	Label  string  `json:"label"`
	A      float64 `json:"a"`
	B      float64 `json:"b"`
	Sigma  float64 `json:"sigma"`
	Source string  `json:"source"`
}

type PrimaryPath struct {
	CrownPoint       ElevationPoint   `json:"crownPoint"`
	BetaPoint        ElevationPoint   `json:"betaPoint"`
	RunoutPoint      ElevationPoint   `json:"runoutPoint"`
	FallLineAzimuth  float64          `json:"fallLineAzimuth"`
	BetaAngle        float64          `json:"betaAngle"`
	AlphaAngle       float64          `json:"alphaAngle"`
	Profile          []ElevationPoint `json:"profile"`
}

type Input struct {
	SchemaVersion      int                `json:"schemaVersion"`
	DEM                DEM                `json:"dem"`
	ReleaseCells       [][2]int           `json:"releaseCells"`
	StartingZone       StartingZone       `json:"startingZone"`
	SnowDepthM         float64            `json:"snowDepthM"`
	SnowProfile        SnowProfile        `json:"snowProfile"`
	RegionCoefficients RegionCoefficients `json:"regionCoefficients"`
	PrimaryPath        PrimaryPath        `json:"primaryPath"`
}

type Metadata struct {
	SolverVersion    string  `json:"solverVersion"`
	Runtime          float64 `json:"runtime"`
	Steps            int     `json:"steps"`
	SimulationTime   float64 `json:"simulationTime"`
	MassConservation float64 `json:"massConservation"`
	MassInitial      float64 `json:"massInitial,omitempty"`
	MassEntrained    float64 `json:"massEntrained,omitempty"`
	MassDeposited    float64 `json:"massDeposited,omitempty"`
}

type Output struct {
	SchemaVersion int        `json:"schemaVersion"`
	Origin        [2]float64 `json:"origin"`
	CellSize      float64    `json:"cellSize"`
	Cols          int        `json:"cols"`
	Rows          int        `json:"rows"`
	Deposition    []float64  `json:"deposition"`
	VMaxGrid      []float64  `json:"vMaxGrid"`
	PMaxGrid      []float64  `json:"pMaxGrid"`
	Metadata      Metadata   `json:"metadata"`
}

func ParseInput(data []byte) (*Input, error) {
	var input Input
	if err := json.Unmarshal(data, &input); err != nil {
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}
	return &input, nil
}

func ValidateInput(input *Input) error {
	if input.SchemaVersion != 1 {
		return errors.New("schemaVersion must be 1")
	}

	// DEM validation
	d := &input.DEM
	if d.Rows < 1 || d.Rows > 300 {
		return fmt.Errorf("dem.rows must be 1–300, got %d", d.Rows)
	}
	if d.Cols < 1 || d.Cols > 300 {
		return fmt.Errorf("dem.cols must be 1–300, got %d", d.Cols)
	}
	if d.Rows*d.Cols > 90000 {
		return fmt.Errorf("dem grid exceeds 90,000 cells (%d)", d.Rows*d.Cols)
	}
	if d.CellSize <= 0 {
		return errors.New("dem.cellSize must be > 0")
	}
	if len(d.Elevation) != d.Rows*d.Cols {
		return fmt.Errorf("dem.elevation length %d != rows*cols %d", len(d.Elevation), d.Rows*d.Cols)
	}
	for i, v := range d.Elevation {
		if v == nil {
			continue // null is allowed
		}
		f, ok := v.(float64)
		if !ok {
			return fmt.Errorf("dem.elevation[%d]: expected number or null", i)
		}
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return fmt.Errorf("dem.elevation[%d]: must be finite", i)
		}
	}

	// Release cells
	if len(input.ReleaseCells) < 1 {
		return errors.New("releaseCells must have at least 1 entry")
	}
	for i, rc := range input.ReleaseCells {
		if rc[0] < 0 || rc[0] >= d.Rows || rc[1] < 0 || rc[1] >= d.Cols {
			return fmt.Errorf("releaseCells[%d] [%d,%d] out of DEM bounds", i, rc[0], rc[1])
		}
	}

	// Snow depth
	if input.SnowDepthM <= 0 {
		return errors.New("snowDepthM must be > 0")
	}

	// Snow profile
	sp := &input.SnowProfile
	if sp.ID == "" {
		return errors.New("snowProfile.id is required")
	}
	if sp.Label == "" {
		return errors.New("snowProfile.label is required")
	}
	if sp.Density < 80 || sp.Density > 450 {
		return fmt.Errorf("snowProfile.density must be 80–450, got %g", sp.Density)
	}
	if sp.EntrainmentFactor < 1.0 || sp.EntrainmentFactor > 4.0 {
		return fmt.Errorf("snowProfile.entrainmentFactor must be 1.0–4.0, got %g", sp.EntrainmentFactor)
	}
	if sp.FrictionMu < 0.25 || sp.FrictionMu > 0.45 {
		return fmt.Errorf("snowProfile.frictionMu must be 0.25–0.45, got %g", sp.FrictionMu)
	}
	if sp.FrictionXi < 800 || sp.FrictionXi > 2000 {
		return fmt.Errorf("snowProfile.frictionXi must be 800–2000, got %g", sp.FrictionXi)
	}

	// Region coefficients
	rc := &input.RegionCoefficients
	if rc.ID == "" {
		return errors.New("regionCoefficients.id is required")
	}
	if rc.Label == "" {
		return errors.New("regionCoefficients.label is required")
	}
	if rc.Source == "" {
		return errors.New("regionCoefficients.source is required")
	}

	// Primary path
	pp := &input.PrimaryPath
	if len(pp.Profile) == 0 {
		return errors.New("primaryPath.profile must not be empty")
	}

	return nil
}
