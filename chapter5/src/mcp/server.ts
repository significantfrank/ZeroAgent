import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/**
 * A demo MCP server that exposes a few tools via the Model Context Protocol.
 *
 * Run standalone:  node src/mcp/server.ts
 *
 * The server is also designed to be used in tests via in-memory transports
 * — see `createDemoServer` below.
 */

export function createDemoServer(): McpServer {
    const server = new McpServer(
        { name: 'zero-agent-demo', version: '0.1.0' },
        { capabilities: { tools: {} } },
    );

    // Tool 1: echo — returns the input text, useful for testing.
    server.registerTool('echo', {
        description: 'Echo back the provided text. Useful for testing MCP connectivity.',
        inputSchema: { text: z.string().describe('The text to echo back') },
    }, async (args) => {
        return {
            content: [{ type: 'text' as const, text: args.text }],
        };
    });

    // Tool 2: add — adds two numbers, demonstrates structured input.
    server.registerTool('add', {
        description: 'Add two numbers and return the sum.',
        inputSchema: {
            a: z.number().describe('First number'),
            b: z.number().describe('Second number'),
        },
    }, async (args) => {
        return {
            content: [{ type: 'text' as const, text: String(args.a + args.b) }],
        };
    });

    // Tool 3: upper — converts text to uppercase.
    server.registerTool('upper', {
        description: 'Convert text to uppercase.',
        inputSchema: { text: z.string().describe('The text to convert') },
    }, async (args) => {
        return {
            content: [{ type: 'text' as const, text: args.text.toUpperCase() }],
        };
    });

    return server;
}

/**
 * Start the demo MCP server with a stdio transport.
 * This is the entry point for `pnpm --filter @zero-agent/chapter5 mcp-server`.
 */
async function main(): Promise<void> {
    const server = createDemoServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write('[mcp-server] zero-agent-demo running on stdio\n');
}

// Only run main when executed directly (not when imported in tests).
const isMain = process.argv[1]?.endsWith('mcp/server.ts') ||
    process.argv[1]?.endsWith('mcp/server.js');

if (isMain) {
    void main();
}
