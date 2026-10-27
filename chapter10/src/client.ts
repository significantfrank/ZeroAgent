import OpenAI from 'openai';
import type { ResponseCreateParamsStreaming } from 'openai/resources/responses/responses';
import type { FetchLike } from './fetch.ts';
import type { ProviderCredentials } from './model/types.ts';
import type { ResponsesRequest } from './types.ts';

export type WireEvent = Record<string, unknown> & { type: string };

/** Resolves a model id to provider credentials. */
export type ProviderResolver = (modelId: string) => ProviderCredentials | undefined;

export type ResponsesClientOptions = {
    resolveProvider: ProviderResolver;
    fetch?: FetchLike;
};

export class ResponsesError extends Error {
    readonly status: number | undefined;

    constructor(message: string, status?: number) {
        super(message);
        this.name = 'ResponsesError';
        this.status = status;
    }
}

export class ResponsesClient {
    readonly #fetch: FetchLike | undefined;
    readonly #resolveProvider: ProviderResolver;
    readonly #providerClients = new Map<string, OpenAI>();

    constructor(options: ResponsesClientOptions) {
        this.#fetch = options.fetch;
        this.#resolveProvider = options.resolveProvider;
    }

    #clientFor(model: string): OpenAI {
        const credentials = this.#resolveProvider(model);
        if (credentials === undefined) {
            throw new Error(`No provider credentials configured for model "${model}" in ~/.zeroagent.`);
        }
        const cacheKey = `${credentials.baseUrl}\u0000${credentials.key}`;
        let client = this.#providerClients.get(cacheKey);
        if (client === undefined) {
            client = new OpenAI({
                apiKey: credentials.key,
                baseURL: credentials.baseUrl,
                fetch: this.#fetch,
            });
            this.#providerClients.set(cacheKey, client);
        }
        return client;
    }

    async *stream(request: Omit<ResponsesRequest, 'stream'>, signal?: AbortSignal): AsyncGenerator<WireEvent> {
        try {
            const stream = await this.#clientFor(request.model).responses.create(
                { ...request, stream: true } as unknown as ResponseCreateParamsStreaming,
                { signal },
            );
            for await (const event of stream) {
                if (typeof event === 'object' && event !== null && 'type' in event) {
                    yield event as unknown as WireEvent;
                }
            }
        } catch (error) {
            if (error instanceof ResponsesError) throw error;
            const message = error instanceof Error ? error.message : String(error);
            const status = typeof error === 'object' && error !== null && 'status' in error &&
                typeof error.status === 'number' ? error.status : undefined;
            throw new ResponsesError(message, status);
        }
    }
}
