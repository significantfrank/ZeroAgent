# Chapter 4: Agent Loop with File, Terminal & Search Tools

在 Chapter 3 基础 Agent Loop 之上，扩展了更多 Tool Calls 能力：

1. **本地文件操作**（`node:fs`）：`read_file`、`write_file`、`edit_file`
2. **执行命令**：`run_terminal_command`
3. **文件搜索**：`file_search`（基于 `grep -rn`）

## 运行

```bash
pnpm install
pnpm --filter @zero-agent/chapter4 start "Read the file at ./README.md and summarize it"
# 不带 prompt 参数时进入交互模式
pnpm --filter @zero-agent/chapter4 start
```

配置环境变量：

```dotenv
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
```

## 工具说明

### read_file

读取本地文件内容，支持 `offset`（起始行，1-indexed）和 `limit`（行数）参数。输出带行号前缀。

```json
{ "path": "src/index.ts", "offset": 1, "limit": 20 }
```

### write_file

写入文件（不存在则创建，存在则覆盖）。

```json
{ "path": "output.txt", "content": "hello world" }
```

### edit_file

精确替换文件中的文本片段。`old_text` 必须在文件中唯一出现，否则报错。

```json
{ "path": "config.ts", "old_text": "const x = 1;", "new_text": "const x = 2;" }
```

### run_terminal_command

执行 shell 命令，返回 `stdout` 和 `stderr`。超时 30 秒。

```json
{ "command": "ls -la" }
```

### file_search

使用 `grep -rn` 在目录中递归搜索正则模式，返回匹配的行及行号。

```json
{ "pattern": "TODO", "path": "src/" }
```

## 测试

```bash
pnpm --filter @zero-agent/chapter4 typecheck
pnpm --filter @zero-agent/chapter4 test
```

测试使用本地 mock `fetch` 返回 SSE（不需要 API Key），文件/终端/搜索工具测试使用临时目录。
