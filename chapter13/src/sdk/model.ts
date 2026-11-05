import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AiClient } from '../ai/ai-client.ts';
import { OpenAiClient } from '../ai/openai-client.ts';
import type { FetchLike } from '../fetch.ts';
import type { ProviderCredentials } from '../model/types.ts';

export interface LanguageModel {
    readonly model: string;
    createClient(): AiClient;
}

export type OpenAICompatibleLlmOptions = {
    model: string;
    baseURL?: string;
    apiKey?: string;
    fetch?: FetchLike;
};

export class OpenAICompatibleLlm implements LanguageModel {
    readonly model: string;
    readonly #client: AiClient;

    constructor(options: OpenAICompatibleLlmOptions) {
        const envFile = join(process.cwd(), '.env');
        if (existsSync(envFile)) {
            process.loadEnvFile(envFile);
        }

        this.model = options.model.trim();
        if (this.model.length === 0) {
            throw new Error('model must not be empty.');
        }

        const apiKey = (options.apiKey ?? process.env.OPENAI_API_KEY)?.trim();
        if (apiKey === undefined || apiKey.trim().length === 0) {
            throw new Error('Provide apiKey or set OPENAI_API_KEY.');
        }

        const baseURL = (options.baseURL ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').trim();
        if (baseURL.length === 0) {
            throw new Error('baseURL must not be empty.');
        }
        const credentials: ProviderCredentials = {
            baseUrl: baseURL,
            key: apiKey,
        };
        this.#client = new OpenAiClient({
            resolveProvider: (model) => model === this.model ? credentials : undefined,
            fetch: options.fetch,
        });
    }

    createClient(): AiClient {
        return this.#client;
    }
}
