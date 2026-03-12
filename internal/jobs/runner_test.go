package jobs

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// mockDocker implements DockerAPI for unit tests.
type mockDocker struct {
	createFn func(ctx context.Context, image string, cmd []string, binds []string) (string, error)
	startFn  func(ctx context.Context, containerID string) error
	waitFn   func(ctx context.Context, containerID string) (int64, error)
	logsFn   func(ctx context.Context, containerID string, stdout, stderr io.Writer) error
	removeFn func(ctx context.Context, containerID string) error

	createdImage string
	createdCmd   []string
	createdBinds []string
	started      string
	waited       string
	removed      string
}

func (m *mockDocker) Create(ctx context.Context, image string, cmd []string, binds []string) (string, error) {
	m.createdImage = image
	m.createdCmd = cmd
	m.createdBinds = binds
	if m.createFn != nil {
		return m.createFn(ctx, image, cmd, binds)
	}
	return "ctr-abc123", nil
}

func (m *mockDocker) Start(ctx context.Context, containerID string) error {
	m.started = containerID
	if m.startFn != nil {
		return m.startFn(ctx, containerID)
	}
	return nil
}

func (m *mockDocker) Wait(ctx context.Context, containerID string) (int64, error) {
	m.waited = containerID
	if m.waitFn != nil {
		return m.waitFn(ctx, containerID)
	}
	return 0, nil
}

func (m *mockDocker) Logs(ctx context.Context, containerID string, stdout, stderr io.Writer) error {
	if m.logsFn != nil {
		return m.logsFn(ctx, containerID, stdout, stderr)
	}
	stdout.Write([]byte("solver output\n"))
	stderr.Write([]byte("solver warnings\n"))
	return nil
}

func (m *mockDocker) Remove(ctx context.Context, containerID string) error {
	m.removed = containerID
	if m.removeFn != nil {
		return m.removeFn(ctx, containerID)
	}
	return nil
}

