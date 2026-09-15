import { ResponsesClient, type WireEvent } from './client.ts';
import { executeTool, weatherTool } from './tools.ts';
import type { AgentEvent, AgentOptions, FunctionCallItem, InputItem } from './types.ts';
import { logger } from './logger.ts';

function objectValue(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function functionCallFrom(value: unknown): FunctionCallItem | undefined {
    const item = objectValue(value);
    if (item?.type !== 'function_call') return undefined;
    const callId = stringValue(item.call_id);
    const name = stringValue(item.name);
    const args = stringValue(item.arguments);
    if (callId === undefined || name === undefined || args === undefined) return undefined;
    return { type: 'function_call', call_id: callId, name, arguments: args };
}

function textFromCompleted(event: WireEvent): string {
    const response = objectValue(event.response);
    const output = Array.isArray(response?.output) ? response.output : [];
    return output
        .map((item) => {
            const message = objectValue(item);
            const content = Array.isArray(message?.content) ? message.content : [];
            return content
                .map((part) => objectValue(part)?.text)
                .filter((text): text is string => typeof text === 'string')
                .join('');
        })
        .join('');
}

export class Agent {
    readonly #client: ResponsesClient;
    readonly #model: string;
    readonly #maxSteps: number;

    constructor(client: ResponsesClient, options: AgentOptions = {}) {
        this.#client = client;
        this.#model = options.model ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
        this.#maxSteps = options.maxSteps ?? 8;
    }

    async *stream(input: string, options: AgentOptions = {}): AsyncGenerator<AgentEvent> {
        const conversation: InputItem[] = [{ role: 'user', content: input }];
        const signal = options.signal;
        const maxSteps = options.maxSteps ?? this.#maxSteps;
        let finalText = '';

        try {
            for (let step = 1; step <= maxSteps; step += 1) {
                if (signal?.aborted === true) return;
                yield { type: 'step_start', step };

                const calls = new Map<string, FunctionCallItem>();
                const itemCalls = new Map<string, FunctionCallItem>();
                let text = '';
                let reasoningText = '';
                let completedEvent: WireEvent | undefined;

                const request = {
                    model: options.model ?? this.#model,
                    input: conversation,
                    tools: [weatherTool],
                    parallel_tool_calls: true,
                    store: false,
                    reasoning: options.reasoning ?? { effort: 'low' },
                } as const;

                for await (const event of this.#client.stream(request, signal)) {
                    logger.debug('event-type.log', event.type);
                    if (event.type === 'response.reasoning_text.delta' || event.type === 'response.reasoning_summary_text.delta') {
                        const delta = stringValue(event.delta) ?? '';
                        reasoningText += delta;
                        if (delta.length > 0) yield { type: 'reasoning_delta', step, delta };
                        continue;
                    }

                    if (event.type === 'response.output_text.delta') {
                        const delta = stringValue(event.delta) ?? '';
                        text += delta;
                        if (delta.length > 0) yield { type: 'content_delta', step, delta };
                        continue;
                    }


                    // 多余的，不需要
                    // if (event.type === 'response.function_call_arguments.done') {
                    //     console.log('====> response.function_call_arguments.done:', JSON.stringify(event, null, 2));
                    //     const callId = stringValue(event.call_id);
                    //     const itemId = stringValue(event.item_id);
                    //     const args = stringValue(event.arguments);
                    //     const previous = (itemId === undefined ? undefined : itemCalls.get(itemId)) ??
                    //         (callId === undefined ? undefined : calls.get(callId));
                    //     if (previous !== undefined && args !== undefined) {
                    //         const completed = { ...previous, arguments: args };
                    //         calls.set(completed.call_id, completed);
                    //     }
                    //     continue;
                    // }

                    // if (event.type === 'response.output_item.done') {
                    //     logger.debug('item-done.log', JSON.stringify(event, null, 2));
                    //     const call = functionCallFrom(event.item);
                    //     if (call !== undefined) {
                    //         calls.set(call.call_id, call);
                    //         itemCalls.set(call.call_id, call);
                    //     }
                    //     continue;
                    // }

                    if (event.type === 'response.completed') {
                        logger.debug('response-completed.log', JSON.stringify(event, null, 2));
                        completedEvent = event;
                        const response = objectValue(event.response);
                        const output = Array.isArray(response?.output) ? response.output : [];
                        for (const item of output) {
                            const call = functionCallFrom(item);
                            if (call !== undefined)
                                calls.set(call.call_id, call);
                        }
                    }
                }

                if (text.length === 0 && completedEvent !== undefined)
                    text = textFromCompleted(completedEvent);
                finalText = text.length > 0 ? text : finalText;

                // Some providers emit function calls only in response.completed.output.
                // A second pass keeps the loop usable across slightly different SSE gateways.
                if (calls.size === 0) {
                    // The client intentionally exposes raw events; providers that emit only
                    // a completed resource should be handled by their output_item.done event.
                }

                if (calls.size === 0) {
                    yield { type: 'step_end', step, toolCalls: 0 };
                    yield { type: 'run_end', steps: step, text: finalText };
                    return;
                }

                for (const call of calls.values()) {
                    yield { type: 'tool_call', step, call };
                    conversation.push(call);
                }

                for (const call of calls.values()) {
                    const result = executeTool(call);
                    conversation.push({ type: 'function_call_output', call_id: result.callId, output: result.output });
                    const event: AgentEvent = {
                        type: 'tool_result',
                        step,
                        callId: result.callId,
                        name: result.name,
                        output: result.output,
                    };
                    if (result.error !== undefined) event.error = result.error;
                    yield event;
                }

                yield { type: 'step_end', step, toolCalls: calls.size };
                void reasoningText;
            }

            yield { type: 'error', message: `Reached maxSteps (${maxSteps})`, step: maxSteps };
        } catch (error) {
            if (signal?.aborted === true) return;
            yield { type: 'error', message: error instanceof Error ? error.message : String(error) };
        }
    }
}