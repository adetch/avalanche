package jobs

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/adetchells/avalanche-path-estimator/internal/schema"
	"github.com/google/uuid"
)

type Status string

const (
	StatusQueued   Status = "queued"
	StatusRunning  Status = "running"
	StatusComplete Status = "complete"
	StatusFailed   Status = "failed"
)

type Job struct {
	ID        string `json:"id"`
	Status    Status `json:"status"`
	Error     string `json:"error,omitempty"`
	WorkDir   string `json:"-"`
	cancel    context.CancelFunc
	resultFetched bool
}

// RunFunc is called to execute a job. It receives the job workspace directory
// and should write result.json into the outputs/ subdirectory when done.
// It is expected to run synchronously and return an error if the job fails.
type RunFunc func(ctx context.Context, workDir string, input *schema.Input) error

// Manager handles job lifecycle with single-job concurrency.
type Manager struct {
	mu       sync.Mutex
	jobs     map[string]*Job
	baseDir  string
	runFunc  RunFunc
}

func NewManager(baseDir string, runFunc RunFunc) *Manager {
	return &Manager{
		jobs:    make(map[string]*Job),
		baseDir: baseDir,
		runFunc: runFunc,
	}
}

// Submit creates a new job if none is currently running.
// Returns the job ID or an error if busy.
func (m *Manager) Submit(input *schema.Input, rawJSON []byte) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Check single-job concurrency
	for _, j := range m.jobs {
		if j.Status == StatusQueued || j.Status == StatusRunning {
			return "", ErrBusy
		}
	}

	id := uuid.New().String()
	workDir := filepath.Join(m.baseDir, id)

	// Create workspace directories
	for _, sub := range []string{"case", "outputs"} {
		if err := os.MkdirAll(filepath.Join(workDir, sub), 0o755); err != nil {
			return "", fmt.Errorf("create workspace: %w", err)
		}
	}

	// Write input.json
	if err := os.WriteFile(filepath.Join(workDir, "input.json"), rawJSON, 0o644); err != nil {
		os.RemoveAll(workDir)
		return "", fmt.Errorf("write input.json: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	job := &Job{
		ID:     id,
		Status: StatusQueued,
		WorkDir: workDir,
		cancel: cancel,
	}
	m.jobs[id] = job

	// Run the job asynchronously
	go m.run(ctx, job, input)

	return id, nil
}

func (m *Manager) run(ctx context.Context, job *Job, input *schema.Input) {
	m.mu.Lock()
	job.Status = StatusRunning
	m.mu.Unlock()

	err := m.runFunc(ctx, job.WorkDir, input)

	m.mu.Lock()
	defer m.mu.Unlock()

	if ctx.Err() != nil {
		// Job was cancelled — cleanup happens in Cancel()
		return
	}

	if err != nil {
		job.Status = StatusFailed
		job.Error = err.Error()
	} else {
		job.Status = StatusComplete
	}
}

// Get returns a job by ID.
func (m *Manager) Get(id string) (*Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	job, ok := m.jobs[id]
	if !ok {
		return nil, ErrNotFound
	}
	return job, nil
}

// Results returns the result.json contents for a completed job.
// After retrieval, the job workspace is cleaned up.
func (m *Manager) Results(id string) (json.RawMessage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	job, ok := m.jobs[id]
	if !ok {
		return nil, ErrNotFound
	}
	if job.Status != StatusComplete {
		return nil, ErrNotComplete
	}

	resultPath := filepath.Join(job.WorkDir, "outputs", "result.json")
	data, err := os.ReadFile(resultPath)
	if err != nil {
		return nil, fmt.Errorf("read result.json: %w", err)
	}

	// Mark for cleanup
	job.resultFetched = true
	go m.cleanup(job)

	return json.RawMessage(data), nil
}

// Cancel cancels a running job and cleans up its workspace.
func (m *Manager) Cancel(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	job, ok := m.jobs[id]
	if !ok {
		return ErrNotFound
	}

	if job.cancel != nil {
		job.cancel()
	}
	job.Status = StatusFailed
	job.Error = "cancelled"

	go m.cleanup(job)

	return nil
}

func (m *Manager) cleanup(job *Job) {
	os.RemoveAll(job.WorkDir)
	m.mu.Lock()
	delete(m.jobs, job.ID)
	m.mu.Unlock()
}

// CleanupAll removes all job workspaces (e.g., on daemon restart).
func (m *Manager) CleanupAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, job := range m.jobs {
		if job.cancel != nil {
			job.cancel()
		}
		os.RemoveAll(job.WorkDir)
	}
	m.jobs = make(map[string]*Job)
}

var (
	ErrBusy      = fmt.Errorf("a job is already running")
	ErrNotFound  = fmt.Errorf("job not found")
	ErrNotComplete = fmt.Errorf("job not complete")
)
