/**
 * The agent's streaming vocabulary.
 *
 * Everything the loop emits is a member of the {@link AgentEvent} discriminated
 * union, so a consumer can render reasoning, answer text and tool activity into
 * separate places simply by switching on `event.type` — and TypeScript will
 * narrow the payload for each branch.
 *
 * The coarse grouping is exposed by {@link channelOf}, which maps every event to
 * one of six channels. That is the recommended way to route output:
 *
 * ```ts
 * for await (const event of agent.stream('What is 2+2?')) {
 *   switch (channelOf(event)) {
 *     case 'reasoning':  write(dim(event.delta)); break;   // "thinking"
 *     case 'content':    write(event.delta); break;        // the answer
 *     case 'tool_call':  write(toolLine(event)); break;    // the action
 *     case 'tool_result':write(observationLine(event)); break;
 *     default: break;                                      // status / errors
 *   }
 * }
 * ```
 */

import type { ResponseInputItem, ResponseStatus, ResponseUsage } from '../openai/types.ts';

/* -------------------------------------------------------------------------- */
/* Shared shapes                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Coarse output channel, used to route events to different destinations.
 *
 * - `reasoning`   — the model's thinking (summary or raw), never the answer.
 * - `content`     — assistant-visible text (answer text and refusals).
 * - `tool_call`   — the model asking for a tool, including argument deltas.
 * - `tool_result` — the observation produced by running a tool.
 * - `status`      — lifecycle/progress notifications.
 * - `error`       — recoverable or fatal failures.
 */
export type AgentChannel = 'reasoning' | 'content' | 'tool_call' | 'tool_result' | 'status' | 'error';

/** Why the run ended. */
export type StopReason = 'completed' | 'incomplete' | 'failed' | 'max_steps' | 'aborted';

/**
 * Which flavour of reasoning a delta carries.
 *
 * `summary` is the model-generated summary of its reasoning; `text` is raw
 * reasoning content, which only some models expose.
 */
export type ReasoningPartKind = 'summary' | 'text';

/** A single tool invocation requested by the model. */
export interface AgentToolCall {
  /** Correlation id echoed back in `function_call_output`. */
  callId: string;
  /** Item id of the underlying `function_call` item, when the API sent one. */
  itemId?: string;
  name: string;
  /** Raw JSON string as produced by the model. */
  arguments: string;
  /** Parsed arguments; undefined when `arguments` was not valid JSON. */
  args: unknown;
  /** Set when `arguments` could not be parsed or failed validation. */
  parseError?: string;
}

/** The observation produced by executing a {@link AgentToolCall}. */
export interface AgentToolResult {
  callId: string;
  name: string;
  /** False when the tool threw, timed out, was unknown, or had bad arguments. */
  ok: boolean;
  /** Stringified observation handed back to the model. */
  output: string;
  /** Error message when `ok` is false. */
  error?: string;
  /** Parsed arguments the tool was invoked with, when available. */
  args?: unknown;
  durationMs: number;
}

/** One completed reasoning block (a summary part or a raw reasoning part). */
export interface AgentReasoningBlock {
  itemId: string;
  outputIndex: number;
  part: ReasoningPartKind;
  text: string;
}

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

/** Emitted once, before the first step. */
export interface RunStartEvent {
  type: 'run_start';
  model: string;
  tools: string[];
  maxSteps: number;
  /** The user input that started the run, flattened to text for display. */
  input: string;
}

/** Emitted at the top of every loop iteration. */
export interface StepStartEvent {
  type: 'step_start';
  /** 1-based step index. */
  step: number;
}

/** Emitted when the model request for this step starts producing events. */
export interface ResponseStartEvent {
  type: 'response_start';
  step: number;
  responseId?: string;
  model?: string;
}

/** Incremental reasoning text. **Channel: `reasoning`.** */
export interface ReasoningDeltaEvent {
  type: 'reasoning_delta';
  step: number;
  itemId: string;
  outputIndex: number;
  part: ReasoningPartKind;
  /** The new text in this chunk. */
  delta: string;
  /** All reasoning text accumulated for this item+part so far. */
  text: string;
}

/** A reasoning block finished. **Channel: `reasoning`.** */
export interface ReasoningDoneEvent {
  type: 'reasoning_done';
  step: number;
  itemId: string;
  outputIndex: number;
  part: ReasoningPartKind;
  /** Full text of the block. */
  text: string;
}