func TestRunSuccess(t *testing.T) {
	mock := &mockDocker{}
	runner := NewRunner(mock, "avalanche-solver:latest", 2)

	result, err := runner.Run(context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.ExitCode != 0 {
		t.Errorf("exit code = %d, want 0", result.ExitCode)
	}
	if result.Error != "" {
		t.Errorf("error = %q, want empty", result.Error)
	}

	// Correct image.
	if mock.createdImage != "avalanche-solver:latest" {
		t.Errorf("image = %q, want %q", mock.createdImage, "avalanche-solver:latest")
	}
	// Correct MPI command.
	want := []string{"mpirun", "-np", "2", "avalancheSolver", "-case", "/case"}
	if len(mock.createdCmd) != len(want) {
		t.Fatalf("cmd = %v, want %v", mock.createdCmd, want)
	}
	for i := range want {
		if mock.createdCmd[i] != want[i] {
			t.Errorf("cmd[%d] = %q, want %q", i, mock.createdCmd[i], want[i])
		}
	}
}

func TestRunBindMount(t *testing.T) {
	mock := &mockDocker{}
	runner := NewRunner(mock, "img", 1)
	jobDir := t.TempDir()

	runner.Run(context.Background(), jobDir)

	if len(mock.createdBinds) != 1 {
		t.Fatalf("binds count = %d, want 1", len(mock.createdBinds))
	}
	if !strings.HasSuffix(mock.createdBinds[0], ":/case") {
		t.Errorf("bind = %q, want suffix :/case", mock.createdBinds[0])
	}
}

func TestRunLogCapture(t *testing.T) {
	mock := &mockDocker{}
	runner := NewRunner(mock, "img", 1)
	jobDir := t.TempDir()

	runner.Run(context.Background(), jobDir)

	stdout, err := os.ReadFile(filepath.Join(jobDir, "logs", "stdout.log"))
	if err != nil {
		t.Fatalf("read stdout.log: %v", err)
	}
	if string(stdout) != "solver output\n" {
		t.Errorf("stdout = %q, want %q", string(stdout), "solver output\n")
	}

	stderr, err := os.ReadFile(filepath.Join(jobDir, "logs", "stderr.log"))
	if err != nil {
		t.Fatalf("read stderr.log: %v", err)
	}
	if string(stderr) != "solver warnings\n" {
		t.Errorf("stderr = %q, want %q", string(stderr), "solver warnings\n")
	}
}

func TestRunNonZeroExit(t *testing.T) {
	mock := &mockDocker{
		waitFn: func(ctx context.Context, containerID string) (int64, error) {
			return 1, nil
		},
		logsFn: func(ctx context.Context, containerID string, stdout, stderr io.Writer) error {
			stderr.Write([]byte("FATAL: mesh decomposition failed\n"))
			return nil
		},
	}
	runner := NewRunner(mock, "img", 1)

	result, err := runner.Run(context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.ExitCode != 1 {
		t.Errorf("exit code = %d, want 1", result.ExitCode)
	}
	if !strings.Contains(result.Error, "code 1") {
		t.Errorf("error = %q, want mention of exit code 1", result.Error)
	}
	// Container must still be removed.
	if mock.removed == "" {
		t.Error("container not removed after non-zero exit")
	}
}

func TestRunCreateFails(t *testing.T) {
	mock := &mockDocker{
		createFn: func(ctx context.Context, image string, cmd []string, binds []string) (string, error) {
			return "", errors.New("image not found")
		},
	}
	runner := NewRunner(mock, "bad:latest", 1)

	_, err := runner.Run(context.Background(), t.TempDir())
	if err == nil {
		t.Fatal("expected error when create fails")
	}
	if !strings.Contains(err.Error(), "create container") {
		t.Errorf("error = %q, want 'create container' prefix", err.Error())
	}
}

func TestRunStartFails(t *testing.T) {
	mock := &mockDocker{
		startFn: func(ctx context.Context, containerID string) error {
			return errors.New("cannot start")
		},
	}
	runner := NewRunner(mock, "img", 1)

	_, err := runner.Run(context.Background(), t.TempDir())
	if err == nil {
		t.Fatal("expected error when start fails")
	}
	if !strings.Contains(err.Error(), "start container") {
		t.Errorf("error = %q, want 'start container' prefix", err.Error())
	}
	// Container must be cleaned up even on start failure.
	if mock.removed == "" {
		t.Error("container not removed after start failure")
	}
}

func TestRunContextCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	mock := &mockDocker{
		waitFn: func(ctx context.Context, containerID string) (int64, error) {
			cancel()
			return -1, ctx.Err()
		},
	}
	runner := NewRunner(mock, "img", 1)

	_, err := runner.Run(ctx, t.TempDir())
	if err == nil {
		t.Fatal("expected error on context cancellation")
	}
	if mock.removed == "" {
		t.Error("container not removed after cancellation")
	}
}

func TestContainerAlwaysRemoved(t *testing.T) {
	mock := &mockDocker{}
	runner := NewRunner(mock, "img", 1)

	runner.Run(context.Background(), t.TempDir())

	if mock.removed != "ctr-abc123" {
		t.Errorf("removed = %q, want %q", mock.removed, "ctr-abc123")
	}
}

func TestNPRanksClamped(t *testing.T) {
	tests := []struct {
		input int
		want  string
	}{
		{0, "1"},
		{-1, "1"},
		{1, "1"},
		{3, "3"},
		{4, "4"},
		{5, "4"},
		{100, "4"},
	}
	for _, tt := range tests {
		mock := &mockDocker{}
		runner := NewRunner(mock, "img", tt.input)
		runner.Run(context.Background(), t.TempDir())
		if len(mock.createdCmd) >= 3 && mock.createdCmd[2] != tt.want {
			t.Errorf("npRanks=%d: -np = %q, want %q", tt.input, mock.createdCmd[2], tt.want)
		}
	}
}

func TestRunCreatesLogsDir(t *testing.T) {
	mock := &mockDocker{}
	runner := NewRunner(mock, "img", 1)
	jobDir := t.TempDir()

	runner.Run(context.Background(), jobDir)

	info, err := os.Stat(filepath.Join(jobDir, "logs"))
	if err != nil {
		t.Fatalf("logs dir not created: %v", err)
	}
	if !info.IsDir() {
		t.Error("logs is not a directory")
	}
}
