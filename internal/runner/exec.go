// Package runner implements the Docker-based OpenFOAM solver runner (US-006).
package runner

import (
	"context"
	"io"
	"os"
	"os/exec"
)

// CommandExecutor abstracts exec.Command for testability.
type CommandExecutor interface {
	Run(ctx context.Context, name string, args []string, dir string, env []string, stdout, stderr io.Writer) error
}

// OSExecutor runs commands via os/exec.
type OSExecutor struct{}

func (OSExecutor) Run(ctx context.Context, name string, args []string, dir string, env []string, stdout, stderr io.Writer) error {
	cmd := exec.CommandContext(ctx, name, args...)
	if dir != "" {
		cmd.Dir = dir
	}
	if len(env) > 0 {
		cmd.Env = append(os.Environ(), env...)
	}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	return cmd.Run()
}
