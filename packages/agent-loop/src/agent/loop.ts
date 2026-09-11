/**
 * The ReAct agent loop.
 *
 * Each iteration is one **Reason → Act → Observe** cycle against the OpenAI
 * Responses API:
 *
 * 1. **Reason** — the model streams reasoning (separated onto the `reasoning`
 *    channel) followed by answer text on the `content` channel. Streamed text is
 *    forwarded immediately; nothing is buffered until the turn ends.
 * 2. **Act** — tool calls arrive on the `tool_call` channel, with argument JSON
 *    streamed incrementally. Completed calls are executed.
 * 3. **Observe** — each result is emitted on the `tool_result` channel and fed
 *    back to the model as a `function_call_output` item, and the loop repeats.
 *
 * The loop terminates when the model answers without calling a tool, when
 * `maxSteps` is reached, when the run is aborted, or on a fatal API error.
 *
 * Conversation state is carried as plain Responses API input items, so the run
 * works with `store: false` and needs no server-side conversation object.
 */

import { ResponsesClient, OpenAIError } from '../openai/responses.ts';
import type {
  ResponseInputItem,
  ResponseStatus,
  ResponsesRequest,
  ReasoningConfig,
} from '../openai/types.ts';
import { ToolRegistry } from '../tools/registry.ts';
import type { AnyToolDefinition } from '../tools/types.ts';
import { errorMessage } from '../util/errors.ts';
import { TurnAccumulator } from './accumulator.ts';
import { addUsage, emptyUsage } from './events.ts';
import type {
  AgentEvent,
  AgentReasoningBlock,
  AgentResult,
  AgentStep,
  AgentToolCall,
  AgentToolResult,
  RunEndEvent,
  StopReason,
  StepEndEvent,
  ToolResultEvent,
} from './events.ts';

/** Anything a caller can start a run with. */
export type AgentInput =
  | string
  | readonly string[]
  | ResponseInputItem
  | readonly ResponseInputItem[];

export interface ReActAgentOptions {
  client: ResponsesClient;
  /** Model id, e.g. `gpt-5`, `o4-mini`, `gpt-4.1`. */
  model: string;
  /** System-level instructions, sent as `instructions`. */
  instructions?: string;
  /** A registry, or a plain list of tools. */
  tools?: ToolRegistry | readonly AnyToolDefinition[];
  /** Maximum ReAct iterations. Default 10. */
  maxSteps?: number;
  /** Reasoning configuration (`effort`, `summary`). */
  reasoning?: ReasoningConfig;
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  /** Persist the response server-side. Default false (stateless). */
  store?: boolean;
  /** Let the model request several tools in one turn. Default false (sequential). */
  parallelToolCalls?: boolean;
  /** Per-tool execution timeout in ms. Default 60_000. */
  toolTimeoutMs?: number;
  /** Observations longer than this are truncated. Default 30_000. */
  maxToolOutputChars?: number;
  toolChoice?: ResponsesRequest['tool_choice'];
  /**
   * Echo the assistant's message items back into the conversation. Default true,
   * which keeps the transcript coherent across steps.
   */
  echoAssistantMessages?: boolean;
  /**
   * Echo reasoning items back into the conversation. Default false: with
   * `store: false` the API rejects reasoning items unless
   * `include: ["reasoning.encrypted_content"]` is requested, which this option
   * adds automatically when enabled.
   */
  echoReasoningItems?: boolean;
  /** Default abort signal for every run. */
  signal?: AbortSignal;
  /** Diagnostic logger. */
  log?: (message: string) => void;
  /** Throw instead of reporting fatal errors through the event stream. */
  throwOnError?: boolean;
  /** Extra fields merged into every request (cannot override model/input/stream). */
  requestOverrides?: Partial<Omit<ResponsesRequest, 'model' | 'input' | 'stream'>>;
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Override `maxSteps` for this run. */
  maxSteps?: number;
}

