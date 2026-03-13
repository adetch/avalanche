package runner

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/adetchells/avalanche-path-estimator/internal/schema"
)

// fakeCall records a single command invocation.
type fakeCall struct {
	Name string
	Args []string
	Dir  string
}

// fakeExecutor records commands and dispatches to handlers keyed by command name.
type fakeExecutor struct {
	mu       sync.Mutex
	calls    []fakeCall
	handlers map[string]func(ctx context.Context, args []string, dir string, stdout, stderr io.Writer) error
}

func newFakeExecutor() *fakeExecutor {
	return &fakeExecutor{
		handlers: make(map[string]func(ctx context.Context, args []string, dir string, stdout, stderr io.Writer) error),
	}
}

func (f *fakeExecutor) Run(ctx context.Context, name string, args []string, dir string, env []string, stdout, stderr io.Writer) error {
	f.mu.Lock()
	f.calls = append(f.calls, fakeCall{Name: name, Args: args, Dir: dir})
	handler, ok := f.handlers[name]
	f.mu.Unlock()

	if !ok {
		return fmt.Errorf("unexpected command: %s", name)
	}
	return handler(ctx, args, dir, stdout, stderr)
}

func (f *fakeExecutor) getCalls() []fakeCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]fakeCall, len(f.calls))
	copy(out, f.calls)
	return out
}

func testInput() *schema.Input {
	return &schema.Input{
		SchemaVersion: 1,
		DEM: schema.DEM{
			Origin:   [2]float64{-116.84, 51.04},
			CellSize: 15,
			Rows:     3,
			Cols:     3,
			Elevation: []any{
				float64(2000), float64(2010), float64(2020),
				float64(2030), float64(2040), float64(2050),
				float64(2060), float64(2070), float64(2080),
			},
		},
		ReleaseCells: [][2]int{{0, 0}},
		SnowDepthM:   1.5,
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
			Profile: []schema.ElevationPoint{
				{LngLat: [2]float64{-116.84, 51.04}, Elevation: 2080},
			},
		},
	}
}

// setupWorkDir creates the standard job workspace layout and writes input.json.
func setupWorkDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, sub := range []string{"case", "outputs"} {
		os.MkdirAll(filepath.Join(dir, sub), 0o755)
	}
	data, _ := json.Marshal(testInput())
	os.WriteFile(filepath.Join(dir, "input.json"), data, 0o644)
	return dir
}

// writeFakeOpenFOAMOutput creates a minimal OpenFOAM case with time directory,
// input.json, h, and Us fields so the converter succeeds.
func writeFakeOpenFOAMOutput(t *testing.T, caseDir string) {
	t.Helper()

	// Write input.json for grid spec
	inputData, _ := json.Marshal(testInput())
	os.WriteFile(filepath.Join(caseDir, "input.json"), inputData, 0o644)

	// Create initial conditions (time 0)
	zeroDir := filepath.Join(caseDir, "0")
	os.MkdirAll(zeroDir, 0o755)
	writeScalarField(t, filepath.Join(zeroDir, "h"), 9, []float64{1.5, 0, 0, 0, 0, 0, 0, 0, 0})
	writeVectorField(t, filepath.Join(zeroDir, "Us"), 9)

	// Create final time directory
	timeDir := filepath.Join(caseDir, "30")
	os.MkdirAll(timeDir, 0o755)
	writeScalarField(t, filepath.Join(timeDir, "h"), 9, []float64{0, 0.3, 0.2, 0.1, 0.5, 0.2, 0, 0.1, 0.1})
	writeVectorField(t, filepath.Join(timeDir, "Us"), 9)
}