/** Incremental answer text. **Channel: `content`.** */
export interface ContentDeltaEvent {
  type: 'content_delta';
  step: number;
  itemId: string;
  outputIndex: number;
  /** The new text in this chunk. */
  delta: string;
  /** All answer text accumulated so far in this step. */
  text: string;
}

/** An answer text block finished. **Channel: `content`.** */
export interface ContentDoneEvent {
  type: 'content_done';
  step: number;
  itemId: string;
  outputIndex: number;
  text: string;
}

/** Incremental refusal text. Streamed on the `content` channel. */
export interface RefusalDeltaEvent {
  type: 'refusal_delta';
  step: number;
  itemId: string;
  outputIndex: number;
  delta: string;
  text: string;
}

/** A refusal finished. Streamed on the `content` channel. */
export interface RefusalDoneEvent {
  type: 'refusal_done';
  step: number;
  itemId: string;
  outputIndex: number;
  text: string;
}

/**
 * Incremental tool-call activity. **Channel: `tool_call`.**
 *
 * A first event is emitted as soon as the model opens a function call (with an
 * empty `argsDelta`), so a UI can show "calling `search`…" before any arguments
 * have streamed.
 */
export interface ToolCallDeltaEvent {
  type: 'tool_call_delta';
  step: number;
  itemId: string;
  outputIndex: number;
  callId: string;
  name: string;
  /** The new argument text in this chunk. */
  argsDelta: string;
  /** All argument text accumulated so far. */
  arguments: string;
}

/** A tool call is complete and its arguments have been parsed. **Channel: `tool_call`.** */
export interface ToolCallEvent {
  type: 'tool_call';
  step: number;
  itemId: string;
  outputIndex: number;
  callId: string;
  name: string;
  arguments: string;
  /** Parsed arguments, or undefined when parsing/validation failed. */
  args: unknown;
  /** Why parsing failed, when it did. The tool will still be called with a hint. */
  parseError?: string;
}

/** The observation returned by a tool. **Channel: `tool_result`.** */
export interface ToolResultEvent {
  type: 'tool_result';
  step: number;
  callId: string;
  name: string;
  ok: boolean;
  output: string;
  error?: string;
  args?: unknown;
  durationMs: number;
}

/** End of a step, summarising what the model did. **Channel: `status`.** */
export interface StepEndEvent {
  type: 'step_end';
  step: number;
  responseId?: string;
  status: ResponseStatus;
  /** Answer text produced in this step. */
  text: string;
  /** Reasoning text produced in this step (summary + raw, concatenated). */
  reasoning: string;
  toolCalls: AgentToolCall[];
  toolResults: AgentToolResult[];
  usage?: ResponseUsage;
  durationMs: number;
}

/** Terminal event for the run. **Channel: `status`.** */
export interface RunEndEvent {
  type: 'run_end';
  steps: number;
  stopReason: StopReason;
  /** Final answer text. */
  text: string;
  /** All reasoning text across the run. */
  reasoning: string;
  usage: ResponseUsage;
  durationMs: number;
  /** Populated when `stopReason` is `failed`. */
  error?: string;
}

/** A failure. **Channel: `error`.** */
export interface AgentErrorEvent {
  type: 'error';
  step?: number;
  message: string;
  code?: string;
  /** True when the run cannot continue. */
  fatal: boolean;
  /** Whether a retry of the same request might succeed. */
  retryable: boolean;
}

/** Every event the agent can emit. */
export type AgentEvent =
  | RunStartEvent
  | StepStartEvent
  | ResponseStartEvent
  | ReasoningDeltaEvent
  | ReasoningDoneEvent
  | ContentDeltaEvent
  | ContentDoneEvent
  | RefusalDeltaEvent
  | RefusalDoneEvent
  | ToolCallDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | StepEndEvent
  | RunEndEvent
  | AgentErrorEvent;

export type AgentEventType = AgentEvent['type'];

/** Events carrying incremental text, i.e. the streaming output surface. */
export type AgentDeltaEvent =
  | ReasoningDeltaEvent
  | ContentDeltaEvent
  | RefusalDeltaEvent
  | ToolCallDeltaEvent;