/** Callback surface for {@link ReActAgent.runWithCallbacks}. */
export interface AgentHandlers {
  onEvent?: (event: AgentEvent) => void;
  onRunStart?: (event: Extract<AgentEvent, { type: 'run_start' }>) => void;
  onStepStart?: (event: Extract<AgentEvent, { type: 'step_start' }>) => void;
  onResponseStart?: (event: Extract<AgentEvent, { type: 'response_start' }>) => void;
  /** Incremental reasoning text. */
  onReasoningDelta?: (delta: string, event: Extract<AgentEvent, { type: 'reasoning_delta' }>) => void;
  onReasoningDone?: (text: string, event: Extract<AgentEvent, { type: 'reasoning_done' }>) => void;
  /** Incremental answer text. */
  onContentDelta?: (delta: string, event: Extract<AgentEvent, { type: 'content_delta' }>) => void;
  onContentDone?: (text: string, event: Extract<AgentEvent, { type: 'content_done' }>) => void;
  onRefusalDelta?: (delta: string, event: Extract<AgentEvent, { type: 'refusal_delta' }>) => void;
  onRefusalDone?: (text: string, event: Extract<AgentEvent, { type: 'refusal_done' }>) => void;
  /** The model opened a tool call, or streamed more of its arguments. */
  onToolCallDelta?: (event: Extract<AgentEvent, { type: 'tool_call_delta' }>) => void;
  /** A tool call completed and its arguments were parsed. */
  onToolCall?: (event: Extract<AgentEvent, { type: 'tool_call' }>) => void;
  /** A tool finished, successfully or not. */
  onToolResult?: (event: Extract<AgentEvent, { type: 'tool_result' }>) => void;
  onStepEnd?: (event: Extract<AgentEvent, { type: 'step_end' }>) => void;
  onRunEnd?: (event: RunEndEvent) => void;
  onError?: (event: Extract<AgentEvent, { type: 'error' }>) => void;
}

/** Build a `user` input item. */
export function userMessage(text: string): ResponseInputItem {
  return { type: 'message', role: 'user', content: [{ type: 'input_text', text }] };
}

