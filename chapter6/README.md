# Chapter 6: Agent Loop with Skills Support

在 Chapter 5 的 MCP 支持基础上，新增了 **Skills（技能）** 功能。

## 新增内容

### ResponsesRequestBuilder (`src/request-builder.ts`)

用 fluent builder 组装 Responses API request：`addDeveloperMsg()` 添加 developer-role input，`addTool()` 在运行时注册工具，`addInputItem()` 追加对话历史；skill prompt、模型参数和工具列表由 Agent 在每轮请求前更新。

### SkillDefinition (`src/skills/types.ts`)

定义技能的结构：
- `name`：技能名称（唯一标识）
- `description`：技能描述，初始请求用它构建轻量技能目录
- `instructions`：技能指令文本，由 `load_skill` 的 function output 按需返回
- `tools`：可选工具定义；目前尚未接入工具执行分发

### SkillRegistry (`src/skills/registry.ts`)

技能注册中心：
- `register(skill)`：注册一个技能
- `get(name)`：按名称获取技能
- `list()`：列出所有已注册技能
- `buildCatalog()`：构建供模型选择的技能名称和描述目录
- `buildPromptInstructions()`：只构建技能名称和描述列表
- `buildInstructions()`：组合所有技能的完整指令文本

### Skill Loader (`src/skills/loader.ts`)

技能加载器，支持从两个路径加载技能：
1. `~/.zeroagent/skills/`：用户级别的全局技能
2. `{workdir}/.zeroagent/skills/`：项目级别的局部技能

`loadSkills(workdir, registry)` 会从上述目录加载技能并填充目标 registry。技能文件为 Markdown 格式，使用 frontmatter 定义元数据。

### Agent 工作目录与按需加载 (`workdir`)

Agent 的 `workdir` 标识项目工作目录。启动时会读取用户级和项目级目录中的 `skill.md`；同名项目技能覆盖用户技能。技能文件采用简单的 YAML frontmatter：

```text
~/.zeroagent/skills/                 # 用户级技能
	repo-tech-writer/skill.md
<workdir>/.zeroagent/skills/         # 项目级技能
	repo-tech-writer/skill.md
```

```markdown
---
name: repo-tech-writer
description: Write technical articles about code repositories
---
Analyze the repository, explain its architecture, and write the article in Chinese.
```

技能加载和发送给模型分为两步：

1. Agent 读取技能文件并保存在本地 registry。初始 request 的顶层 `instructions` 只包含技能名称和描述；builder 通过 developer-role input 提供当前 `workdir`，工具列表包含 `load_skill`。
2. 模型判断任务需要某项技能后，以技能名称调用 `load_skill` function。工具执行结果会把该技能的完整 instructions 放入 `function_call_output`，随后模型即可据此执行任务。

因此，询问可用技能时，模型可以直接根据目录回答，无需发送各技能的全文。存在可用技能时会关闭并行 tool calls，确保 instructions 加载完成后再执行操作。当前 `SkillDefinition.tools` 仅保存工具定义，尚未接入工具执行分发。

## 运行

```bash
pnpm install

# 启动 Agent CLI
pnpm --filter @zero-agent/chapter6 start "What is the weather in Tokyo?"

```

## 测试

```bash
pnpm --filter @zero-agent/chapter6 typecheck
pnpm --filter @zero-agent/chapter6 test
```
