#!/usr/bin/env node

process.env.DASHBOARD_MCP_TOOLSETS ||= 'orchestration,teams,comms,observability';
require('./mcp-dashboard.js');
