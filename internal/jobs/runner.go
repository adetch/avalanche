// Package jobs manages solver job execution via Docker containers.
package jobs

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
)

// DockerAPI abstracts Docker container operations for testing.
type DockerAPI interface {
	Create(ctx context.Context, image string, cmd []string, binds []string) (containerID string, err error)
	Start(ctx context.Context, containerID string) error
	Wait(ctx context.Context, containerID string) (exitCode int64, err error)
	Logs(ctx context.Context, containerID string, stdout, stderr io.Writer) error
	Remove(ctx context.Context, containerID string) error
}

// RunResult contains the outcome of a solver run.
type RunResult struct {
	ExitCode int
	Error    string // non-empty when the solver exited with a non-zero code
}

// Runner launches the solver Docker container for a job.
type Runner struct {
	docker  DockerAPI
	image   string
	npRanks int
}

// NewRunner creates a Runner. npRanks is clamped to [1, 4] per DECISIONS.md.
func NewRunner(docker DockerAPI, image string, npRanks int) *Runner {
	if npRanks < 1 {
		npRanks = 1
	}
	if npRanks > 4 {
		npRanks = 4
	}
	return &Runner{docker: docker, image: image, npRanks: npRanks}
}

// Run executes the solver container with jobDir mounted as /case.
// Stdout and stderr are captured to jobDir/logs/stdout.log and stderr.log.
// The container is always removed after the run completes.
func (r *Runner) Run(ctx context.Context, jobDir string) (*RunResult, error) {
	absDir, err := filepath.Abs(jobDir)
	if err != nil {
		return nil, fmt.Errorf("resolve job dir: %w", err)
	}

	logsDir := filepath.Join(absDir, "logs")
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		return nil, fmt.Errorf("create logs dir: %w", err)
	}

	cmd := []string{
		"mpirun", "-np", strconv.Itoa(r.npRanks),
		"avalancheSolver", "-case", "/case",
	}

	containerID, err := r.docker.Create(ctx, r.image, cmd, []string{absDir + ":/case"})
	if err != nil {
		return nil, fmt.Errorf("create container: %w", err)
	}
	defer r.docker.Remove(context.Background(), containerID)

	if err := r.docker.Start(ctx, containerID); err != nil {
		return nil, fmt.Errorf("start container: %w", err)
	}

	exitCode, err := r.docker.Wait(ctx, containerID)
	if err != nil {
		return nil, fmt.Errorf("wait for container: %w", err)
	}

	if logErr := r.captureLogs(ctx, containerID, logsDir); logErr != nil {
		fmt.Fprintf(os.Stderr, "warning: log capture failed: %v\n", logErr)
	}

	result := &RunResult{ExitCode: int(exitCode)}
	if exitCode != 0 {
		result.Error = fmt.Sprintf("solver exited with code %d", exitCode)
	}
	return result, nil
}

func (r *Runner) captureLogs(ctx context.Context, containerID, logsDir string) error {
	stdoutFile, err := os.Create(filepath.Join(logsDir, "stdout.log"))
	if err != nil {
		return fmt.Errorf("create stdout.log: %w", err)
	}
	defer stdoutFile.Close()

	stderrFile, err := os.Create(filepath.Join(logsDir, "stderr.log"))
	if err != nil {
		return fmt.Errorf("create stderr.log: %w", err)
	}
	defer stderrFile.Close()

	return r.docker.Logs(ctx, containerID, stdoutFile, stderrFile)
}

// --- Docker SDK implementation ---

// dockerClient implements DockerAPI using the Docker Engine SDK.
type dockerClient struct {
	cli *client.Client
}

// NewDockerClient creates a DockerAPI backed by the local Docker daemon.
func NewDockerClient() (DockerAPI, error) {
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		return nil, fmt.Errorf("create docker client: %w", err)
	}
	return &dockerClient{cli: cli}, nil
}

func (d *dockerClient) Create(ctx context.Context, image string, cmd []string, binds []string) (string, error) {
	resp, err := d.cli.ContainerCreate(ctx,
		&container.Config{
			Image: image,
			Cmd:   cmd,
		},
		&container.HostConfig{
			Binds: binds,
		},
		nil, nil, "")
	if err != nil {
		return "", err
	}
	return resp.ID, nil
}

func (d *dockerClient) Start(ctx context.Context, containerID string) error {
	return d.cli.ContainerStart(ctx, containerID, container.StartOptions{})
}

func (d *dockerClient) Wait(ctx context.Context, containerID string) (int64, error) {
	waitCh, errCh := d.cli.ContainerWait(ctx, containerID, container.WaitConditionNotRunning)
	select {
	case resp := <-waitCh:
		if resp.Error != nil {
			return resp.StatusCode, fmt.Errorf("%s", resp.Error.Message)
		}
		return resp.StatusCode, nil
	case err := <-errCh:
		return -1, err
	}
}

func (d *dockerClient) Logs(ctx context.Context, containerID string, stdout, stderr io.Writer) error {
	reader, err := d.cli.ContainerLogs(ctx, containerID, container.LogsOptions{
		ShowStdout: true,
		ShowStderr: true,
	})
	if err != nil {
		return err
	}
	defer reader.Close()
	_, err = stdcopy.StdCopy(stdout, stderr, reader)
	return err
}

func (d *dockerClient) Remove(ctx context.Context, containerID string) error {
	return d.cli.ContainerRemove(ctx, containerID, container.RemoveOptions{Force: true})
}
