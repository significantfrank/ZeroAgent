import type { FetchLike } from '../fetch.ts';
import type { AiClient, ProviderResolver } from './ai-client.ts';
import { OpenAiClient } from './openai-client.ts';

export type { AiClient, AiInputItem, AiRequest, AiTool, AiEvent as AssistantMessageEvent, ProviderResolver, ToolCall } from './ai-client.ts';
export { OpenAiClient } from './openai-client.ts';
export type { OpenAiClientOptions } from './openai-client.ts';

export type AiClientFactoryOptions = {
    resolveProvider: ProviderResolver;
    fetch?: FetchLike;
};

const openAiCompatibleProviders = new Set(['openai', 'glm', 'deepseek']);

export function createAiClient(provider: string, options: AiClientFactoryOptions): AiClient {
    if (!openAiCompatibleProviders.has(provider.toLowerCase())) {
        throw new Error(`Unsupported AI provider "${provider}".`);
    }

    return new OpenAiClient(options);
}
