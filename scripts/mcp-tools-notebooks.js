function getNotebooksToolDefinitions() {
  return [
    {
      name: 'execute_cell',
      description: 'Execute a single notebook cell on the live kernel and persist outputs to disk. Address by nbformat 4.5 cell id (NOT by index). The user sees the update land live in the dashboard notebook view with no reload.',
      inputSchema: {
        type: 'object',
        properties: {
          notebook_path: { type: 'string', description: 'Server-relative notebook path (jupyter-server root_dir is /, so a WSL path like /home/user/foo.ipynb becomes "home/user/foo.ipynb").' },
          cell_id: { type: 'string', description: 'The nbformat 4.5 cell id (UUID-like string). Read it from the .ipynb cell metadata.' },
          timeout: { type: 'number', description: 'Cell timeout in seconds (default 60). Kernel is interrupted on timeout.' },
        },
        required: ['notebook_path', 'cell_id'],
      },
    },
    {
      name: 'execute_range',
      description: 'Execute a contiguous range of cells [from_cell_id..to_cell_id] inclusive on the live kernel. Stops at the first cell that errors or times out and returns what completed.',
      inputSchema: {
        type: 'object',
        properties: {
          notebook_path: { type: 'string', description: 'Server-relative notebook path.' },
          from_cell_id: { type: 'string', description: 'First cell id to execute.' },
          to_cell_id: { type: 'string', description: 'Last cell id to execute (must appear after from_cell_id).' },
          timeout: { type: 'number', description: 'Per-cell timeout in seconds (default 60).' },
        },
        required: ['notebook_path', 'from_cell_id', 'to_cell_id'],
      },
    },
    {
      name: 'execute_notebook',
      description: 'Execute every code cell in a notebook from top to bottom on the live kernel. Stops on the first non-ok cell and returns the last executed cell plus compact output summaries.',
      inputSchema: {
        type: 'object',
        properties: {
          notebook_path: { type: 'string', description: 'Server-relative notebook path.' },
          timeout: { type: 'number', description: 'Per-cell timeout in seconds (default 60).' },
        },
        required: ['notebook_path'],
      },
    },
    {
      name: 'interrupt_kernel',
      description: "Interrupt the live kernel for a notebook (sends SIGINT-equivalent). Affects the user's notebook view too — that is intended.",
      inputSchema: {
        type: 'object',
        properties: {
          notebook_path: { type: 'string', description: 'Server-relative notebook path.' },
        },
        required: ['notebook_path'],
      },
    },
    {
      name: 'restart_kernel',
      description: 'Restart the live kernel for a notebook. Clears in-memory state but preserves the session — the dashboard notebook view and MCP tools auto-reattach.',
      inputSchema: {
        type: 'object',
        properties: {
          notebook_path: { type: 'string', description: 'Server-relative notebook path.' },
        },
        required: ['notebook_path'],
      },
    },
    {
      name: 'get_kernel_state',
      description: 'Get the live kernel status for a notebook: whether a session is attached, kernel id/name, current state (idle/busy/dead), and the highest execution_count seen on disk.',
      inputSchema: {
        type: 'object',
        properties: {
          notebook_path: { type: 'string', description: 'Server-relative notebook path.' },
        },
        required: ['notebook_path'],
      },
    },
  ];
}

async function handleNotebooksToolCall(name, args, apiRequest) {
  switch (name) {
    case 'execute_cell': {
      const payload = { notebookPath: args.notebook_path, cellId: args.cell_id };
      if (args.timeout) payload.timeout = args.timeout;
      const result = await apiRequest('POST', '/api/notebooks/kernel/execute-cell', payload);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'execute_range': {
      const payload = {
        notebookPath: args.notebook_path,
        fromCellId: args.from_cell_id,
        toCellId: args.to_cell_id,
      };
      if (args.timeout) payload.timeout = args.timeout;
      const result = await apiRequest('POST', '/api/notebooks/kernel/execute-range', payload);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'execute_notebook': {
      const payload = { notebookPath: args.notebook_path };
      if (args.timeout) payload.timeout = args.timeout;
      const result = await apiRequest('POST', '/api/notebooks/kernel/execute-notebook', payload);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'interrupt_kernel': {
      const result = await apiRequest('POST', '/api/notebooks/kernel/interrupt', { notebookPath: args.notebook_path });
      return { content: [{ type: 'text', text: `Kernel interrupted for ${args.notebook_path}` }] };
    }

    case 'restart_kernel': {
      const result = await apiRequest('POST', '/api/notebooks/kernel/restart', { notebookPath: args.notebook_path });
      return { content: [{ type: 'text', text: `Kernel restarted for ${args.notebook_path}\nKernel id: ${result.kernel_id}` }] };
    }

    case 'get_kernel_state': {
      const qs = `notebookPath=${encodeURIComponent(args.notebook_path)}`;
      const result = await apiRequest('GET', `/api/notebooks/kernel/state?${qs}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    default:
      return null;
  }
}

module.exports = { getNotebooksToolDefinitions, handleNotebooksToolCall };
