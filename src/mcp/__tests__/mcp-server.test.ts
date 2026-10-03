import { describe, it, expect, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import * as mcpResources from '../mcp-resources';
import * as mcpTools from '../mcp-tools';

// We use vi.mock to prevent it from actually binding to Stdio in a test environment
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => {
    return {
        StdioServerTransport: vi.fn().mockImplementation(() => ({}))
    };
});

describe('MCP Server Initialization', () => {
    it('should register both resources and tools on the server', () => {
        const spyResources = vi.spyOn(mcpResources, 'registerMcpResources').mockImplementation(() => { });
        const spyTools = vi.spyOn(mcpTools, 'registerMcpTools').mockImplementation(() => { });

        const server = new Server({ name: 'test', version: '1.0' }, { capabilities: {} });

        // Emulate the CLI's registration sequence
        mcpResources.registerMcpResources(server, {} as any);
        mcpTools.registerMcpTools(server, {} as any);

        expect(spyResources).toHaveBeenCalledTimes(1);
        expect(spyTools).toHaveBeenCalledTimes(1);

        spyResources.mockRestore();
        spyTools.mockRestore();
    });
});