func writeScalarField(t *testing.T, path string, n int, values []float64) {
	t.Helper()
	var b strings.Builder
	fmt.Fprintf(&b, "FoamFile\n{\n    version 2.0;\n    format ascii;\n    class areaScalarField;\n    object h;\n}\n\n")
	fmt.Fprintf(&b, "dimensions      [0 1 0 0 0 0 0];\n\n")
	fmt.Fprintf(&b, "internalField   nonuniform List<scalar>\n%d\n(\n", n)
	for _, v := range values {
		fmt.Fprintf(&b, "%g\n", v)
	}
	fmt.Fprintf(&b, ")\n;\n")
	os.WriteFile(path, []byte(b.String()), 0o644)
}

func writeVectorField(t *testing.T, path string, n int) {
	t.Helper()
	var b strings.Builder
	fmt.Fprintf(&b, "FoamFile\n{\n    version 2.0;\n    format ascii;\n    class areaVectorField;\n    object Us;\n}\n\n")
	fmt.Fprintf(&b, "dimensions      [0 1 -1 0 0 0 0];\n\n")
	fmt.Fprintf(&b, "internalField   uniform (0 0 0);\n")
	os.WriteFile(path, []byte(b.String()), 0o644)
}

func TestHappyPath(t *testing.T) {
	workDir := setupWorkDir(t)
	exec := newFakeExecutor()

	// python3 handler: simulate generate_case.py by writing fake output
	exec.handlers["python3"] = func(_ context.Context, args []string, _ string, _, _ io.Writer) error {
		// args: [scriptPath, inputPath, caseDir, --template, templatePath, --nprocs, N]
		caseDir := args[2]
		writeFakeOpenFOAMOutput(t, caseDir)
		return nil
	}

	// docker handler: no-op (solver "already ran" — output written by python3 handler)
	exec.handlers["docker"] = func(_ context.Context, _ []string, _ string, _, _ io.Writer) error {
		return nil
	}

	cfg := Config{
		ProjectRoot: "/fake/project",
		Exec:        exec,
		TimeoutSec:  10,
	}

	err := New(cfg)(context.Background(), workDir, testInput())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify result.json was written
	resultPath := filepath.Join(workDir, "outputs", "result.json")
	data, err := os.ReadFile(resultPath)
	if err != nil {
		t.Fatalf("reading result.json: %v", err)
	}

	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("parsing result.json: %v", err)
	}
	if result["schemaVersion"] != float64(1) {
		t.Errorf("schemaVersion = %v, want 1", result["schemaVersion"])
	}
	if result["rows"] != float64(3) {
		t.Errorf("rows = %v, want 3", result["rows"])
	}

	// Verify both commands were called
	calls := exec.getCalls()
	if len(calls) != 2 {
		t.Fatalf("expected 2 calls, got %d", len(calls))
	}
	if calls[0].Name != "python3" {
		t.Errorf("first call = %s, want python3", calls[0].Name)
	}
	if calls[1].Name != "docker" {
		t.Errorf("second call = %s, want docker", calls[1].Name)
	}
}

func TestGenerateCaseFails(t *testing.T) {
	workDir := setupWorkDir(t)
	exec := newFakeExecutor()

	exec.handlers["python3"] = func(_ context.Context, _ []string, _ string, _, stderr io.Writer) error {
		stderr.Write([]byte("ValueError: invalid DEM"))
		return fmt.Errorf("exit status 1")
	}

	cfg := Config{
		ProjectRoot: "/fake/project",
		Exec:        exec,
		TimeoutSec:  10,
	}

	err := New(cfg)(context.Background(), workDir, testInput())
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "generate_case.py failed") {
		t.Errorf("error = %q, want to contain 'generate_case.py failed'", err.Error())
	}
	if !strings.Contains(err.Error(), "invalid DEM") {
		t.Errorf("error = %q, want to contain stderr 'invalid DEM'", err.Error())
	}
}

