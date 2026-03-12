package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/adetchells/avalanche-path-estimator/internal/jobs"
	"github.com/adetchells/avalanche-path-estimator/internal/schema"
)

const listenAddr = "127.0.0.1:8090"

func main() {
	workDir := filepath.Join(os.TempDir(), "solverd-jobs")
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		log.Fatalf("create work dir: %v", err)
	}

	mgr := jobs.NewManager(workDir, stubRunner)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /jobs", postJobHandler(mgr))
	mux.HandleFunc("GET /jobs/{id}", getJobHandler(mgr))
	mux.HandleFunc("GET /jobs/{id}/results", getResultsHandler(mgr))
	mux.HandleFunc("DELETE /jobs/{id}", deleteJobHandler(mgr))

	srv := &http.Server{
		Addr:    listenAddr,
		Handler: mux,
	}

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Println("shutting down...")
		mgr.CleanupAll()
		srv.Close()
	}()

	log.Printf("solverd listening on %s", listenAddr)
	if err := srv.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatalf("listen: %v", err)
	}
}

// stubRunner is a placeholder that immediately marks the job as complete.
// US-006 will replace this with the Docker runner.
func stubRunner(ctx context.Context, workDir string, input *schema.Input) error {
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
	data, err := json.Marshal(result)
	if err != nil {
		return fmt.Errorf("marshal result: %w", err)
	}
	return os.WriteFile(filepath.Join(workDir, "outputs", "result.json"), data, 0o644)
}

func postJobHandler(mgr *jobs.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, 10<<20)) // 10 MB limit
		if err != nil {
			writeError(w, http.StatusBadRequest, "read body: "+err.Error())
			return
		}

		input, err := schema.ParseInput(body)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := schema.ValidateInput(input); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}

		id, err := mgr.Submit(input, body)
		if err != nil {
			if err == jobs.ErrBusy {
				writeError(w, http.StatusConflict, err.Error())
				return
			}
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]string{"id": id})
	}
}

func getJobHandler(mgr *jobs.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		job, err := mgr.Get(id)
		if err != nil {
			if err == jobs.ErrNotFound {
				writeError(w, http.StatusNotFound, err.Error())
				return
			}
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"id":     job.ID,
			"status": job.Status,
			"error":  job.Error,
		})
	}
}

func getResultsHandler(mgr *jobs.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		data, err := mgr.Results(id)
		if err != nil {
			switch err {
			case jobs.ErrNotFound:
				writeError(w, http.StatusNotFound, err.Error())
			case jobs.ErrNotComplete:
				writeError(w, http.StatusConflict, err.Error())
			default:
				writeError(w, http.StatusInternalServerError, err.Error())
			}
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.Write(data)
	}
}

func deleteJobHandler(mgr *jobs.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if err := mgr.Cancel(id); err != nil {
			if err == jobs.ErrNotFound {
				writeError(w, http.StatusNotFound, err.Error())
				return
			}
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func writeError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
