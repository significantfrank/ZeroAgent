import { HindsightClient } from '@vectorize-io/hindsight-client';
import type { MemoryProvider } from './memory-provider.ts';

type HindsightClientLike = {
    retain(bankId: string, content: string): Promise<{ success: boolean }>;
    recall(bankId: string, query: string): Promise<{ results: readonly { text: string }[] }>;
};

export type HindsightMemoryProviderOptions = {
    baseUrl?: string;
    bankId?: string;
};

export class HindsightMemoryProvider implements MemoryProvider {
    readonly #client: HindsightClientLike;
    readonly #bankId: string;

    constructor(
        options: HindsightMemoryProviderOptions = {},
        client?: HindsightClientLike,
    ) {
        this.#client = client ?? new HindsightClient({
            baseUrl: options.baseUrl ?? process.env.HINDSIGHT_BASE_URL ?? 'http://localhost:8888',
        });
        this.#bankId = options.bankId ?? process.env.HINDSIGHT_BANK_ID ?? 'zeroagent';
    }

    async retain(content: string): Promise<void> {
        const response = await this.#client.retain(this.#bankId, content);
        if (!response.success) {
            throw new Error(`Hindsight failed to retain memory in bank "${this.#bankId}"`);
        }
    }

    async recall(query: string): Promise<readonly string[]> {
        const response = await this.#client.recall(this.#bankId, query);
        return response.results.map((memory) => memory.text);
    }
}
