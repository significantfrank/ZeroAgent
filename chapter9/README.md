# Chapter 9：Subagent

Chapter 9 为 Agent Loop 增加一层任务委派能力。父 Agent 可调用 `run_subagent`，让子 Agent 独立完成一项具体任务，再把子 Agent 的最终文本作为工具结果接回当前对话。

## 调用方式

`run_subagent` 接受一个必填的 `task` 参数：

```json
{
  "task": "检查 src/ 下的错误处理，并总结最重要的发现。"
}
```

子 Agent 完成后，父 Agent 会收到它的最终回答作为 `function_call_output`，并可继续综合或追问。

## 上下文与权限

- 子 Agent 使用新的对话上下文，不会看到父 Agent 的对话历史或 session。
- 子 Agent 继承父 Agent 当前使用的模型、工作目录和已加载 skills。
- 子 Agent 可使用相同的本地工具和已连接的 MCP 工具，包括写文件与执行命令；委派任务时应明确限定操作范围。
- 只允许一层委派。子 Agent 不会获得 `run_subagent` 工具，避免递归委派。

## 自定义 SubAgent

在 `~/.zeroagent/agents/`、项目的 `.zeroagent/agents/`，或直接放在项目 `.zeroagent/` 下创建 Markdown 定义文件。项目定义覆盖同名用户级定义；`.zeroagent/agents/` 中的定义优先于项目 `.zeroagent/` 根目录中的同名文件。

```markdown
---
name: review
description: Review code changes for bugs and regressions.
mode: subagent
model: deepseek/deepseek-chat
tools:
  read_file: true
  file_search: true
---
Review the requested changes. Report actionable findings first, with file references.
```

`name` 使用 kebab-case，`mode` 必须为 `subagent`，正文作为 system prompt。`model` 和 `tools` 均可选。`tools` 是按工具名设置的白名单；只提供值为 `true` 的工具，未列出的工具不可见且无法执行。MCP 工具也必须显式列入白名单才能使用。

在 CLI 输入 `@review 检查这次改动的错误处理`，会使用 `review` 定义执行子任务，再由父 Agent 综合结果。该语法支持交互模式和单次模式。模型自主调用 `run_subagent` 时仍使用通用子 Agent；两种委派共用 Agent 的子任务执行管道。

使用 `/reload` 可重新加载自定义 SubAgent 定义。