func TestDockerFails(t *testing.T) {
	workDir := setupWorkDir(t)
	exec := newFakeExecutor()

	exec.handlers["python3"] = func(_ context.Context, args []string, _ string, _, _ io.Writer) error {
		writeFakeOpenFOAMOutput(t, args[2])
		return nil
	}
	exec.handlers["docker"] = func(_ context.Context, _ []string, _ string, _, stderr io.Writer) error {
		stderr.Write([]byte("FOAM FATAL ERROR"))
		return fmt.Errorf("exit status 1")
	}

	cfg := Config{
		ProjectRoot: "/fake/project",
		Exec:        exec,
		TimeoutSec:  10,
	}

	err := New(cfg)(context.Background(), workDir, testInput())
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "solver failed") {
		t.Errorf("error = %q, want to contain 'solver failed'", err.Error())
	}
	if !strings.Contains(err.Error(), "FOAM FATAL ERROR") {
		t.Errorf("error = %q, want to contain stderr", err.Error())
	}
}

func TestContextCancellation(t *testing.T) {
	workDir := setupWorkDir(t)
	exec := newFakeExecutor()

	exec.handlers["python3"] = func(_ context.Context, args []string, _ string, _, _ io.Writer) error {
		writeFakeOpenFOAMOutput(t, args[2])
		return nil
	}

	// Docker "run" blocks until context is cancelled; "stop" returns immediately.
	exec.handlers["docker"] = func(ctx context.Context, args []string, _ string, _, _ io.Writer) error {
		if len(args) > 0 && args[0] == "stop" {
			return nil
		}
		<-ctx.Done()
		return ctx.Err()
	}

	cfg := Config{
		ProjectRoot: "/fake/project",
		Exec:        exec,
		TimeoutSec:  30,
	}

	ctx, cancel := context.WithCancel(context.Background())

	errCh := make(chan error, 1)
	go func() {
		errCh <- New(cfg)(ctx, workDir, testInput())
	}()

	// Give it time to start the docker command
	time.Sleep(100 * time.Millisecond)
	cancel()

	err := <-errCh
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "cancelled") {
		t.Errorf("error = %q, want to contain 'cancelled'", err.Error())
	}

	// Verify docker stop was called
	calls := exec.getCalls()
	var stopCalled bool
	for _, c := range calls {
		if c.Name == "docker" && len(c.Args) > 0 && c.Args[0] == "stop" {
			stopCalled = true
			break
		}
	}
	if !stopCalled {
		t.Error("expected docker stop to be called on cancellation")
	}
}

func TestNProcsOne(t *testing.T) {
	workDir := setupWorkDir(t)
	exec := newFakeExecutor()

	exec.handlers["python3"] = func(_ context.Context, args []string, _ string, _, _ io.Writer) error {
		writeFakeOpenFOAMOutput(t, args[2])
		return nil
	}

	var capturedDockerArgs []string
	exec.handlers["docker"] = func(_ context.Context, args []string, _ string, _, _ io.Writer) error {
		capturedDockerArgs = args
		return nil
	}

	cfg := Config{
		ProjectRoot: "/fake/project",
		NProcs:      1,
		Exec:        exec,
		TimeoutSec:  10,
	}

	err := New(cfg)(context.Background(), workDir, testInput())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// The bash -c command should NOT contain mpirun
	bashCmd := capturedDockerArgs[len(capturedDockerArgs)-1]
	if strings.Contains(bashCmd, "mpirun") {
		t.Errorf("NProcs=1 should not use mpirun, got: %s", bashCmd)
	}
	if !strings.Contains(bashCmd, "faSavageHutterFoam") {
		t.Errorf("command should contain solver binary, got: %s", bashCmd)
	}
}

