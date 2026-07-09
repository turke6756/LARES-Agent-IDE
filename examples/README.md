# Example workflows

Three copyable **workflow / prompt examples** for Lares. Each folder is a short
brief: the roles involved and an example prompt you can adapt to your own
workspace.

These are **prompt examples, not runnable scripts** — there are no fixtures to
execute. They show *how to frame* a multi-agent task; you run them by launching
the described agents in your own workspace and giving them a prompt like the one
shown.

| Example | Pattern | What it shows |
|---|---|---|
| [research-report](./research-report/) | supervisor → researchers | Fan a question out to researcher agents and assemble a cited report. |
| [notebook-cleanup](./notebook-cleanup/) | single agent + live kernel | Repair and validate a notebook against its live kernel. |
| [code-review](./code-review/) | cross-provider groupthink | A two-agent review pass to catch what one reviewer misses. |

For the patterns behind these, see [docs/workflows.md](../docs/workflows.md).
