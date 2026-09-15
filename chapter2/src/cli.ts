import { Agent } from './agent.ts';
import { ResponsesClient } from './client.ts';
import type { AgentEvent } from './types.ts';

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
        case 'step_start':
            console.log(`\n[step ${event.step}]`);
            break;
        case 'reasoning_delta':
            process.stdout.write(`\x1b[90m${event.delta}\x1b[0m`);
            break;
        case 'content_delta':
            process.stdout.write(event.delta);
            break;
        case 'tool_call':
            console.log(`\n[tool_call] ${event.call.name}(${event.call.arguments})`);
            break;
        case 'tool_result':
            console.log(`\n[tool_result] ${event.output}`);
            break;
        case 'step_end':
            console.log(`\n[step ${event.step} done: ${event.toolCalls} tool call(s)]`);
            break;
        case 'run_end':
            console.log(`\n\n[run_end after ${event.steps} step(s)]`);
            break;
        case 'error':
            console.error(`\n[error] ${event.message}`);
            break;
    }
}

async function main(): Promise<void> {
    loadEnv();
    const args = process.argv.slice(2);
    const reasoningEnabled = args.includes('--reasoning');
    const prompt = args.filter((arg) => arg !== '--reasoning').join(' ') || "What's the weather like in Tokyo?";
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());

    const agent = new Agent(new ResponsesClient());
    for await (const event of agent.stream(prompt, {
        signal: controller.signal,
        reasoning: reasoningEnabled ? { effort: 'high', summary: 'auto' } : undefined,
    })) {
        render(event);
    }
    process.stdout.write('\n');
}

void main();