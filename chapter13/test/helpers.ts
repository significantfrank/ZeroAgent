import { OpenAiClient, type ProviderResolver } from '../src/ai/index.ts';
import type { AiClient } from '../src/ai/ai-client.ts';
import { Agent } from '../src/agent/agent-loop.ts';
import type { AgentOptions } from '../src/agent/types.ts';
import type { FetchLike } from '../src/fetch.ts';

const defaultTestResolver: ProviderResolver = () => ({
    baseUrl: 'https://test.invalid/v1',
    key: 'test-key',
});

export function createTestClient(fetch?: FetchLike, resolveProvider: ProviderResolver = defaultTestResolver): OpenAiClient {
    return new OpenAiClient({ fetch, resolveProvider });
}

export function createTestAgent(client: AiClient, options: AgentOptions = {}): Agent {
    return new Agent(client, options);
}
