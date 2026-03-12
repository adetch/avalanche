#!/usr/bin/env bash
set -e

# Ralph Loop — OpenFOAM Solver Build
# Iterates Claude Code over the PRD until all stories pass.

TOOL="claude"
MAX_ITERATIONS=10
RALPH_DIR="$(cd "$(dirname "$0")" && pwd)"
PROMPT_FILE="$RALPH_DIR/prompt.md"
PRD_FILE="$RALPH_DIR/prd.json"
PROGRESS_FILE="$RALPH_DIR/progress.txt"

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tool)
      TOOL="$2"
      shift 2
      ;;
    *)
      MAX_ITERATIONS="$1"
      shift
      ;;
  esac
done

if [[ ! "$TOOL" =~ ^(claude|amp)$ ]]; then
  echo "Error: --tool must be 'claude' or 'amp'"
  exit 1
fi

# Ensure progress file exists
touch "$PROGRESS_FILE"

echo "=== Ralph Loop: OpenFOAM Solver ==="
echo "Tool: $TOOL"
echo "Max iterations: $MAX_ITERATIONS"
echo "PRD: $PRD_FILE"
echo ""

for i in $(seq 1 "$MAX_ITERATIONS"); do
  echo "--- Iteration $i / $MAX_ITERATIONS ---"

  if [[ "$TOOL" == "claude" ]]; then
    OUTPUT=$(claude -p "$PROMPT_FILE" --allowedTools "Edit,Write,Read,Glob,Grep,Bash" 2>&1)
  else
    OUTPUT=$(amp -p "$PROMPT_FILE" 2>&1)
  fi

  echo "$OUTPUT"

  # Check for completion signal
  if echo "$OUTPUT" | grep -q "<promise>COMPLETE</promise>"; then
    echo ""
    echo "=== ALL STORIES COMPLETE ==="
    exit 0
  fi

  echo ""
done

echo "=== Max iterations reached ($MAX_ITERATIONS) ==="
echo "Check ralph/prd.json for remaining stories."
exit 1
