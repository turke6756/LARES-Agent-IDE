// L1.1 registry-drift fix (wave2-mcp-tool-observability §1.1), scoped to the
// files this worker owns.
//
// As of GT-A WP-A4.5 the canonical context-overhead ToolsetDefsProvider
// (makeToolsetDefsProvider / TOOLSET_SCRIPT_MAP in context-overhead/ipc-deps.ts)
// now carries BOTH `plans-read` and `plans` entries, so `base.defsFor(...)`
// resolves them directly. This decorator remains as a belt-and-suspenders
// fallback (and to keep the parse-time reverse map self-contained): if the base
// provider ever returns null for either plans toolset, we require() the same
// CommonJS script (`scripts/mcp-tools-plans.js`) every other toolset loads and
// resolve the matching defs fn.
//
// FIRST-WINS ORDERING (WP-A4.5): the reverse map (mcp-toolset-map.ts
// DASHBOARD_TOOLSETS) lists `plans-read` before `plans`, so the three shared
// read-tool names resolve to `plans-read` and supervisor-only focus verbs resolve
// to `plans`.

import { makeToolsetDefsProvider } from '../context-overhead/ipc-deps';
import { getScriptPath } from '../supervisor/paths';
import type { ToolsetDefsLike } from './mcp-toolset-map';

export const PLANS_TOOLSET = 'plans';
export const PLANS_READ_TOOLSET = 'plans-read';
const PLANS_SCRIPT = 'mcp-tools-plans.js';
// Each plans toolset maps to the defs fn that enumerates its tool names.
const PLANS_DEFS_FNS: Record<string, string> = {
  [PLANS_TOOLSET]: 'getPlansToolDefinitions',
  [PLANS_READ_TOOLSET]: 'getPlansReadToolDefinitions',
};

/** The context-overhead defs provider, decorated so `defsFor('plans')` and
 *  `defsFor('plans-read')` resolve the plans tool names even if the base provider
 *  returns null for them. Every other toolset is delegated unchanged. Name is all
 *  the reverse map keys on, so we return the minimal `{ name }` shape. */
export function makePlansAwareDefsProvider(): ToolsetDefsLike {
  const base = makeToolsetDefsProvider();
  return {
    defsFor(toolset: string): Array<{ name: string }> | null {
      const fromBase = base.defsFor(toolset);
      if (fromBase) return fromBase;
      const fn = PLANS_DEFS_FNS[toolset];
      if (fn) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const mod = require(getScriptPath(PLANS_SCRIPT));
          const defs = mod[fn]?.();
          if (!Array.isArray(defs)) return null;
          return defs
            .filter((d: { name?: unknown }) => d && typeof d.name === 'string' && d.name)
            .map((d: { name: string }) => ({ name: d.name }));
        } catch (err) {
          console.error(
            `[skill-analytics] failed to load ${toolset} toolset defs:`,
            err instanceof Error ? err.message : err,
          );
          return null;
        }
      }
      return null;
    },
  };
}