/** Build an `assistant` input item, for replaying transcript turns. */
export function assistantMessage(text: string): ResponseInputItem {
  return { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
}

function isInputItem(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normalise caller input into Responses API input items. */
export function normalizeInput(input: AgentInput): ResponseInputItem[] {
  if (typeof input === 'string') return [userMessage(input)];
  if (Array.isArray(input)) {
    const items = input as readonly unknown[];
    if (items.length === 0) return [];
    // A list of plain strings is shorthand for several user messages.
    if (items.every((entry) => typeof entry === 'string')) {
      return (items as readonly string[]).map((text) => userMessage(text));
    }
    return items.filter(isInputItem) as ResponseInputItem[];
  }
  if (isInputItem(input)) return [input as ResponseInputItem];
  return [];
}

/** Concatenate the text of input items, for display on `run_start`. */
function flattenInputText(items: readonly ResponseInputItem[]): string {
  const pieces: string[] = [];
  for (const item of items) {
    if (item.type === 'message') {
      if (typeof item.content === 'string') {
        pieces.push(item.content);
        continue;
      }
      for (const part of item.content) {
        if (part.type === 'input_text' || part.type === 'output_text') pieces.push(part.text);
      }
    }
  }
  return pieces.join('\n');
}

function statusToStopReason(status: ResponseStatus): StopReason | undefined {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'incomplete':
      return 'incomplete';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'aborted';
    default:
      return undefined;
  }
}

export class ReActAgent {
  readonly #client: ResponsesClient;
  readonly #model: string;
  readonly #instructions: string | undefined;
  readonly #tools: ToolRegistry;
  readonly #maxSteps: number;
  readonly #reasoning: ReasoningConfig | undefined;
  readonly #temperature: number | undefined;
  readonly #topP: number | undefined;
  readonly #maxOutputTokens: number | undefined;
  readonly #store: boolean;
  readonly #parallelToolCalls: boolean;
  readonly #toolTimeoutMs: number | undefined;
  readonly #maxToolOutputChars: number | undefined;
  readonly #toolChoice: ResponsesRequest['tool_choice'];
  readonly #echoAssistantMessages: boolean;
  readonly #echoReasoningItems: boolean;
  readonly #signal: AbortSignal | undefined;
  readonly #log: ((message: string) => void) | undefined;
  readonly #throwOnError: boolean;
  readonly #requestOverrides: Partial<Omit<ResponsesRequest, 'model' | 'input' | 'stream'>>;

  constructor(options: ReActAgentOptions) {
    this.#client = options.client;
    this.#model = options.model;
    this.#instructions = options.instructions;
    this.#log = options.log;

    const registryOptions: { timeoutMs?: number; maxOutputChars?: number; log?: (m: string) => void } = {};

    if (options.toolTimeoutMs !== undefined)
      registryOptions.timeoutMs = options.toolTimeoutMs;
    if (options.maxToolOutputChars !== undefined)
      registryOptions.maxOutputChars = options.maxToolOutputChars;
    if (options.log !== undefined)
      registryOptions.log = options.log;

    this.#tools = ToolRegistry.from(options.tools, registryOptions);

    this.#maxSteps = options.maxSteps ?? 10;
    this.#reasoning = options.reasoning;
    this.#temperature = options.temperature;
    this.#topP = options.topP;
    this.#maxOutputTokens = options.maxOutputTokens;
    this.#store = options.store ?? false;
    this.#parallelToolCalls = options.parallelToolCalls ?? false;
    this.#toolTimeoutMs = options.toolTimeoutMs;
    this.#maxToolOutputChars = options.maxToolOutputChars;
    this.#toolChoice = options.toolChoice;
    this.#echoAssistantMessages = options.echoAssistantMessages ?? true;
    this.#echoReasoningItems = options.echoReasoningItems ?? false;
    this.#signal = options.signal;
    this.#throwOnError = options.throwOnError ?? false;
    this.#requestOverrides = options.requestOverrides ?? {};
  }

  /** The tool registry backing this agent. */
  get tools(): ToolRegistry {
    return this.#tools;
  }

  get model(): string {
    return this.#model;
  }

  /**
   * Run the loop, yielding every {@link AgentEvent} as it happens.
   *
   * The generator's **return value** is the aggregated {@link AgentResult}, so
   * either iterate it for live output or use {@link run} for the result alone.
   */
  async *stream(input: AgentInput, options: RunOptions = {}): AsyncGenerator<AgentEvent, AgentResult, void> {
    const runStartedAt = Date.now();
    const signal = options.signal ?? this.#signal;
    const maxSteps = options.maxSteps ?? this.#maxSteps;

    const conversation: ResponseInputItem[] = normalizeInput(input);
    const transcript: ResponseInputItem[] = [...conversation];

    const steps: AgentStep[] = [];
    const allToolCalls: AgentToolCall[] = [];
    const allToolResults: AgentToolResult[] = [];
    const allReasoning: AgentReasoningBlock[] = [];
    const responseIds: string[] = [];

    let usage = emptyUsage();
    let finalText = '';
    let stopReason: StopReason = 'completed';
    let runError: string | undefined;
    let currentStep = 0;

    yield {
      type: 'run_start',
      model: this.#model,
      tools: this.#tools.names(),
      maxSteps,
      input: flattenInputText(conversation),
    };

    try {
      for (let step = 1; ; step += 1) {
        if (step > maxSteps) {
          stopReason = 'max_steps';
          this.#log?.(`reached maxSteps (${maxSteps}) without a final answer`);
          break;
        }
        if (signal?.aborted === true) {
          stopReason = 'aborted';
          break;
        }

        currentStep = step;
        yield { type: 'step_start', step };
        const stepStartedAt = Date.now();

        // ---------------------------------------------------------------- //
        // Reason + Act: stream one model turn, routing each delta to its     //
        // channel as it arrives.                                             //
        // ---------------------------------------------------------------- //
        const accumulator = new TurnAccumulator(step);
        const request = this.#buildRequest(conversation);

        for await (const wireEvent of this.#client.stream(request, { signal })) {
          for (const event of accumulator.consume(wireEvent)) {
            yield event;
          }
        }
        // Flush anything the stream did not explicitly close out.
        for (const event of accumulator.finalize()) {
          yield event;
        }

        const snapshot = accumulator.snapshot();
        if (snapshot.responseId !== undefined)
          responseIds.push(snapshot.responseId);
        usage = addUsage(usage, snapshot.usage);
        allReasoning.push(...snapshot.reasoning);
        if (snapshot.text.length > 0)
          finalText = snapshot.text;
        if (snapshot.error !== undefined)
          runError ??= snapshot.error;

        // Append the assistant turn so follow-up calls see what the model said.
        const assistantItems = this.#assistantItems(snapshot.outputItems);
        conversation.push(...assistantItems);
        transcript.push(...assistantItems);

        // ---------------------------------------------------------------- //
        // Observe: run tools, stream the results, feed them back.            //
        // ---------------------------------------------------------------- //
        let stepToolResults: AgentToolResult[] = [];
        if (snapshot.toolCalls.length > 0) {
          stepToolResults = yield* this.#executeToolCalls(snapshot.toolCalls, step, signal);

          for (const call of snapshot.toolCalls) {
            const result = stepToolResults.find((entry) => entry.callId === call.callId);
            const output: ResponseInputItem = {
              type: 'function_call_output',
              call_id: call.callId,
              output: result?.output ?? 'null',
            };
            conversation.push(output);
            transcript.push(output);
          }
        }

        const stepRecord: AgentStep = {
          index: step,
          responseId: snapshot.responseId,
          status: snapshot.status,
          reasoning: snapshot.reasoning,
          reasoningText: snapshot.reasoningText,
          text: snapshot.text,
          refusal: snapshot.refusal,
          toolCalls: snapshot.toolCalls,
          toolResults: stepToolResults,
          usage: snapshot.usage,
          durationMs: Date.now() - stepStartedAt,
        };
        steps.push(stepRecord);
        allToolCalls.push(...snapshot.toolCalls);
        allToolResults.push(...stepToolResults);

        const stepEnd: StepEndEvent = {
          type: 'step_end',
          step,
          responseId: snapshot.responseId,
          status: snapshot.status,
          text: snapshot.text,
          reasoning: snapshot.reasoningText,
          toolCalls: snapshot.toolCalls,
          toolResults: stepToolResults,
          usage: snapshot.usage,
          durationMs: stepRecord.durationMs,
        };
        if (snapshot.responseId !== undefined) stepEnd.responseId = snapshot.responseId;
        if (snapshot.usage !== undefined) stepEnd.usage = snapshot.usage;
        yield stepEnd;

        if (snapshot.toolCalls.length === 0) {
          const mapped = statusToStopReason(snapshot.status);
          if (mapped !== undefined) {
            stopReason = mapped;
          } else {
            // The stream ended without a terminal `response.completed` event.
            const producedSomething = snapshot.text.length > 0 || snapshot.refusal.length > 0;
            stopReason = producedSomething ? 'completed' : 'failed';
            if (!producedSomething) {
              runError ??= 'The stream ended without a terminal event and produced no output';
            }
          }
          break;
        }
        // Tool calls were made: loop for another Reason step.
      }
    } catch (error) {
      const message = errorMessage(error);
      const isApiError = error instanceof OpenAIError;
      runError = message;
      stopReason = signal?.aborted === true ? 'aborted' : 'failed';
      yield {
        type: 'error',
        step: currentStep === 0 ? undefined : currentStep,
        message,
        code: isApiError ? error.code : undefined,
        fatal: true,
        retryable: isApiError ? error.retryable : false,
      };
      if (this.#throwOnError) throw error;
    }

    const result: AgentResult = {
      text: finalText,
      reasoning: allReasoning,
      reasoningText: allReasoning.map((block) => block.text).join('\n\n'),
      steps,
      toolCalls: allToolCalls,
      toolResults: allToolResults,
      usage,
      stopReason,
      responseIds,
      messages: transcript,
      durationMs: Date.now() - runStartedAt,
    };
    if (runError !== undefined) result.error = runError;

    const runEnd: RunEndEvent = {
      type: 'run_end',
      steps: steps.length,
      stopReason,
      text: result.text,
      reasoning: result.reasoningText,
      usage,
      durationMs: result.durationMs,
    };
    if (runError !== undefined) runEnd.error = runError;
    yield runEnd;

    return result;
  }

  /** Run the loop to completion and return the aggregated result. */
  async run(input: AgentInput, options: RunOptions = {}): Promise<AgentResult> {
    const iterator = this.stream(input, options);
    for (; ;) {
      const next = await iterator.next();
      if (next.done === true) return next.value;
    }
  }

  /**
   * Run the loop, dispatching typed callbacks instead of raw events.
   *
   * This is the most convenient form when reasoning, content and tool calls need
   * to go to three different places (panes, logs, files, …).
   */
  async runWithCallbacks(
    input: AgentInput,
    handlers: AgentHandlers = {},
    options: RunOptions = {},
  ): Promise<AgentResult> {
    const iterator = this.stream(input, options);
    for (; ;) {
      const next = await iterator.next();
      if (next.done === true) return next.value;

      const event = next.value;
      handlers.onEvent?.(event);

      switch (event.type) {
        case 'run_start':
          handlers.onRunStart?.(event);
          break;
        case 'step_start':
          handlers.onStepStart?.(event);
          break;
        case 'response_start':
          handlers.onResponseStart?.(event);
          break;
        case 'reasoning_delta':
          handlers.onReasoningDelta?.(event.delta, event);
          break;
        case 'reasoning_done':
          handlers.onReasoningDone?.(event.text, event);
          break;
        case 'content_delta':
          handlers.onContentDelta?.(event.delta, event);
          break;
        case 'content_done':
          handlers.onContentDone?.(event.text, event);
          break;
        case 'refusal_delta':
          handlers.onRefusalDelta?.(event.delta, event);
          break;
        case 'refusal_done':
          handlers.onRefusalDone?.(event.text, event);
          break;
        case 'tool_call_delta':
          handlers.onToolCallDelta?.(event);
          break;
        case 'tool_call':
          handlers.onToolCall?.(event);
          break;
        case 'tool_result':
          handlers.onToolResult?.(event);
          break;
        case 'step_end':
          handlers.onStepEnd?.(event);
          break;
        case 'run_end':
          handlers.onRunEnd?.(event);
          break;
        case 'error':
          handlers.onError?.(event);
          break;
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  #buildRequest(conversation: readonly ResponseInputItem[]): Omit<ResponsesRequest, 'stream'> {
    const request: Omit<ResponsesRequest, 'stream'> = {
      ...this.#requestOverrides,
      model: this.#model,
      input: [...conversation],
    };

    if (this.#instructions !== undefined) request.instructions = this.#instructions;
    if (this.#reasoning !== undefined) request.reasoning = this.#reasoning;
    if (this.#temperature !== undefined) request.temperature = this.#temperature;
    if (this.#topP !== undefined) request.top_p = this.#topP;
    if (this.#maxOutputTokens !== undefined) request.max_output_tokens = this.#maxOutputTokens;
    request.store = this.#store;

    const tools = this.#tools.toFunctionTools();
    if (tools.length > 0) {
      request.tools = tools;
      request.parallel_tool_calls = this.#parallelToolCalls;
      if (this.#toolChoice !== undefined) request.tool_choice = this.#toolChoice;
    }

    if (this.#echoReasoningItems && !this.#store) {
      // Required for reasoning items to be accepted back with store: false.
      request.include = [...(request.include ?? []), 'reasoning.encrypted_content'];
    }

    return request;
  }

  /** Decide which assistant items are fed back into the conversation. */
  #assistantItems(items: readonly ResponseInputItem[]): ResponseInputItem[] {
    const out: ResponseInputItem[] = [];
    for (const item of items) {
      if (item.type === 'function_call') {
        out.push(item);
        continue;
      }
      if (item.type === 'reasoning') {
        if (this.#echoReasoningItems) out.push(item);
        continue;
      }
      if (item.type === 'message') {
        if (!this.#echoAssistantMessages) continue;
        // Rebuild a minimal input item: the wire item carries output-only
        // fields (status, id) that are not meaningful as input.
        const text =
          typeof item.content === 'string'
            ? item.content
            : item.content
              .filter((part) => part.type === 'input_text' || part.type === 'output_text')
              .map((part) => part.text)
              .join('');
        if (text.length === 0) continue;
        out.push(assistantMessage(text));
      }
    }
    return out;
  }

  /**
   * Execute every tool call for a step.
   *
   * In parallel mode the calls start together but results are still yielded in
   * call order, keeping the event stream deterministic.
   */
  async *#executeToolCalls(
    calls: readonly AgentToolCall[],
    step: number,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<ToolResultEvent, AgentToolResult[], void> {
    const executeOptions: {
      step: number;
      signal?: AbortSignal;
      timeoutMs?: number;
      maxOutputChars?: number;
      log?: (message: string) => void;
    } = { step };
    if (signal !== undefined) executeOptions.signal = signal;
    if (this.#toolTimeoutMs !== undefined) executeOptions.timeoutMs = this.#toolTimeoutMs;
    if (this.#maxToolOutputChars !== undefined) executeOptions.maxOutputChars = this.#maxToolOutputChars;
    if (this.#log !== undefined) executeOptions.log = this.#log;

    const invoke = async (call: AgentToolCall): Promise<AgentToolResult> => {
      const invocation: { callId: string; name: string; arguments: string; args: unknown; parseError?: string } = {
        callId: call.callId,
        name: call.name,
        arguments: call.arguments,
        args: call.args,
      };
      if (call.parseError !== undefined) invocation.parseError = call.parseError;
      return this.#tools.execute(invocation, executeOptions);
    };

    const results: AgentToolResult[] = [];

    if (this.#parallelToolCalls && calls.length > 1) {
      // Start all calls eagerly, then drain in order.
      const pending = calls.map((call) => invoke(call));
      for (const promise of pending) {
        const result = await promise;
        results.push(result);
        yield { type: 'tool_result', step, ...result };
      }
      return results;
    }

    for (const call of calls) {
      const result = await invoke(call);
      results.push(result);
      yield { type: 'tool_result', step, ...result };
    }
    return results;
  }
}

/** Convenience factory. */
export function createAgent(options: ReActAgentOptions): ReActAgent {
  return new ReActAgent(options);
}
