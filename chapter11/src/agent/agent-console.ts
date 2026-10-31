import type { AgentEvent } from './types.ts';

export function render(event: AgentEvent): void {
    switch (event.type) {
        case 'error':
            console.error(`\n[error] ${event.reason}`);
            break;
        case 'message_update':
            switch (event.aiEvent.type) {
                case 'text_delta':
                    process.stdout.write(`\x1b[34m${event.aiEvent.delta}\x1b[0m`);
                    break;
                case 'thinking_delta':
                    process.stdout.write(`\x1b[90m${event.aiEvent.delta}\x1b[0m`);
                    break;
            }
            break;
        case 'tool_execution_start':
            console.log(`\n[tool_call] ${event.toolName}(${JSON.stringify(event.args)})`);
            break;
        case 'tool_execution_end':
            console.log(`\n[tool_result] ${event.result}`);
            break;
    }
}
