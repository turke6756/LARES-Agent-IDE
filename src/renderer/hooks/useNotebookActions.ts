import { useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { ISharedCell, ISharedNotebook } from '@jupyter/ydoc';
import { toJupyterServerPath } from '../lib/jupyterCollab';
import { useCellStatusStore } from '../stores/cellStatus';

const API_ROOT = 'http://127.0.0.1:24678/api/notebooks/kernel';
const KERNEL_POLL_MS = 2000;

type KernelExecutionState = 'idle' | 'busy' | 'starting' | 'dead' | string | null;

interface KernelState {
  attached: boolean;
  kernel_id: string | null;
  kernel_name: string | null;
  status: KernelExecutionState;
  execution_state: KernelExecutionState;
  last_execution_count: number | null;
}

interface ExecuteCellResult {
  status: 'ok' | 'error' | 'aborted' | 'timeout';
  cell_id: string;
  execution_count: number | null;
}

type PendingAction =
  | 'run-cell'
  | 'run-all'
  | 'interrupt'
  | 'restart'
  | 'add-code'
  | 'add-markdown'
  | 'delete-cell'
  | 'move-cell'
  | null;

interface NotebookActions {
  kernelState: KernelState | null;
  kernelStatusLabel: string;
  pendingAction: PendingAction;
  actionError: string | null;
  runCell: (cellId: string) => Promise<ExecuteCellResult | null>;
  runAll: () => Promise<void>;
  interruptKernel: () => Promise<void>;
  restartKernel: () => Promise<void>;
  addCodeCell: (afterIndex?: number) => string | null;
  addMarkdownCell: (afterIndex?: number) => string | null;
  deleteCell: (index: number) => void;
  moveCellUp: (index: number) => void;
  moveCellDown: (index: number) => void;
  clearActionError: () => void;
}

export function useNotebookActions(path: string, ynotebook: ISharedNotebook | null): NotebookActions {
  const notebookPath = useMemo(() => toJupyterServerPath(path), [path]);
  const [kernelState, setKernelState] = useState<KernelState | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const syncNotebookCells = useCellStatusStore((state) => state.syncNotebookCells);
  const setCellStatus = useCellStatusStore((state) => state.setCellStatus);
  const setManyCellStatus = useCellStatusStore((state) => state.setManyCellStatus);
  const clearNotebookRunState = useCellStatusStore((state) => state.clearNotebookRunState);
  const markNotebookError = useCellStatusStore((state) => state.markNotebookError);

  useEffect(() => {
    syncNotebookCells(
      notebookPath,
      ynotebook?.cells.map((cell) => cell.id) ?? []
    );
  }, [notebookPath, syncNotebookCells, ynotebook]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const refreshKernelState = async () => {
      try {
        const url = new URL(`${API_ROOT}/state`);
        url.searchParams.set('notebookPath', notebookPath);
        const nextState = await fetchJson<KernelState>(url.toString(), { method: 'GET' });
        if (!cancelled && mountedRef.current) {
          setKernelState(nextState);
        }
      } catch (error) {
        if (!cancelled && mountedRef.current) {
          setActionError(error instanceof Error ? error.message : String(error));
        }
      }
    };

    void refreshKernelState();
    const interval = window.setInterval(() => {
      void refreshKernelState();
    }, KERNEL_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [notebookPath]);

  const clearActionError = () => setActionError(null);

  const runCell = async (cellId: string) => {
    setActionError(null);
    setPendingAction('run-cell');
    clearNotebookRunState(notebookPath);
    setCellStatus(notebookPath, cellId, 'running');
    try {
      const result = await fetchJson<ExecuteCellResult>(`${API_ROOT}/execute-cell`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notebookPath, cellId }),
      });
      setCellStatus(notebookPath, cellId, result.status === 'ok' ? 'done' : 'error');
      markNotebookError(notebookPath, result.status !== 'ok');
      await refreshKernelStateOnce(notebookPath, setKernelState, mountedRef);
      return result;
    } catch (error) {
      setCellStatus(notebookPath, cellId, 'error');
      markNotebookError(notebookPath, true);
      setActionError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      if (mountedRef.current) {
        setPendingAction(null);
      }
    }
  };

  const runAll = async () => {
    if (!ynotebook) return;

    const codeCells = ynotebook.cells.filter(isCodeCell);
    if (codeCells.length === 0) {
      setActionError('Notebook has no code cells to run.');
      return;
    }

    setActionError(null);
    setPendingAction('run-all');
    clearNotebookRunState(notebookPath);
    setManyCellStatus(
      notebookPath,
      codeCells.map((cell) => cell.id),
      'queued'
    );
    try {
      for (let index = 0; index < codeCells.length; index += 1) {
        const cell = codeCells[index];
        setCellStatus(notebookPath, cell.id, 'running');
        const result = await fetchJson<ExecuteCellResult>(`${API_ROOT}/execute-cell`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ notebookPath, cellId: cell.id }),
        });
        const nextStatus = result.status === 'ok' ? 'done' : 'error';
        setCellStatus(notebookPath, cell.id, nextStatus);
        if (result.status !== 'ok') {
          setManyCellStatus(
            notebookPath,
            codeCells.slice(index + 1).map((queuedCell) => queuedCell.id),
            'idle'
          );
          markNotebookError(notebookPath, true);
          throw new Error(`Execution stopped at cell ${cell.id} with status ${result.status}.`);
        }
      }
      markNotebookError(notebookPath, false);
      await refreshKernelStateOnce(notebookPath, setKernelState, mountedRef);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current) {
        setPendingAction(null);
      }
    }
  };

  const interruptKernel = async () => {
    setActionError(null);
    setPendingAction('interrupt');
    try {
      await fetchJson(`${API_ROOT}/interrupt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notebookPath }),
      });
      clearNotebookRunState(notebookPath);
      await refreshKernelStateOnce(notebookPath, setKernelState, mountedRef);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current) {
        setPendingAction(null);
      }
    }
  };

  const restartKernel = async () => {
    setActionError(null);
    setPendingAction('restart');
    try {
      await fetchJson(`${API_ROOT}/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notebookPath }),
      });
      clearNotebookRunState(notebookPath);
      await refreshKernelStateOnce(notebookPath, setKernelState, mountedRef);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current) {
        setPendingAction(null);
      }
    }
  };

  const addCodeCell = (afterIndex = ynotebook?.cells.length ?? 0) => {
    if (!ynotebook) return null;
    setActionError(null);
    setPendingAction('add-code');
    try {
      const insertionIndex = Math.max(0, Math.min(afterIndex + 1, ynotebook.cells.length));
      const nextCell = ynotebook.insertCell(insertionIndex, {
        cell_type: 'code',
        source: '',
        metadata: {},
        execution_count: null,
        outputs: [],
      });
      return nextCell.id;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      if (mountedRef.current) {
        setPendingAction(null);
      }
    }
  };

  const addMarkdownCell = (afterIndex = ynotebook?.cells.length ?? 0) => {
    if (!ynotebook) return null;
    setActionError(null);
    setPendingAction('add-markdown');
    try {
      const insertionIndex = Math.max(0, Math.min(afterIndex + 1, ynotebook.cells.length));
      const nextCell = ynotebook.insertCell(insertionIndex, {
        cell_type: 'markdown',
        source: '',
        metadata: {},
      });
      return nextCell.id;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      if (mountedRef.current) {
        setPendingAction(null);
      }
    }
  };

  const deleteCell = (index: number) => {
    if (!ynotebook) return;
    setActionError(null);
    setPendingAction('delete-cell');
    try {
      if (index < 0 || index >= ynotebook.cells.length) {
        throw new Error('Cell index out of range.');
      }
      clearNotebookRunState(notebookPath);
      ynotebook.deleteCell(index);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current) {
        setPendingAction(null);
      }
    }
  };

  const moveCellUp = (index: number) => {
    if (!ynotebook || index <= 0) return;
    setActionError(null);
    setPendingAction('move-cell');
    try {
      ynotebook.moveCell(index, index - 1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current) {
        setPendingAction(null);
      }
    }
  };

  const moveCellDown = (index: number) => {
    if (!ynotebook || index < 0 || index >= ynotebook.cells.length - 1) return;
    setActionError(null);
    setPendingAction('move-cell');
    try {
      ynotebook.moveCell(index, index + 1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current) {
        setPendingAction(null);
      }
    }
  };

  return {
    kernelState,
    kernelStatusLabel: formatKernelStatus(kernelState),
    pendingAction,
    actionError,
    runCell,
    runAll,
    interruptKernel,
    restartKernel,
    addCodeCell,
    addMarkdownCell,
    deleteCell,
    moveCellUp,
    moveCellDown,
    clearActionError,
  };
}

