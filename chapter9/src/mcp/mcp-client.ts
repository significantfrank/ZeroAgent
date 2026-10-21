import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { FunctionTool } from '../tool/types.ts';

/**
 * An MCP tool as returned by the server, converted to our FunctionTool shape.
 */
export type McpToolEntry = {
    /** Original MCP tool name (without prefix). */
    originalName: string;
    /** Prefixed name used in the agent's tool registry. */
    prefixedName: string;
    /** The server that owns this tool. */
    serverName: string;
    /** The FunctionTool definition for the Responses API. */
    tool: FunctionTool;
};

/**
 * Result of calling an MCP tool.
 */
export type McpCallResult = {
    output: string;
    error?: string;
};

/**
 * Creates a linked pair of in-memory transports.
 * The caller passes one side to an MCP server, and the other side to
 * {@link McpClientManager.connectTransport}.
 */
export function createInMemoryTransportPair(): [Transport, Transport] {
    return InMemoryTransport.createLinkedPair() as [Transport, Transport];
}

/**
 * Manages one or more MCP server connections.
 *
 * Each server is identified by a unique name. Tools from each server are
 * namespaced with a prefix (`serverName__toolName`) to avoid collisions.
 */
export class McpClientManager {
    readonly #clients = new Map<string, Client>();
    readonly #transports = new Map<string, Transport>();
    readonly #toolIndex = new Map<string, { serverName: string; originalName: string }>();

    /**
     * Connect to an MCP server using any Transport (in-memory, stdio, etc.).
     */
    async connectTransport(serverName: string, transport: Transport): Promise<void> {
        if (this.#clients.has(serverName)) {
            throw new Error(`MCP server "${serverName}" is already connected`);
        }
        const client = new Client(
            { name: 'zero-agent', version: '0.1.0' },
            { capabilities: {} },
        );
        await client.connect(transport);
        this.#clients.set(serverName, client);
        this.#transports.set(serverName, transport);
    }

    /**
     * Connect to an MCP server via stdio (spawns a child process).
     */
    async connectStdio(serverName: string, command: string, args: string[] = [], env?: Record<string, string>): Promise<void> {
        const transport = new StdioClientTransport({
            command,
            args,
            env: env as Record<string, string> | undefined,
            stderr: 'pipe',
        });
        await this.connectTransport(serverName, transport);
    }

    /**
     * List all tools from all connected MCP servers and convert them to FunctionTool[].
     */
    async listAllTools(): Promise<McpToolEntry[]> {
        const entries: McpToolEntry[] = [];
        for (const [serverName, client] of this.#clients) {
            const result = await client.listTools();
            for (const mcpTool of result.tools) {
                const prefixedName = `${serverName}__${mcpTool.name}`;
                const tool: FunctionTool = {
                    type: 'function',
                    name: prefixedName,
                    description: mcpTool.description ?? `MCP tool: ${mcpTool.name}`,
                    parameters: mcpTool.inputSchema as Record<string, unknown>,
                    strict: false,
                };
                entries.push({ originalName: mcpTool.name, prefixedName, serverName, tool });
                this.#toolIndex.set(prefixedName, { serverName, originalName: mcpTool.name });
            }
        }
        return entries;
    }

    /**
     * Call an MCP tool by its prefixed name.
     */
    async callTool(prefixedName: string, args: Record<string, unknown>): Promise<McpCallResult> {
        const index = this.#toolIndex.get(prefixedName);
        if (index === undefined) {
            return { output: `Unknown MCP tool: ${prefixedName}`, error: 'unknown_mcp_tool' };
        }
        const client = this.#clients.get(index.serverName);
        if (client === undefined) {
            return { output: `MCP server "${index.serverName}" is not connected`, error: 'server_disconnected' };
        }
        try {
            const result = await client.callTool({
                name: index.originalName,
                arguments: args,
            });
            // Extract text from content blocks
            const textParts: string[] = [];
            if (Array.isArray(result.content)) {
                for (const block of result.content) {
                    if (typeof block === 'object' && block !== null && 'type' in block) {
                        if (block.type === 'text' && typeof block.text === 'string') {
                            textParts.push(block.text);
                        }
                    }
                }
            }
            const output = textParts.length > 0 ? textParts.join('\n') : JSON.stringify(result);
            const error = result.isError === true ? 'mcp_tool_error' : undefined;
            return { output, error };
        } catch (error) {
            return {
                output: error instanceof Error ? error.message : String(error),
                error: 'mcp_call_error',
            };
        }
    }

    /**
     * Check if a tool name belongs to an MCP server.
     */
    isMcpTool(toolName: string): boolean {
        return this.#toolIndex.has(toolName);
    }

    /**
     * Close all MCP server connections.
     */
    async closeAll(): Promise<void> {
        for (const [, client] of this.#clients) {
            await client.close();
        }
        this.#clients.clear();
        this.#transports.clear();
        this.#toolIndex.clear();
    }

    /**
     * Close a specific MCP server connection.
     */
    async close(serverName: string): Promise<void> {
        const client = this.#clients.get(serverName);
        if (client !== undefined) {
            await client.close();
            this.#clients.delete(serverName);
            this.#transports.delete(serverName);
            // Remove tool index entries for this server
            for (const [prefixedName, index] of this.#toolIndex) {
                if (index.serverName === serverName) {
                    this.#toolIndex.delete(prefixedName);
                }
            }
        }
    }
}
