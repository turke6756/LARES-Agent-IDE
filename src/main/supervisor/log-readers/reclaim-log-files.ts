import * as fs from 'fs';
import * as path from 'path';
import { getAllAgents } from '../../database';

const SIDECARS = ['', '.scrollback', '.checkpoint', '.checkpoint.tmp']; // '' = the .log itself
const norm = (p: string) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);

/** Unlink an agent's stored log + known sidecars. Refuses out-of-scope or shared
 *  paths. Excludes `agentId` from the shared-reference scan (its row is still present
 *  at call time). Never reconstructs a path from agentId. */
export function reclaimAgentLogFiles(logPath: string, agentId: string, approvedLogsDir: string): void {
  const target = norm(logPath);
  if (path.dirname(target) !== norm(approvedLogsDir)) {
    console.warn(`[reclaim] refusing out-of-scope path: ${logPath}`); return;
  }
  if (getAllAgents().some(a => a.id !== agentId && a.logPath && norm(a.logPath) === target)) {
    console.warn(`[reclaim] ${logPath} still referenced by another agent — skipping`); return;
  }
  for (const s of SIDECARS) {
    try { fs.unlinkSync(logPath + s); }
    catch (e: any) { if (e?.code !== 'ENOENT') console.error(`[reclaim] unlink ${logPath + s}:`, e); }
  }
}
