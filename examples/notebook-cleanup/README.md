# Notebook cleanup

A **workflow / prompt example** — a prompt to adapt, not a runnable script.

**Pattern:** single agent + live kernel (see
[docs/workflows.md](../../docs/workflows.md#notebook-driven-work-with-a-live-kernel)).

## Roles

- **Worker agent** — drives the live Jupyter kernel through Lares' notebook tools:
  runs cells, reads outputs, fixes what breaks, and validates that the notebook
  executes end to end. It drives the *same* kernel you see in the notebook view.

## How to run it

1. Open a workspace that contains the notebook you want to clean up.
2. Open the notebook in Lares' notebook view (this starts the live kernel).
3. Launch a worker agent and give it a prompt like the one below.
4. Watch the cells execute in the view; grab any cell and run it yourself if you
   want to check its work.

## Example prompt (to the worker)

```
Clean up the notebook at <path>.ipynb. Execute it against the live kernel and:
- fix any cell that errors, and re-run to confirm the fix;
- remove dead/scratch cells and obvious duplication;
- make sure it runs top-to-bottom from a clean state without manual steps;
- add a short markdown intro cell describing what the notebook does.

Address cells by their nbformat id, not by index. When done, tell me which cells
you changed and confirm a clean end-to-end run.
```

## What to expect

The agent iterates cell by cell against the live kernel, and its runs stay in sync
with the notebook view — no "file changed on disk" prompts. Review the final
end-to-end run yourself before relying on the result.
