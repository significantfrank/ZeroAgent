# Chapter 5: Agent Loop with MCP Support

在 Chapter 4 的文件操作、命令执行和搜索工具基础上，新增了 **MCP（Model Context Protocol）** 支持。

## 新增内容

### MCP 客户端 (`src/mcp-client.ts`)

`McpClientManager` 管理一个或多个 MCP server 连接：
- 支持内存传输（in-memory transport）和 stdio 传输
- 工具命名空间隔离：`serverName__toolName` 避免冲突
- 工具发现：通过 `listTools` 自动发现 MCP server 暴露的工具并转换为 `FunctionTool`
- 工具调用：将 `FunctionCallItem` 转发到对应 MCP server

### MCP Server (`src/mcp/server.ts`)

一个 demo MCP server，提供三个工具：
- `echo`：回显文本
- `add`：两数相加
- `upper`：转大写

## 运行

```bash
pnpm install

# 启动 Agent CLI；CLI 会自动以 stdio 子进程连接 demo MCP server
pnpm --filter @zero-agent/chapter5 start "Use demo__echo to echo hello MCP."

# 如需独立运行 demo MCP server，供其他 MCP 客户端连接
pnpm --filter @zero-agent/chapter5 mcp-server
```

## 测试

```bash
pnpm --filter @zero-agent/chapter5 typecheck
pnpm --filter @zero-agent/chapter5 test
```

测试使用 in-memory transport 连接 MCP server，无需启动独立进程。
