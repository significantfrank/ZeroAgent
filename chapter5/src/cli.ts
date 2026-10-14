import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { Agent } from './agent-loop.ts';
import { ResponsesClient } from './client.ts';
import { mcpManager } from './tools.ts';
import { AgentEventType, type AgentEvent, type ReasoningConfig } from './types.ts';

const REASONING: ReasoningConfig = { effort: 'high', summary: 'auto' };

function loadEnv(): void {
    const loader = (process as typeof process & { loadEnvFile?: (path?: string) => void }).loadEnvFile;
    try {
        loader?.('.env');
    } catch {
        // Environment variables may already be supplied by the shell.
    }
}

function render(event: AgentEvent): void {
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
        case AgentEventType.TokenUsage: {
            console.log(`\n[token_usage] input ${event.inputTokens}, output ${event.outputTokens}, total ${event.totalTokens}`);
            break;
        }
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
    }
}

async function runOnce(agent: Agent, prompt: string): Promise<void> {
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());

    for await (const event of agent.stream(prompt, {
        signal: controller.signal,
        reasoning: REASONING,
    })) {
        render(event);
    }
    process.stdout.write('\n');
}

async function main(): Promise<void> {
    loadEnv();

    await mcpManager.connectStdio(
        'demo',
        process.execPath,
        [fileURLToPath(new URL('./mcp/server.ts', import.meta.url))],
    );

    const args = process.argv.slice(2);
    const agent = new Agent(new ResponsesClient());

    // If a prompt is passed as CLI args, run it once and exit.
    if (args.length > 0) {
        await runOnce(agent, args.join(' '));
        await mcpManager.closeAll();
        return;
    }

    // Interactive REPL: read prompts from stdin.
    const rl = createInterface({ input: stdin, output: stdout });
    console.log('Interactive mode — type your prompt and press Enter. Ctrl+C to exit.\n');

    while (true) {
        let prompt: string;
        try {
            prompt = await rl.question('❯ ');
        } catch {
            break; // stdin closed
        }

        prompt = prompt.trim();
        if (prompt.length === 0) continue;

        await runOnce(agent, prompt);
        console.log(); // blank line between turns
    }

    rl.close();
    await mcpManager.closeAll();
}

void main();
