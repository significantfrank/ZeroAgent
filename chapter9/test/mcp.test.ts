import assert from 'node:assert/strict';
import test from 'node:test';
import { McpClientManager, createInMemoryTransportPair } from '../src/mcp/mcp-client.ts';
import { executeTool, mcpManager, getAllToolsWithMcp, ToolRegistry } from '../src/tool/index.ts';
import { createDemoServer } from '../src/mcp/server.ts';
import type { FunctionCallItem } from '../src/tool/types.ts';

function makeCall(name: string, args: Record<string, unknown>): FunctionCallItem {
    return { type: 'function_call', call_id: `call_${name}`, name, arguments: JSON.stringify(args) };
}

const emptyToolRegistry = new ToolRegistry();

// ---------------------------------------------------------------------------
// In-memory MCP server tests
// ---------------------------------------------------------------------------

test('MCP client discovers tools from an in-memory server', async () => {
    const manager = new McpClientManager();
    const [clientTransport, serverTransport] = createInMemoryTransportPair();
    const server = createDemoServer();
    await server.connect(serverTransport);
    await manager.connectTransport('demo', clientTransport);

    const entries = await manager.listAllTools();
    const names = entries.map((e) => e.prefixedName).sort();
    assert.deepEqual(names, ['demo__echo']);

    await manager.closeAll();
});

test('MCP tool definitions are included in getAllToolsWithMcp', async () => {
    // Use the global mcpManager — but first save its state
    const originalTools = await getAllToolsWithMcp();

    const [clientTransport, serverTransport] = createInMemoryTransportPair();
    const server = createDemoServer();
    await server.connect(serverTransport);
    await mcpManager.connectTransport('test-server', clientTransport);

    const tools = await getAllToolsWithMcp();
    const toolNames = tools.map((t) => t.name);
    assert.ok(toolNames.includes('test-server__echo'));
    // Local tools should still be present
    assert.ok(toolNames.includes('read_file'));
    assert.ok(toolNames.includes('write_file'));

    await mcpManager.close('test-server');
    // Verify state restored
    const restored = await getAllToolsWithMcp();
    assert.equal(restored.length, originalTools.length);
});

// ---------------------------------------------------------------------------
// MCP tool call tests (via executeTool with the global mcpManager)
// ---------------------------------------------------------------------------

test('executeTool dispatches MCP echo tool', async () => {
    const [clientTransport, serverTransport] = createInMemoryTransportPair();
    const server = createDemoServer();
    await server.connect(serverTransport);
    await mcpManager.connectTransport('echo-test', clientTransport);

    // Populate the tool index
    await mcpManager.listAllTools();

    const result = await executeTool(makeCall('echo-test__echo', { text: 'hello mcp' }), emptyToolRegistry);
    assert.equal(result.error, undefined);
    assert.equal(result.output, 'hello mcp');

    await mcpManager.close('echo-test');
});

// ---------------------------------------------------------------------------
// MCP error handling tests
// ---------------------------------------------------------------------------

test('executeTool returns error for unknown MCP tool', async () => {
    const result = await executeTool(makeCall('nonexistent-server__nope', {}), emptyToolRegistry);
    assert.equal(result.error, 'unknown_tool');
    assert.ok(result.output.includes('Unknown tool'));
});

test('MCP client reports error when calling a tool on a disconnected server', async () => {
    const manager = new McpClientManager();
    // Manually register a tool index entry without connecting
    // We need to test the callTool path for a disconnected server.
    // First connect, then close, then try calling.
    const [clientTransport, serverTransport] = createInMemoryTransportPair();
    const server = createDemoServer();
    await server.connect(serverTransport);
    await manager.connectTransport('disconnect-test', clientTransport);
    await manager.listAllTools();
    await manager.close('disconnect-test');

    const result = await manager.callTool('disconnect-test__echo', { text: 'test' });
    assert.equal(result.error, 'unknown_mcp_tool'); // tool index cleared on close
});

// ---------------------------------------------------------------------------
// MCP tool name namespacing test
// ---------------------------------------------------------------------------

test('MCP tools from multiple servers have unique prefixed names', async () => {
    const manager = new McpClientManager();

    // Server 1
    const [c1, s1] = createInMemoryTransportPair();
    const server1 = createDemoServer();
    await server1.connect(s1);
    await manager.connectTransport('srv1', c1);

    // Server 2 (same tool names, different server name)
    const [c2, s2] = createInMemoryTransportPair();
    const server2 = createDemoServer();
    await server2.connect(s2);
    await manager.connectTransport('srv2', c2);

    const entries = await manager.listAllTools();
    const names = entries.map((e) => e.prefixedName).sort();
    // The same echo tool is namespaced by server name.
    assert.ok(names.includes('srv1__echo'));
    assert.ok(names.includes('srv2__echo'));

    // Calling srv1__echo should not bleed into srv2
    const r1 = await manager.callTool('srv1__echo', { text: 'from-1' });
    assert.equal(r1.output, 'from-1');
    const r2 = await manager.callTool('srv2__echo', { text: 'from-2' });
    assert.equal(r2.output, 'from-2');

    await manager.closeAll();
});