/* -------------------------------------------------------------------------- */
/* Channel routing                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Map an event to its coarse output channel.
 *
 * Exhaustive over {@link AgentEvent}: adding an event type without classifying
 * it is a compile error.
 */
export function channelOf(event: AgentEvent): AgentChannel {
  switch (event.type) {
    case 'reasoning_delta':
    case 'reasoning_done':
      return 'reasoning';
    case 'content_delta':
    case 'content_done':
    // A refusal is assistant-visible text, so it shares the content channel.
    case 'refusal_delta':
    case 'refusal_done':
      return 'content';
    case 'tool_call_delta':
    case 'tool_call':
      return 'tool_call';
    case 'tool_result':
      return 'tool_result';
    case 'run_start':
    case 'step_start':
    case 'response_start':
    case 'step_end':
    case 'run_end':
      return 'status';
    case 'error':
      return 'error';
  }
}

/** True for events on the reasoning channel. */
export function isReasoningEvent(
  event: AgentEvent,
): event is ReasoningDeltaEvent | ReasoningDoneEvent {
  return event.type === 'reasoning_delta' || event.type === 'reasoning_done';
}

/** True for events on the content channel. */
export function isContentEvent(
  event: AgentEvent,
): event is ContentDeltaEvent | ContentDoneEvent {
  return event.type === 'content_delta' || event.type === 'content_done';
}

/** True for events on the tool-call channel. */
export function isToolCallEvent(
  event: AgentEvent,
): event is ToolCallDeltaEvent | ToolCallEvent {
  return event.type === 'tool_call_delta' || event.type === 'tool_call';
}

/**
 * Extract the incremental text an event contributes to its channel.
 *
 * Returns undefined for events that carry no new text (lifecycle events, and
 * tool-call events on their "call opened" frame).
 */
export function displayText(event: AgentEvent): string | undefined {
  switch (event.type) {
    case 'reasoning_delta':
    case 'content_delta':
    case 'refusal_delta':
      return event.delta;
    case 'tool_call_delta':
      return event.argsDelta.length > 0 ? event.argsDelta : undefined;
    default:
      return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Aggregated results                                                         */
/* -------------------------------------------------------------------------- */

/** Everything that happened during one ReAct step (one model call). */
export interface AgentStep {
  /** 1-based. */
  index: number;
  responseId?: string;
  status: ResponseStatus;
  reasoning: AgentReasoningBlock[];
  /** Concatenated reasoning text for this step. */
  reasoningText: string;
  text: string;
  refusal: string;
  toolCalls: AgentToolCall[];
  toolResults: AgentToolResult[];
  usage?: ResponseUsage;
  durationMs: number;
}

/**
 * The full outcome of a run, returned from `agent.run()` and as the return
 * value of the `agent.stream()` generator.
 */
export interface AgentResult {
  /** Final assistant answer text. */
  text: string;
  /** Every reasoning block produced during the run. */
  reasoning: AgentReasoningBlock[];
  /** Concatenated reasoning text across the run. */
  reasoningText: string;
  steps: AgentStep[];
  toolCalls: AgentToolCall[];
  toolResults: AgentToolResult[];
  usage: ResponseUsage;
  stopReason: StopReason;
  responseIds: string[];
  /**
   * Full conversation as Responses API input items, including the assistant
   * output items and the `function_call_output` observations. Append a new user
   * message and pass it back to `run()` to continue the conversation.
   */
  messages: ResponseInputItem[];
  durationMs: number;
  error?: string;
}

/** Add two usage records together. */
export function addUsage(a: ResponseUsage, b: ResponseUsage | undefined): ResponseUsage {
  if (b === undefined) return a;
  const sum: ResponseUsage = {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
  };
  const cached = (a.input_tokens_details?.cached_tokens ?? 0) + (b.input_tokens_details?.cached_tokens ?? 0);
  if (cached > 0) sum.input_tokens_details = { cached_tokens: cached };
  const reasoning =
    (a.output_tokens_details?.reasoning_tokens ?? 0) + (b.output_tokens_details?.reasoning_tokens ?? 0);
  if (reasoning > 0) sum.output_tokens_details = { reasoning_tokens: reasoning };
  return sum;
}

/** A zeroed usage record. */
export function emptyUsage(): ResponseUsage {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
}
