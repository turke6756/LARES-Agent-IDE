// Context-Overhead Analyzer — MCP tool inventory (plan §2.4).
//
// The riskiest concern (sizing MCP tool schemas), isolated + testable. Pure +
// Electron-free: the toolset-definition provider and the global-server provider
// are injected (the IPC layer require()s the CommonJS scripts/mcp-tools-*.js and
// reads ~/.claude.json). strict-mode exclusion (laneUsesStrictMcp) is applied
// HERE — the walk-up is lane-agnostic.

import type {
  AgentRoleLane,
  McpServerOverhead,
  McpToolOverhead,
} from '../../shared/types';
import { toolsetsForLane, laneUsesStrictMcp } from '../supervisor/mcp-config-builder';
import { TokenEstimator, sumEstimates, zeroEstimate } from './token-estimator';

export interface ToolsetDefsProvider {
  defsFor(toolset: string): Array<{ name: string; description: string; inputSchema: unknown }> | null;
  scriptPathFor(toolset: string): string | null; // scripts/mcp-tools-<name>.js click target
}

export interface GlobalMcpProvider {
  list(): Array<{ name: string; configPath: string }>; // parsed from ~/.claude.json mcpServers
}

export interface McpInventory {
  forLane(lane: AgentRoleLane): McpServerOverhead[];
}

const GLOBAL_NAMED_ONLY_WARNING =
  'Schema requires a live MCP connection; named only, not sized.';
const STRICT_EXCLUDED_WARNING =
  'Excluded from this lane by --strict-mcp-config; shown for transparency, counted 0.';

function sizeTool(
  estimator: TokenEstimator,
  tool: { name: string; description: string; inputSchema: unknown },
): McpToolOverhead {
  const descriptionTokens = estimator.estimate(`${tool.name}\n${tool.description ?? ''}`).tokens;
  const inputSchemaTokens = estimator.estimate(JSON.stringify(tool.inputSchema ?? {})).tokens;
  const estimate = estimator.estimate(
    JSON.stringify({ name: tool.name, description: tool.description ?? '', input_schema: tool.inputSchema ?? {} }),
  );
  return {
    name: tool.name,
    descriptionTokens,
    inputSchemaTokens,
    estimate,
    schemaSource: 'dashboard-module',
  };
}

export function buildMcpInventory(
  estimator: TokenEstimator,
  defs: ToolsetDefsProvider,
  global: GlobalMcpProvider,
): McpInventory {
  return {
    forLane(lane: AgentRoleLane): McpServerOverhead[] {
      const servers: McpServerOverhead[] = [];
      const method = estimator.method;

      // 1+2. Dashboard-injected toolsets granted to this lane.
      const granted = toolsetsForLane(lane)
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      for (const toolset of granted) {
        const toolDefs = defs.defsFor(toolset);
        const scriptPath = defs.scriptPathFor(toolset);
        if (!toolDefs) {
          servers.push({
            id: `dashboard:${toolset}`,
            displayName: toolset,
            source: 'dashboard-injected',
            configPath: scriptPath,
            grantedToAgent: true,
            excludedByStrictMode: false,
            schemaSourced: false,
            total: zeroEstimate(method),
            tools: [],
            warnings: [`Unknown dashboard toolset '${toolset}' — definitions not sourced.`],
          });
          continue;
        }
        const tools = toolDefs.map((t) => sizeTool(estimator, t));
        const total = sumEstimates(tools.map((t) => t.estimate), method);
        servers.push({
          id: `dashboard:${toolset}`,
          displayName: toolset,
          source: 'dashboard-injected',
          configPath: scriptPath,
          grantedToAgent: true,
          excludedByStrictMode: false,
          schemaSourced: true,
          total,
          tools,
          warnings: [],
        });
      }

      // 3. Global servers from ~/.claude.json. Strict lanes (worker/researcher)
      //    see ONLY their injected dashboard config, so globals are excluded
      //    (shown for transparency, counted 0). Non-strict lanes (supervisor/
      //    legacy) keep them but named-only — we never fabricate a schema count.
      const strict = laneUsesStrictMcp(lane);
      for (const g of global.list()) {
        servers.push({
          id: `global:${g.name}`,
          displayName: g.name,
          source: 'user-global',
          configPath: g.configPath,
          grantedToAgent: !strict,
          excludedByStrictMode: strict,
          schemaSourced: false,
          total: zeroEstimate(method),
          tools: [],
          warnings: [strict ? STRICT_EXCLUDED_WARNING : GLOBAL_NAMED_ONLY_WARNING],
        });
      }

      return servers;
    },
  };
}
