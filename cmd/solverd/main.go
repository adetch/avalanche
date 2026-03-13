package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"

	"github.com/adetchells/avalanche-path-estimator/internal/jobs"
	"github.com/adetchells/avalanche-path-estimator/internal/runner"
	"github.com/adetchells/avalanche-path-estimator/internal/schema"
)

const listenAddr = "127.0.0.1:8090"

func main() {
	workDir := filepath.Join(os.TempDir(), "solverd-jobs")
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		log.Fatalf("create work dir: %v", err)
	}

	cfg := runner.Config{
		ProjectRoot: resolveProjectRoot(),
		Image:       envOrDefault("SOLVERD_IMAGE", "opencfd/openfoam-dev:2312"),
		NProcs:      envIntOrDefault("SOLVERD_NPROCS", 1),
		TimeoutSec:  envIntOrDefault("SOLVERD_TIMEOUT", 300),
	}

	mgr := jobs.NewManager(workDir, runner.New(cfg))

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

// resolveProjectRoot finds the repository root by checking SOLVERD_PROJECT_ROOT
// or walking up from the working directory looking for solver/scripts/.
func resolveProjectRoot() string {
	if root := os.Getenv("SOLVERD_PROJECT_ROOT"); root != "" {
		return root
	}
	dir, _ := os.Getwd()
	for {
		if _, err := os.Stat(filepath.Join(dir, "solver", "scripts", "generate_case.py")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	log.Fatal("cannot find project root; set SOLVERD_PROJECT_ROOT")
	return ""
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envIntOrDefault(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
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
