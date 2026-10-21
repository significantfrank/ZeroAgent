import { AgentEventType, type AgentEvent } from './types.ts';

export function render(event: AgentEvent): void {
    switch (event.type) {
        case AgentEventType.StepStart:
            console.log(`\n[step ${event.step}]`);
            break;
        case AgentEventType.ReasoningDelta:
            process.stdout.write(`\x1b[90m${event.delta}\x1b[0m`);
            break;
        case AgentEventType.ContentDelta:
            process.stdout.write(`\x1b[34m${event.delta}\x1b[0m`);
            break;
        case AgentEventType.TokenUsage:
            console.log(`\n[token_usage] input ${event.inputTokens}, output ${event.outputTokens}, total ${event.totalTokens}`);
            break;
        case AgentEventType.ToolCall:
            console.log(`\n[tool_call] ${event.call.name}(${event.call.arguments})`);
            break;
        case AgentEventType.ToolResult:
            console.log(`\n[tool_result] ${event.output}`);
            break;
        case AgentEventType.StepEnd:
            console.log(`\n[step ${event.step} done: ${event.toolCalls} tool call(s)]`);
            break;
        case AgentEventType.RunEnd:
            console.log(`\n\n[run_end after ${event.steps} step(s)]`);
            break;
        case AgentEventType.Error:
            console.error(`\n[error] ${event.message}`);
            break;
        case AgentEventType.SubagentStart:
            console.log(`[${event.name} subagent]`);
            break;
        case AgentEventType.SubagentEnd:
            console.log(`[${event.name} subagent end]`);
            break;
    }
}