import { ResponsesClient, type WireEvent } from './client.ts';
import { executeTool, weatherTool } from './tools.ts';
import { AgentEventType, type AgentEvent, type AgentOptions, type FunctionCallItem, type InputItem } from './types.ts';
import { logger } from './logger.ts';

function objectValue(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
    return typeof value === 'number' ? value : undefined;
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

function finalAnswerFrom(value: unknown): string | undefined {
    const item = objectValue(value);
    if (item?.type !== 'message' || item.phase !== 'final_answer') return undefined;
    const content = Array.isArray(item.content) ? item.content : [];
    return content
        .filter((part) => objectValue(part)?.type === 'output_text')
        .map((part) => stringValue(objectValue(part)?.text) ?? '')
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

    shouldEndLooping(calls: Map<string, FunctionCallItem>, signal: AbortSignal | undefined, step: number, maxSteps: number): boolean {
        if (signal?.aborted === true) return true;
        if (step >= maxSteps) return true;
        if (calls.size === 0) return true;
        return false;
    }

    async *stream(input: string, options: AgentOptions = {}): AsyncGenerator<AgentEvent> {
        const conversation: InputItem[] = [{ role: 'user', content: input }];
        const signal = options.signal;
        const maxSteps = options.maxSteps ?? this.#maxSteps;
        let looping = true;
        let completed = false;
        let step = 0;

        try {
            while (looping) {
                step += 1;
                yield { type: AgentEventType.StepStart, step };

                const calls = new Map<string, FunctionCallItem>();
                let text = '';
                let finalAnswer: string | undefined;

                const request = {
                    model: options.model ?? this.#model,
                    input: conversation,
                    tools: [weatherTool],
                    parallel_tool_calls: true,
                    store: false,
                    reasoning: options.reasoning ?? { effort: 'low' },
                } as const;

                logger.debug('log/request.log', JSON.stringify(request, null, 2));
                for await (const event of this.#client.stream(request, signal)) {
                    logger.debug('log/event-type.log', event.type);
                    if (event.type === 'response.reasoning_text.delta') {
                        const delta = stringValue(event.delta) ?? '';
                        if (delta.length > 0) yield { type: AgentEventType.ReasoningDelta, step, delta };
                        continue;
                    }

                    if (event.type === 'response.output_text.delta') {
                        const delta = stringValue(event.delta) ?? '';
                        text += delta;
                        if (delta.length > 0) yield { type: AgentEventType.ContentDelta, step, delta };
                        continue;
                    }

                    if (event.type === 'response.output_item.done') {
                        const item = objectValue(event.item);
                        const call = functionCallFrom(item);
                        if (call !== undefined) {
                            calls.set(call.call_id, call);
                            continue;
                        }

                        finalAnswer = finalAnswerFrom(item);
                        if (finalAnswer)
                            continue;
                    }

                    if (event.type === 'response.completed') {
                        logger.debug('log/response-completed.log', JSON.stringify(event, null, 2));
                        const response = objectValue(event.response);
                        const usage = objectValue(response?.usage);
                        const inputTokens = numberValue(usage?.input_tokens);
                        const outputTokens = numberValue(usage?.output_tokens);
                        const totalTokens = numberValue(usage?.total_tokens);
                        if (inputTokens !== undefined && outputTokens !== undefined && totalTokens !== undefined) {
                            const tokenUsage: AgentEvent = {
                                type: AgentEventType.TokenUsage,
                                step,
                                inputTokens,
                                outputTokens,
                                totalTokens,
                            };
                            yield tokenUsage;
                        }
                    }
                }

                if (this.shouldEndLooping(calls, signal, step, maxSteps)) {
                    yield { type: AgentEventType.StepEnd, step, toolCalls: calls.size };
                    yield { type: AgentEventType.RunEnd, steps: step, text: finalAnswer ?? text };
                    break;
                }

                const callList = [...calls.values()];
                const pendingResults = callList.map((call) => ({ call, result: executeTool(call) }));
                for (const call of callList) {
                    conversation.push(call);
                }

                for (const { call, result: pendingResult } of pendingResults) {
                    yield { type: AgentEventType.ToolCall, step, call };
                    const result = await pendingResult;
                    conversation.push({ type: 'function_call_output', call_id: result.callId, output: result.output });
                    const event: AgentEvent = {
                        type: AgentEventType.ToolResult,
                        step,
                        callId: result.callId,
                        name: result.name,
                        output: result.output,
                    };
                    if (result.error !== undefined) event.error = result.error;
                    yield event;
                }

                yield { type: AgentEventType.StepEnd, step, toolCalls: calls.size };
            }

            if (step >= maxSteps) {
                yield { type: AgentEventType.Error, message: `Reached maxSteps (${maxSteps})`, step: maxSteps };
            }
        } catch (error) {
            if (signal?.aborted === true) return;
            yield { type: AgentEventType.Error, message: error instanceof Error ? error.message : String(error) };
        }
    }
}