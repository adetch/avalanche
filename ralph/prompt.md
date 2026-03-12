# Ralph Agent Instructions — OpenFOAM Solver

You are an autonomous coding agent building a local OpenFOAM-based avalanche solver integration for the avalanche-path-estimator app.

## Context

- **Frontend**: Next.js + MapLibre GL, Zustand store, TypeScript
- **Existing solver**: Voellmy-2D in `src/lib/avalanche/voellmy-2d.ts` — depth-averaged shallow water solver running in-browser
- **New work**: Go backend service + Docker-containerized OpenFOAM solver, wired into the existing UI
- **Key types**: `FlowPyGridResult` in `src/types/index.ts` — the output shape the overlay expects

## Critical Constraints

- Localhost only — service binds to `127.0.0.1:8090`
- Single job at a time — reject if busy
- Cleanup job workspace after completion
- All input/output must carry `schemaVersion: 1`

## Your Task

1. Read the PRD at `ralph/prd.json`
2. Read the progress log at `ralph/progress.txt` (check Codebase Patterns section first)
3. Check you're on the correct branch from PRD `branchName`. If not, check it out or create from main.
4. Pick the **highest priority** user story where `passes: false`
5. Implement that single user story
6. Run quality checks:
   - Go code: `go vet ./...`, `go test ./...`
   - TypeScript: `npx tsc --noEmit`, `npx vitest run`
   - Docker: `docker build` must succeed (when applicable)
7. If checks pass, commit ALL changes: `feat: [Story ID] - [Story Title]`
8. Update the PRD to set `passes: true` for the completed story
9. Append your progress to `ralph/progress.txt`

## Progress Report Format

APPEND to ralph/progress.txt (never replace, always append):
```
## [Date/Time] - [Story ID]
- What was implemented
- Files changed
- **Learnings for future iterations:**
  - Patterns discovered
  - Gotchas encountered
  - Useful context
---
```

## Codebase Patterns (seed)

- Zustand store at `src/store/useAvalancheStore.ts` — all app state lives here
- Solver results use `FlowPyGridResult` shape — deposition, hMax, vMax, pMax grids
- `solverInfo.type` discriminant controls overlay behavior (e.g. `'voellmy-2d'` vs `'openfoam'`)
- Map overlays in `src/components/Map/` — FlowPyOverlay reads grid results from store
- Tests: vitest for TS, co-located `*.test.ts` files
- Go code should live under `cmd/solverd/` and `internal/`

## Stop Condition

After completing a user story, check if ALL stories have `passes: true`.

If ALL stories are complete, reply with:
<promise>COMPLETE</promise>

If stories remain, end your response normally — another iteration will pick up the next story.

## Important

- Work on ONE story per iteration
- Commit frequently
- Keep checks green
- Read Codebase Patterns in progress.txt before starting
