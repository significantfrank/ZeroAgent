import { ResponsesClient, type ProviderResolver } from '../src/client.ts';
import type { FetchLike } from '../src/fetch.ts';

const defaultTestResolver: ProviderResolver = () => ({
    baseUrl: 'https://test.invalid/v1',
    key: 'test-key',
});

export function createTestClient(fetch?: FetchLike, resolveProvider: ProviderResolver = defaultTestResolver): ResponsesClient {
    return new ResponsesClient({ fetch, resolveProvider });
}
