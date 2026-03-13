package runner

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/adetchells/avalanche-path-estimator/internal/convert"
	"github.com/adetchells/avalanche-path-estimator/internal/schema"
)

// Config holds runtime configuration for the Docker runner.
type Config struct {
	// ProjectRoot is the repository root, used to locate
	// solver/scripts/generate_case.py and solver/case-template/.
	ProjectRoot string

	// Image is the Docker image. Default: "opencfd/openfoam-dev:2312"
	Image string

	// NProcs is the number of MPI ranks (1-4). Default: 1
	NProcs int

	// TimeoutSec is the max wall-clock seconds for Docker run. Default: 300
	TimeoutSec int

	// SolverBinary is the OpenFOAM solver executable. Default: "faSavageHutterFoam"
	SolverBinary string

	// Exec is the command executor. Defaults to OSExecutor.
	Exec CommandExecutor
}

func applyDefaults(cfg *Config) {
	if cfg.Image == "" {
		cfg.Image = "avalanche-solver"
	}
	if cfg.NProcs < 1 {
		cfg.NProcs = 1
	}
	if cfg.TimeoutSec <= 0 {
		cfg.TimeoutSec = 300
	}
	if cfg.SolverBinary == "" {
		cfg.SolverBinary = "faSavageHutterFoam"
	}
	if cfg.Exec == nil {
		cfg.Exec = OSExecutor{}
	}
}

// New returns a RunFunc that executes the full solver pipeline:
// generate case → run Docker → convert output → write result.json.
func New(cfg Config) func(ctx context.Context, workDir string, input *schema.Input) error {
	applyDefaults(&cfg)
	return func(ctx context.Context, workDir string, input *schema.Input) error {
		return run(ctx, cfg, workDir, input)
	}
}

func run(ctx context.Context, cfg Config, workDir string, input *schema.Input) error {
	startTime := time.Now()

	scriptPath := filepath.Join(cfg.ProjectRoot, "solver", "scripts", "generate_case.py")
	templatePath := filepath.Join(cfg.ProjectRoot, "solver", "case-template")
	inputPath := filepath.Join(workDir, "input.json")
	caseDir := filepath.Join(workDir, "case")

	// Step 1: Generate OpenFOAM case from input JSON.
	var genOut, genErr bytes.Buffer
	err := cfg.Exec.Run(ctx, "python3", []string{
		scriptPath,
		inputPath,
		caseDir,
		"--template", templatePath,
		"--nprocs", strconv.Itoa(cfg.NProcs),
	}, workDir, nil, &genOut, &genErr)
	if err != nil {
		return fmt.Errorf("generate_case.py failed: %w\nstderr: %s", err, genErr.String())
	}

	// Step 2: Ensure input.json exists in case/ (generate_case.py copies it,
	// but verify since the converter depends on it).
	caseInputPath := filepath.Join(caseDir, "input.json")
	if _, statErr := os.Stat(caseInputPath); os.IsNotExist(statErr) {
		data, readErr := os.ReadFile(inputPath)
		if readErr != nil {
			return fmt.Errorf("reading input.json for copy: %w", readErr)
		}
		if writeErr := os.WriteFile(caseInputPath, data, 0o644); writeErr != nil {
			return fmt.Errorf("copying input.json to case: %w", writeErr)
		}
	}

	// Step 3: Run solver in Docker container.
	// The avalanche-solver image entrypoint handles the full pipeline:
	// slopeMesh/blockMesh → makeFaMesh → releaseAreaMapping → solver.
	containerName := fmt.Sprintf("solverd-%s", filepath.Base(workDir))

	dockerArgs := []string{
		"run", "--rm",
		"--name", containerName,
		"-v", caseDir + ":/case",
		"-e", fmt.Sprintf("NP=%d", cfg.NProcs),
	}
	dockerArgs = append(dockerArgs, cfg.Image)

	dockerCtx, dockerCancel := context.WithTimeout(ctx, time.Duration(cfg.TimeoutSec)*time.Second)
	defer dockerCancel()

	var dockerOut, dockerErr bytes.Buffer
	err = cfg.Exec.Run(dockerCtx, "docker", dockerArgs, workDir, nil, &dockerOut, &dockerErr)
	if err != nil {
		if ctx.Err() != nil {
			stopContainer(cfg.Exec, containerName)
			return fmt.Errorf("job cancelled: %w", ctx.Err())
		}
		if dockerCtx.Err() != nil {
			stopContainer(cfg.Exec, containerName)
			return fmt.Errorf("solver timed out after %ds", cfg.TimeoutSec)
		}
		return fmt.Errorf("solver failed: %w\nstderr: %s", err, dockerErr.String())
	}

	// Step 4: Convert OpenFOAM output to result JSON.
	wallClock := time.Since(startTime).Seconds()
	result, err := convert.ConvertOutput(caseDir, input.SnowProfile.Density, wallClock)
	if err != nil {
		return fmt.Errorf("output conversion failed: %w", err)
	}

	// Step 5: Write result.json.
	resultPath := filepath.Join(workDir, "outputs", "result.json")
	if err := convert.WriteResultJSON(result, resultPath); err != nil {
		return fmt.Errorf("write result: %w", err)
	}

	return nil
}

// stopContainer attempts to stop a Docker container by name.
func stopContainer(exec CommandExecutor, name string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	exec.Run(ctx, "docker", []string{"stop", name}, "", nil, io.Discard, io.Discard)
}