func TestNProcsMulti(t *testing.T) {
	workDir := setupWorkDir(t)
	exec := newFakeExecutor()

	exec.handlers["python3"] = func(_ context.Context, args []string, _ string, _, _ io.Writer) error {
		writeFakeOpenFOAMOutput(t, args[2])
		return nil
	}

	var capturedDockerArgs []string
	exec.handlers["docker"] = func(_ context.Context, args []string, _ string, _, _ io.Writer) error {
		capturedDockerArgs = args
		return nil
	}

	cfg := Config{
		ProjectRoot: "/fake/project",
		NProcs:      4,
		Exec:        exec,
		TimeoutSec:  10,
	}

	err := New(cfg)(context.Background(), workDir, testInput())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	bashCmd := capturedDockerArgs[len(capturedDockerArgs)-1]
	if !strings.Contains(bashCmd, "mpirun -np 4") {
		t.Errorf("NProcs=4 should use mpirun, got: %s", bashCmd)
	}
	if !strings.Contains(bashCmd, "-parallel") {
		t.Errorf("NProcs>1 should use -parallel flag, got: %s", bashCmd)
	}
	if !strings.Contains(bashCmd, "decomposePar") {
		t.Errorf("NProcs>1 should run decomposePar, got: %s", bashCmd)
	}
	if !strings.Contains(bashCmd, "reconstructPar") {
		t.Errorf("NProcs>1 should run reconstructPar, got: %s", bashCmd)
	}
}

func TestConfigDefaults(t *testing.T) {
	cfg := Config{}
	applyDefaults(&cfg)

	if cfg.Image != "opencfd/openfoam-dev:2312" {
		t.Errorf("Image = %q, want opencfd/openfoam-dev:2312", cfg.Image)
	}
	if cfg.NProcs != 1 {
		t.Errorf("NProcs = %d, want 1", cfg.NProcs)
	}
	if cfg.TimeoutSec != 300 {
		t.Errorf("TimeoutSec = %d, want 300", cfg.TimeoutSec)
	}
	if cfg.SolverBinary != "faSavageHutterFoam" {
		t.Errorf("SolverBinary = %q, want faSavageHutterFoam", cfg.SolverBinary)
	}
	if cfg.Exec == nil {
		t.Error("Exec should default to OSExecutor")
	}
}

func TestDockerContainerName(t *testing.T) {
	workDir := setupWorkDir(t)
	exec := newFakeExecutor()

	exec.handlers["python3"] = func(_ context.Context, args []string, _ string, _, _ io.Writer) error {
		writeFakeOpenFOAMOutput(t, args[2])
		return nil
	}

	var capturedDockerArgs []string
	exec.handlers["docker"] = func(_ context.Context, args []string, _ string, _, _ io.Writer) error {
		capturedDockerArgs = args
		return nil
	}

	cfg := Config{
		ProjectRoot: "/fake/project",
		Exec:        exec,
		TimeoutSec:  10,
	}

	New(cfg)(context.Background(), workDir, testInput())

	// Find --name arg
	for i, arg := range capturedDockerArgs {
		if arg == "--name" && i+1 < len(capturedDockerArgs) {
			name := capturedDockerArgs[i+1]
			if !strings.HasPrefix(name, "solverd-") {
				t.Errorf("container name = %q, want prefix 'solverd-'", name)
			}
			return
		}
	}
	t.Error("--name flag not found in docker args")
}

func TestDockerVolumeMount(t *testing.T) {
	workDir := setupWorkDir(t)
	exec := newFakeExecutor()

	exec.handlers["python3"] = func(_ context.Context, args []string, _ string, _, _ io.Writer) error {
		writeFakeOpenFOAMOutput(t, args[2])
		return nil
	}

	var capturedDockerArgs []string
	exec.handlers["docker"] = func(_ context.Context, args []string, _ string, _, _ io.Writer) error {
		capturedDockerArgs = args
		return nil
	}

	cfg := Config{
		ProjectRoot: "/fake/project",
		Exec:        exec,
		TimeoutSec:  10,
	}

	New(cfg)(context.Background(), workDir, testInput())

	// Find -v arg
	caseDir := filepath.Join(workDir, "case")
	expectedMount := caseDir + ":/case"
	for i, arg := range capturedDockerArgs {
		if arg == "-v" && i+1 < len(capturedDockerArgs) {
			if capturedDockerArgs[i+1] != expectedMount {
				t.Errorf("volume mount = %q, want %q", capturedDockerArgs[i+1], expectedMount)
			}
			return
		}
	}
	t.Error("-v flag not found in docker args")
}