// WP0.2 (M1): the dashboard API is bearer-token gated. Fetch the token once
// over IPC and memoize the promise module-wide — every request through
// fetchJson() below attaches it. On failure the promise is reset so a later
// call can retry instead of caching a rejection forever.
let apiTokenPromise: Promise<string> | null = null;
function getApiToken(): Promise<string> {
  if (!apiTokenPromise) {
    apiTokenPromise = window.api.system.getApiToken().catch((err) => {
      apiTokenPromise = null;
      throw err;
    });
  }
  return apiTokenPromise;
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${await getApiToken()}`);
  const response = await fetch(input, { ...init, headers });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return payload as T;
}

async function refreshKernelStateOnce(
  notebookPath: string,
  setKernelState: Dispatch<SetStateAction<KernelState | null>>,
  mountedRef: MutableRefObject<boolean>
) {
  const url = new URL(`${API_ROOT}/state`);
  url.searchParams.set('notebookPath', notebookPath);
  const nextState = await fetchJson<KernelState>(url.toString(), { method: 'GET' });
  if (mountedRef.current) {
    setKernelState(nextState);
  }
}

function isCodeCell(cell: ISharedCell): cell is Extract<ISharedCell, { cell_type: 'code' }> {
  return cell.cell_type === 'code';
}

function formatKernelStatus(kernelState: KernelState | null): string {
  if (!kernelState) return 'Kernel unavailable';
  if (!kernelState.attached) return 'Kernel detached';
  const state = kernelState.execution_state || kernelState.status || 'unknown';
  const kernelName = kernelState.kernel_name || 'kernel';
  return `${kernelName} ${state}`;
}
