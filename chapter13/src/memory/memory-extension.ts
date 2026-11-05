import type { AgentEvent } from '../agent/types.ts';
import { ExtensionRunner } from '../extension/runner.ts';
import { logger } from '../logger.ts';
import type { MemoryProvider } from './memory-provider.ts';

function reportMemoryError(operation: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[memory] ${operation} failed: ${message}`);
}

export function registerMemoryExtension(
    extensions: ExtensionRunner,
    provider: MemoryProvider,
): void {
    extensions.on('before_agent_start', async (event) => {
        try {
            const memories = await provider.recall(event.input);
            logger.debug('log/agent.log', `Query：${event.input}\nRecalled memories: ${JSON.stringify(memories, null, 2)}`);

            if (memories.length > 0) {
                event.systemPromptOptions.sections['long_term_memory'] = [
                    'Relevant long-term memories:',
                    ...memories.map((memory) => `- ${memory}`),
                ].join('\n');
            }
        } catch (error) {
            reportMemoryError('recall', error);
        }
    });

    extensions.on('turn_end', async (event: Extract<AgentEvent, { type: 'turn_end' }>, context) => {
        if (event.message.role !== 'assistant' ||
            (event.message.toolCalls?.length ?? 0) > 0 ||
            event.message.content.trim().length === 0) {
            return;
        }

        try {
            logger.debug('log/agent.log', `Retaining memory for User: ${context.input}, assistant message: ${event.message.content}`);
            await provider.retain(`User: ${context.input}\nAssistant: ${event.message.content}`);
        } catch (error) {
            reportMemoryError('retain', error);
        }
    });
}
