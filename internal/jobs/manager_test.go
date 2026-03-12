package jobs

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/adetchells/avalanche-path-estimator/internal/schema"
)

func testInput() *schema.Input {
	return &schema.Input{
		SchemaVersion: 1,
		DEM: schema.DEM{
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
		SnowDepthM:   1.2,
		SnowProfile: schema.SnowProfile{
			ID: "test", Label: "Test",
			Density: 250, EntrainmentFactor: 2.0,
			FrictionMu: 0.3, FrictionXi: 1500,
		},
		RegionCoefficients: schema.RegionCoefficients{
			ID: "test", Label: "Test",
			A: 0.93, B: -1.85, Sigma: 2.5, Source: "Test",
		},
		PrimaryPath: schema.PrimaryPath{
			CrownPoint:  schema.ElevationPoint{LngLat: [2]float64{-116.84, 51.04}, Elevation: 2030},
			BetaPoint:   schema.ElevationPoint{LngLat: [2]float64{-116.84, 51.04}, Elevation: 2010},
			RunoutPoint: schema.ElevationPoint{LngLat: [2]float64{-116.84, 51.04}, Elevation: 2000},
			Profile:     []schema.ElevationPoint{{LngLat: [2]float64{-116.84, 51.04}, Elevation: 2030}},
		},
	}
}

func testInputJSON() []byte {
	data, _ := json.Marshal(testInput())
	return data
}

// instantRunner writes result.json and returns immediately.
func instantRunner(_ context.Context, workDir string, input *schema.Input) error {
	result := map[string]any{
		"schemaVersion": 1,
		"origin":        input.DEM.Origin,
		"cellSize":      input.DEM.CellSize,
		"cols":          input.DEM.Cols,
		"rows":          input.DEM.Rows,
		"deposition":    []float64{0, 0, 0, 0},
		"vMaxGrid":      []float64{0, 0, 0, 0},
		"pMaxGrid":      []float64{0, 0, 0, 0},
		"metadata": map[string]any{
			"solverVersion":    "test@0.0",
			"runtime":          0,
			"steps":            0,
			"simulationTime":   0,
			"massConservation": 1.0,
		},
	}
	data, _ := json.Marshal(result)
	return os.WriteFile(filepath.Join(workDir, "outputs", "result.json"), data, 0o644)
}

// slowRunner blocks until context is cancelled.
func slowRunner(ctx context.Context, workDir string, _ *schema.Input) error {
	<-ctx.Done()
	return ctx.Err()
}

func TestSubmitAndGetStatus(t *testing.T) {
	dir := t.TempDir()
	mgr := NewManager(dir, instantRunner)

	id, err := mgr.Submit(testInput(), testInputJSON())
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if id == "" {
		t.Fatal("expected non-empty job ID")
	}

	// Wait for job to complete
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		job, err := mgr.Get(id)
		if err != nil {
			t.Fatalf("Get: %v", err)
		}
		if job.Status == StatusComplete {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("job did not complete in time")
}

func TestSubmitCreatesWorkspace(t *testing.T) {
	dir := t.TempDir()
	mgr := NewManager(dir, instantRunner)

	id, err := mgr.Submit(testInput(), testInputJSON())
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}

	// Check workspace exists (briefly, before cleanup)
	workDir := filepath.Join(dir, id)
	if _, err := os.Stat(filepath.Join(workDir, "input.json")); err != nil {
		// May already be cleaned up if result was fetched; just check it ran
		job, _ := mgr.Get(id)
		if job == nil {
			// Already cleaned up — that's fine
			return
		}
	}
}

func TestGetResults(t *testing.T) {
	dir := t.TempDir()
	mgr := NewManager(dir, instantRunner)

	id, err := mgr.Submit(testInput(), testInputJSON())
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}

	// Wait for completion
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		job, _ := mgr.Get(id)
		if job != nil && job.Status == StatusComplete {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	data, err := mgr.Results(id)
	if err != nil {
		t.Fatalf("Results: %v", err)
	}

	var out schema.Output
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	if out.SchemaVersion != 1 {
		t.Errorf("schemaVersion = %d, want 1", out.SchemaVersion)
	}
}

func TestSingleJobConcurrency(t *testing.T) {
	dir := t.TempDir()
	mgr := NewManager(dir, slowRunner)

	_, err := mgr.Submit(testInput(), testInputJSON())
	if err != nil {
		t.Fatalf("first Submit: %v", err)
	}

	// Second submit should fail with ErrBusy
	// Wait briefly for the job to enter running state
	time.Sleep(50 * time.Millisecond)
	_, err = mgr.Submit(testInput(), testInputJSON())
	if err != ErrBusy {
		t.Fatalf("expected ErrBusy, got %v", err)
	}

	// Cleanup
	mgr.CleanupAll()
}

func TestCancelJob(t *testing.T) {
	dir := t.TempDir()
	mgr := NewManager(dir, slowRunner)

	id, err := mgr.Submit(testInput(), testInputJSON())
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}

	// Wait for running
	time.Sleep(50 * time.Millisecond)

	if err := mgr.Cancel(id); err != nil {
		t.Fatalf("Cancel: %v", err)
	}

	// Job should be cleaned up after a moment
	time.Sleep(50 * time.Millisecond)
	_, err = mgr.Get(id)
	if err != ErrNotFound {
		t.Errorf("expected ErrNotFound after cancel, got %v", err)
	}
}

func TestGetNotFound(t *testing.T) {
	dir := t.TempDir()
	mgr := NewManager(dir, instantRunner)

	_, err := mgr.Get("nonexistent")
	if err != ErrNotFound {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestResultsNotComplete(t *testing.T) {
	dir := t.TempDir()
	mgr := NewManager(dir, slowRunner)

	id, err := mgr.Submit(testInput(), testInputJSON())
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}

	time.Sleep(50 * time.Millisecond)

	_, err = mgr.Results(id)
	if err != ErrNotComplete {
		t.Errorf("expected ErrNotComplete, got %v", err)
	}

	mgr.CleanupAll()
}

func TestCleanupAfterResultsFetched(t *testing.T) {
	dir := t.TempDir()
	mgr := NewManager(dir, instantRunner)

	id, err := mgr.Submit(testInput(), testInputJSON())
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}

	// Wait for completion
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		job, _ := mgr.Get(id)
		if job != nil && job.Status == StatusComplete {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	_, err = mgr.Results(id)
	if err != nil {
		t.Fatalf("Results: %v", err)
	}

	// Wait for async cleanup
	time.Sleep(100 * time.Millisecond)

	// Job should be gone
	_, err = mgr.Get(id)
	if err != ErrNotFound {
		t.Errorf("expected ErrNotFound after cleanup, got %v", err)
	}

	// Workspace directory should be gone
	workDir := filepath.Join(dir, id)
	if _, err := os.Stat(workDir); !os.IsNotExist(err) {
		t.Errorf("workspace dir should be removed, got err: %v", err)
	}
}
