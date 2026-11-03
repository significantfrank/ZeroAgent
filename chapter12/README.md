# Chapter 12：Agent 长期记忆

本章为 Agent 增加跨 session 的长期记忆。通过 `MemoryProvider` 抽象隔离记忆后端，默认使用 Hindsight 实现。

## 工作流程

记忆功能通过 Extension 生命周期 Hook 接入：

```text
before_agent_start
  └─ MemoryProvider.recall(userInput)
       └─ 将检索到的记忆加入本次请求

turn_end（最终 assistant 回复）
  └─ MemoryProvider.retain(userInput + assistantReply)
```

- [`src/memory/memory-provider.ts`](src/memory/memory-provider.ts) 定义 `MemoryProvider` 接口，包含 `recall(query)` 和 `retain(content)`。
- [`src/memory/hindsight-provider.ts`](src/memory/hindsight-provider.ts) 将接口映射到 Hindsight 的 recall 和 retain API。
- [`src/memory/memory-extension.ts`](src/memory/memory-extension.ts) 注册生命周期 Hook。
- CLI 创建 `ExtensionRunner` 时自动注册 Hindsight provider。
- 仅最终 assistant 回复会被保存；包含工具调用的中间轮次会跳过。
- 记忆读写失败会记录错误，但不会中断当前对话。

## 配置

默认连接 `http://localhost:8888`，使用 `zeroagent` bank。可通过环境变量覆盖：

```bash
HINDSIGHT_BASE_URL=http://localhost:8888
HINDSIGHT_BANK_ID=zeroagent
```

程序化使用时，可以注入自定义 `MemoryProvider` 并注册记忆 Hook：

```ts
import { ExtensionRunner } from './src/extension/index.ts';
import { HindsightMemoryProvider, registerMemoryExtension } from './src/memory/index.ts';

const extensions = new ExtensionRunner();
registerMemoryExtension(extensions, new HindsightMemoryProvider());
```

## 运行

```bash
pnpm --filter @zero-agent/chapter12 start
```

## Hindsight 集成测试

确保 Hindsight 服务运行后执行：

```bash
pnpm --filter @zero-agent/chapter12 test:hindsight
```

集成测试依次验证 `retain`、`recall` 和 `reflect`，默认使用独立的 `hindsight-integration-test` bank。可通过 `HINDSIGHT_BASE_URL` 和 `HINDSIGHT_BANK_ID` 覆盖服务地址和 bank ID。该测试与默认单元测试分开运行。
