import OpenAI from 'openai';
import type { ResponseCreateParamsStreaming } from 'openai/resources/responses/responses';
import type { AiClient, AiRequest, AiEvent, ProviderResolver, ToolCall } from './ai-client.ts';
import type { FetchLike } from '../fetch.ts';
import type { ToolDefinition } from '../tool/types.ts';
import type { ProviderCredentials } from '../model/types.ts';

export type OpenAiClientOptions = {
    resolveProvider: (modelId: string) => ProviderCredentials | undefined;
    fetch?: FetchLike;
};

export class OpenAiClient implements AiClient {
    readonly #fetch: FetchLike | undefined;
    readonly #resolveProvider: ProviderResolver;
    readonly #providerClients = new Map<string, OpenAI>();

    constructor(options: OpenAiClientOptions) {
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

    async *stream(request: AiRequest): AsyncGenerator<AiEvent> {
        let textStarted = false;
        let textEnded = false;
        let textContent = '';
        let thinkingStarted = false;
        let thinkingEnded = false;
        let thinkingContent = '';
        let toolcallStarted = false;
        let toolArguments = '';

        yield { type: 'start' };
        try {
            const input = typeof request.input === 'string'
                ? request.input
                : request.input.map((item) => {
                    if ('role' in item) return item;
                    if (item.type === 'tool_call') {
                        return {
                            type: 'function_call',
                            call_id: item.toolCall.id,
                            name: item.toolCall.name,
                            arguments: item.toolCall.arguments,
                        };
                    }
                    return {
                        type: 'function_call_output',
                        call_id: item.toolCallId,
                        output: item.content,
                    };
                });
            const tools: ToolDefinition[] | undefined = request.tools?.map((tool) => ({
                type: 'function',
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
                strict: tool.strict ?? false,
            }));
            const stream = await this.#clientFor(request.model).responses.create(
                {
                    model: request.model,
                    input: input as ResponseCreateParamsStreaming['input'],
                    instructions: request.instructions,
                    tools: tools as ResponseCreateParamsStreaming['tools'],
                    parallel_tool_calls: request.parallelToolCalls,
                    reasoning: request.reasoning as ResponseCreateParamsStreaming['reasoning'],
                    store: request.store,
                    max_output_tokens: request.maxOutputTokens,
                    stream: true,
                } as ResponseCreateParamsStreaming,
                { signal: request.signal },
            );

            for await (const event of stream) {
                const data = event as unknown as Record<string, unknown>;
                switch (data.type) {
                    case 'response.output_text.delta': {
                        const delta = typeof data.delta === 'string' ? data.delta : '';
                        if (!textStarted) {
                            textStarted = true;
                            yield { type: 'text_start' };
                        }
                        textContent += delta;
                        if (delta.length > 0) yield { type: 'text_delta', delta };
                        break;
                    }
                    case 'response.output_text.done': {
                        const content = typeof data.text === 'string' ? data.text : textContent;
                        if (!textStarted) {
                            textStarted = true;
                            yield { type: 'text_start' };
                        }
                        textContent = content;
                        textEnded = true;
                        yield { type: 'text_end', content };
                        break;
                    }
                    case 'response.reasoning_text.delta': {
                        const delta = typeof data.delta === 'string' ? data.delta : '';
                        if (!thinkingStarted) {
                            thinkingStarted = true;
                            yield { type: 'thinking_start' };
                        }
                        thinkingContent += delta;
                        if (delta.length > 0) yield { type: 'thinking_delta', delta };
                        break;
                    }
                    case 'response.reasoning_text.done': {
                        const content = typeof data.text === 'string' ? data.text : thinkingContent;
                        if (!thinkingStarted) {
                            thinkingStarted = true;
                            yield { type: 'thinking_start' };
                        }
                        thinkingContent = content;
                        thinkingEnded = true;
                        yield { type: 'thinking_end', content };
                        break;
                    }
                    case 'response.output_item.added': {
                        const item = data.item;
                        if (typeof item !== 'object' || item === null) break;
                        const outputItem = item as Record<string, unknown>;
                        if (outputItem.type === 'function_call') {
                            toolcallStarted = true;
                            toolArguments = '';
                            yield { type: 'toolcall_start' };
                        }
                        break;
                    }
                    case 'response.function_call_arguments.delta': {
                        const delta = typeof data.delta === 'string' ? data.delta : '';
                        if (!toolcallStarted) {
                            toolcallStarted = true;
                            toolArguments = '';
                            yield { type: 'toolcall_start' };
                        }
                        toolArguments += delta;
                        if (delta.length > 0) yield { type: 'toolcall_delta', delta };
                        break;
                    }
                    case 'response.function_call_arguments.done':
                        if (typeof data.arguments === 'string') toolArguments = data.arguments;
                        break;
                    case 'response.output_item.done': {
                        const item = data.item;
                        if (typeof item !== 'object' || item === null) break;
                        const outputItem = item as Record<string, unknown>;
                        if (outputItem.type === 'function_call') {
                            const callId = typeof outputItem.call_id === 'string' ? outputItem.call_id : '';
                            const name = typeof outputItem.name === 'string' ? outputItem.name : '';
                            const arguments_ = typeof outputItem.arguments === 'string'
                                ? outputItem.arguments
                                : toolArguments;
                            if (callId.length > 0 && name.length > 0) {
                                const toolCall: ToolCall = {
                                    id: callId,
                                    name,
                                    arguments: arguments_,
                                };
                                if (!toolcallStarted) {
                                    toolcallStarted = true;
                                    yield { type: 'toolcall_start' };
                                }
                                yield { type: 'toolcall_end', toolCall };
                            }
                            toolcallStarted = false;
                            toolArguments = '';
                            break;
                        }
                        if (outputItem.type === 'message' && !textEnded) {
                            const content = Array.isArray(outputItem.content)
                                ? outputItem.content
                                    .filter((part) => typeof part === 'object' && part !== null &&
                                        (part as Record<string, unknown>).type === 'output_text')
                                    .map((part) => {
                                        const text = (part as Record<string, unknown>).text;
                                        return typeof text === 'string' ? text : '';
                                    })
                                    .join('')
                                : '';
                            if (!textStarted) {
                                textStarted = true;
                                yield { type: 'text_start' };
                            }
                            textContent = content;
                            textEnded = true;
                            yield { type: 'text_end', content };
                        }
                        break;
                    }
                    case 'response.completed':
                        if (textStarted && !textEnded) {
                            textEnded = true;
                            yield { type: 'text_end', content: textContent };
                        }
                        if (thinkingStarted && !thinkingEnded) {
                            thinkingEnded = true;
                            yield { type: 'thinking_end', content: thinkingContent };
                        }
                        yield {
                            type: 'done',
                            reason: typeof (data.response as Record<string, unknown> | undefined)?.status === 'string'
                                ? (data.response as Record<string, unknown>).status as string
                                : 'completed',
                        };
                        return;
                    case 'response.failed':
                    case 'error': {
                        const response = data.response as Record<string, unknown> | undefined;
                        const error = data.error as Record<string, unknown> | undefined;
                        const reason = typeof error?.message === 'string'
                            ? error.message
                            : typeof response?.status_details === 'object' && response.status_details !== null &&
                                typeof (response.status_details as Record<string, unknown>).message === 'string'
                                ? (response.status_details as Record<string, unknown>).message as string
                                : 'OpenAI response failed';
                        yield { type: 'error', reason };
                        return;
                    }
                    case 'response.incomplete': {
                        const response = data.response as Record<string, unknown> | undefined;
                        const details = response?.incomplete_details as Record<string, unknown> | undefined;
                        yield {
                            type: 'done',
                            reason: typeof details?.reason === 'string' ? details.reason : 'incomplete',
                        };
                        return;
                    }
                }
            }

            if (textStarted && !textEnded) yield { type: 'text_end', content: textContent };
            if (thinkingStarted && !thinkingEnded) yield { type: 'thinking_end', content: thinkingContent };
            yield { type: 'done', reason: 'stream_closed' };
        } catch (error) {
            yield { type: 'error', reason: error instanceof Error ? error.message : String(error) };
        }
    }
}
