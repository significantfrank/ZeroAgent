import { OpenAiClient, type ProviderResolver } from '../src/ai/index.ts';
import type { FetchLike } from '../src/fetch.ts';

const defaultTestResolver: ProviderResolver = () => ({
    baseUrl: 'https://test.invalid/v1',
    key: 'test-key',
});

export function createTestClient(fetch?: FetchLike, resolveProvider: ProviderResolver = defaultTestResolver): OpenAiClient {
    return new OpenAiClient({ fetch, resolveProvider });
}
