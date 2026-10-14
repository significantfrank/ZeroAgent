import OpenAI from 'openai';
import type { ResponseCreateParamsStreaming } from 'openai/resources/responses/responses';
import type { FetchLike } from './fetch.ts';
import type { ResponsesRequest } from './types.ts';

export type WireEvent = Record<string, unknown> & { type: string };

export type ResponsesClientOptions = {
    apiKey?: string;
    baseURL?: string;
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
    readonly #client: OpenAI;

    constructor(options: ResponsesClientOptions = {}) {
        this.#client = new OpenAI({
            apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
            baseURL: options.baseURL ?? process.env.OPENAI_BASE_URL,
            fetch: options.fetch,
        });
    }

    async *stream(request: Omit<ResponsesRequest, 'stream'>, signal?: AbortSignal): AsyncGenerator<WireEvent> {
        try {
            const stream = await this.#client.responses.create(
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
