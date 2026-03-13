package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/adetchells/avalanche-path-estimator/internal/jobs"
	"github.com/adetchells/avalanche-path-estimator/internal/schema"
)

// instantRunner writes a minimal result.json and completes immediately.
func instantRunner(_ context.Context, workDir string, input *schema.Input) error {
	result := schema.Output{
		SchemaVersion: 1,
		Origin:        input.DEM.Origin,
		CellSize:      input.DEM.CellSize,
		Cols:          input.DEM.Cols,
		Rows:          input.DEM.Rows,
		Deposition:    make([]float64, input.DEM.Rows*input.DEM.Cols),
		VMaxGrid:      make([]float64, input.DEM.Rows*input.DEM.Cols),
		PMaxGrid:      make([]float64, input.DEM.Rows*input.DEM.Cols),
		Metadata: schema.Metadata{
			SolverVersion:    "stub@0.0",
			Runtime:          0,
			Steps:            0,
			SimulationTime:   0,
			MassConservation: 1.0,
		},
	}
	data, _ := json.Marshal(result)
	return os.WriteFile(filepath.Join(workDir, "outputs", "result.json"), data, 0o644)
}

// slowRunner blocks until cancelled.
func slowRunner(ctx context.Context, _ string, _ *schema.Input) error {
	<-ctx.Done()
	return ctx.Err()
}

func setupServer(t *testing.T, runFunc jobs.RunFunc) (*httptest.Server, *jobs.Manager) {
	t.Helper()
	dir := t.TempDir()
	mgr := jobs.NewManager(dir, runFunc)
	t.Cleanup(func() { mgr.CleanupAll() })

	mux := http.NewServeMux()
	mux.HandleFunc("POST /jobs", postJobHandler(mgr))
	mux.HandleFunc("GET /jobs/{id}", getJobHandler(mgr))
	mux.HandleFunc("GET /jobs/{id}/results", getResultsHandler(mgr))
	mux.HandleFunc("DELETE /jobs/{id}", deleteJobHandler(mgr))

	return httptest.NewServer(mux), mgr
}

func sampleInputJSON(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile("../../docs/solver/sample_input.json")
	if err != nil {
		t.Fatalf("read sample_input.json: %v", err)
	}
	return string(data)
}

func TestHTTP_PostJobAndGetStatus(t *testing.T) {
	srv, _ := setupServer(t, instantRunner)
	defer srv.Close()

	// POST /jobs
	resp, err := http.Post(srv.URL+"/jobs", "application/json", strings.NewReader(sampleInputJSON(t)))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("POST /jobs status = %d, body = %s", resp.StatusCode, body)
	}

	var created map[string]string
	json.NewDecoder(resp.Body).Decode(&created)
	resp.Body.Close()
	id := created["id"]
	if id == "" {
		t.Fatal("expected job id")
	}

	// Wait for completion
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		resp, _ = http.Get(srv.URL + "/jobs/" + id)
		var status map[string]any
		json.NewDecoder(resp.Body).Decode(&status)
		resp.Body.Close()
		if status["status"] == "complete" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	// GET /jobs/{id}/results
	resp, err = http.Get(srv.URL + "/jobs/" + id + "/results")
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("GET results status = %d, body = %s", resp.StatusCode, body)
	}
	var result map[string]any
	json.NewDecoder(resp.Body).Decode(&result)
	resp.Body.Close()
	if result["schemaVersion"] != float64(1) {
		t.Errorf("result schemaVersion = %v, want 1", result["schemaVersion"])
	}
}

func TestHTTP_InvalidInput(t *testing.T) {
	srv, _ := setupServer(t, instantRunner)
	defer srv.Close()

	resp, _ := http.Post(srv.URL+"/jobs", "application/json", strings.NewReader(`{"schemaVersion": 2}`))
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestHTTP_ConcurrencyReject(t *testing.T) {
	srv, _ := setupServer(t, slowRunner)
	defer srv.Close()

	// First job
	resp, _ := http.Post(srv.URL+"/jobs", "application/json", strings.NewReader(sampleInputJSON(t)))
	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("first POST status = %d, body = %s", resp.StatusCode, body)
	}
	resp.Body.Close()

	time.Sleep(50 * time.Millisecond)

	// Second job should get 409
	resp, _ = http.Post(srv.URL+"/jobs", "application/json", strings.NewReader(sampleInputJSON(t)))
	if resp.StatusCode != http.StatusConflict {
		t.Errorf("expected 409, got %d", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestHTTP_DeleteJob(t *testing.T) {
	srv, _ := setupServer(t, slowRunner)
	defer srv.Close()

	// Create a job
	resp, _ := http.Post(srv.URL+"/jobs", "application/json", strings.NewReader(sampleInputJSON(t)))
	var created map[string]string
	json.NewDecoder(resp.Body).Decode(&created)
	resp.Body.Close()
	id := created["id"]

	time.Sleep(50 * time.Millisecond)

	// DELETE /jobs/{id}
	req, _ := http.NewRequest("DELETE", srv.URL+"/jobs/"+id, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusNoContent {
		t.Errorf("DELETE status = %d, want 204", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestHTTP_NotFound(t *testing.T) {
	srv, _ := setupServer(t, instantRunner)
	defer srv.Close()

	resp, _ := http.Get(srv.URL + "/jobs/nonexistent")
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected 404, got %d", resp.StatusCode)
	}
	resp.Body.Close()
}
