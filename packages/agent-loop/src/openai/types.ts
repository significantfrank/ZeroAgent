/**
 * Wire-level types for the OpenAI **Responses API** (`POST /v1/responses`).
 *
 * Only the parts this agent actually relies on are modelled. Anything the API
 * may add later is handled gracefully by the client: unknown event types are
 * never surfaced as typed events, so a `switch` over `ResponseStreamEvent`
 * stays exhaustive and safe.
 */

/* -------------------------------------------------------------------------- */
/* Usage                                                                      */
/* -------------------------------------------------------------------------- */

export interface ResponseUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

/* -------------------------------------------------------------------------- */
/* Output items                                                               */
/* -------------------------------------------------------------------------- */

export interface ReasoningSummaryPart {
  type: 'summary_text';
  text: string;
}

export interface ReasoningTextPart {
  type: 'reasoning_text';
  text: string;
}

/**
 * A `reasoning` item.
 *
 * `summary` holds the model's human-readable reasoning summary (populated when
 * `reasoning.summary` is requested). `content` holds raw reasoning text, which
 * only some models/orgs expose.
 */
export interface ReasoningItem {
  type: 'reasoning';
  id: string;
  summary?: ReasoningSummaryPart[];
  content?: ReasoningTextPart[];
  encrypted_content?: string | null;
  status?: string;
}

export interface OutputTextPart {
  type: 'output_text';
  text: string;
  annotations?: unknown[];
  logprobs?: unknown[];
}

export interface RefusalPart {
  type: 'refusal';
  refusal: string;
}

export interface MessageItem {
  type: 'message';
  id: string;
  role: 'assistant';
  status?: 'in_progress' | 'completed' | 'incomplete';
  content?: Array<OutputTextPart | RefusalPart>;
}

export interface FunctionCallItem {
  type: 'function_call';
  /** Item id (`fc_...`). Referenced by `item_id` on argument delta events. */
  id?: string;
  /** Correlation id (`call_...`) used to match a `function_call_output`. */
  call_id: string;
  name: string;
  /** JSON-encoded arguments, as produced incrementally by the model. */
  arguments: string;
  status?: 'in_progress' | 'completed' | 'incomplete';
}

/** An output item shape this library does not model (e.g. built-in tools). */
export interface UnknownOutputItem {
  type: string;
  [key: string]: unknown;
}

/** Union of the output items the agent understands. */
export type ResponseOutputItem = ReasoningItem | MessageItem | FunctionCallItem;

/** Any output item, including shapes this library does not model. */
export type AnyResponseOutputItem = ResponseOutputItem | UnknownOutputItem;

/* -------------------------------------------------------------------------- */
/* Input items                                                                */
/* -------------------------------------------------------------------------- */

export interface InputTextContent {
  type: 'input_text';
  text: string;
}

/**
 * Assistant turns are replayed using the `output_text` part type, mirroring the
 * items the server itself returns in `response.output`.
 */
export interface OutputTextContent {
  type: 'output_text';
  text: string;
}

export interface InputMessageItem {
  type?: 'message';
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string | Array<InputTextContent | OutputTextContent>;
}

/** Returned to the model as the observation for a tool call. */
export interface FunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export type ResponseInputItem =
  | InputMessageItem
  | FunctionCallItem
  | FunctionCallOutputItem
  | ReasoningItem;

/* -------------------------------------------------------------------------- */
/* Request                                                                    */
/* -------------------------------------------------------------------------- */

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';
export type ReasoningSummary = 'auto' | 'concise' | 'detailed';

/**
 * A function tool in the **Responses** format.
 *
 * Note this is flat (`{ type, name, description, parameters }`), unlike the
 * nested `{ type, function: { ... } }` shape used by Chat Completions.
 */
export interface FunctionTool {
  type: 'function';
  name: string;
  description?: string;
  parameters: Record<string, unknown> | null;
  strict?: boolean;
}

export interface ReasoningConfig {
  effort?: ReasoningEffort;
  summary?: ReasoningSummary;
}

export interface ResponsesRequest {
  model: string;
  input: string | ResponseInputItem[];
  instructions?: string;
  tools?: FunctionTool[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; name: string };
  parallel_tool_calls?: boolean;
  reasoning?: ReasoningConfig;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  /** When false the response is not persisted server-side (stateless usage). */
  store?: boolean;
  stream?: boolean;
  include?: string[];
  metadata?: Record<string, string>;
  previous_response_id?: string;
  truncation?: 'auto' | 'disabled';
}

/* -------------------------------------------------------------------------- */
/* Response resource                                                          */
/* -------------------------------------------------------------------------- */

export type ResponseStatus =
  | 'completed'
  | 'failed'
  | 'incomplete'
  | 'in_progress'
  | 'queued'
  | 'cancelled';

export interface ResponseResource {
  id: string;
  object?: string;
  created_at?: number;
  model?: string;
  status: ResponseStatus;
  output: AnyResponseOutputItem[];
  output_text?: string;
  usage?: ResponseUsage | null;
  error?: { code?: string | null; message: string } | null;
  incomplete_details?: { reason?: string } | null;
  instructions?: string | null;
  reasoning?: ReasoningConfig | null;
}

/* -------------------------------------------------------------------------- */
/* Streaming events                                                           */
/* -------------------------------------------------------------------------- */

export interface ResponseCreatedEvent {
  type: 'response.created';
  sequence_number?: number;
  response: ResponseResource;
}

export interface ResponseInProgressEvent {
  type: 'response.in_progress';
  sequence_number?: number;
  response: ResponseResource;
}

export interface ResponseOutputItemAddedEvent {
  type: 'response.output_item.added';
  sequence_number?: number;
  output_index: number;
  item: AnyResponseOutputItem;
}

export interface ResponseOutputItemDoneEvent {
  type: 'response.output_item.done';
  sequence_number?: number;
  output_index: number;
  item: AnyResponseOutputItem;
}

export interface ResponseContentPartAddedEvent {
  type: 'response.content_part.added';
  sequence_number?: number;
  item_id: string;
  output_index: number;
  content_index: number;
  part: OutputTextPart | RefusalPart;
}

export interface ResponseContentPartDoneEvent {
  type: 'response.content_part.done';
  sequence_number?: number;
  item_id: string;
  output_index: number;
  content_index: number;
  part: OutputTextPart | RefusalPart;
}

export interface ResponseOutputTextDeltaEvent {
  type: 'response.output_text.delta';
  sequence_number?: number;
  item_id: string;
  output_index: number;
  content_index: number;
  delta: string;
  logprobs?: unknown[];
}

export interface ResponseOutputTextDoneEvent {
  type: 'response.output_text.done';
  sequence_number?: number;
  item_id: string;
  output_index: number;
  content_index: number;
  text: string;
  logprobs?: unknown[];
}

export interface ResponseRefusalDeltaEvent {
  type: 'response.refusal.delta';
  sequence_number?: number;
  item_id: string;
  output_index: number;
  content_index: number;
  delta: string;
}

export interface ResponseRefusalDoneEvent {
  type: 'response.refusal.done';
  sequence_number?: number;
  item_id: string;
  output_index: number;
  content_index: number;
  refusal: string;
}

export interface ResponseReasoningSummaryPartAddedEvent {
  type: 'response.reasoning_summary_part.added';
  sequence_number?: number;
  item_id: string;
  output_index: number;
  summary_index: number;
  part: ReasoningSummaryPart;
}

export interface ResponseReasoningSummaryPartDoneEvent {
  type: 'response.reasoning_summary_part.done';
  sequence_number?: number;
  item_id: string;
  output_index: number;
  summary_index: number;
  part: ReasoningSummaryPart;
}

export interface ResponseReasoningSummaryTextDeltaEvent {
  type: 'response.reasoning_summary_text.delta';
  sequence_number?: number;
  item_id: string;
  output_index: number;
  summary_index: number;
  delta: string;
}

export interface ResponseReasoningSummaryTextDoneEvent {
  type: 'response.reasoning_summary_text.done';
  sequence_number?: number;
  item_id: string;
  output_index: number;
  summary_index: number;
  text: string;
}

/** Raw (un-summarised) reasoning text — only emitted by some model/org combos. */
export interface ResponseReasoningTextDeltaEvent {
  type: 'response.reasoning_text.delta';
  sequence_number?: number;
  item_id: string;
  output_index: number;
  content_index: number;
  delta: string;
}

export interface ResponseReasoningTextDoneEvent {
  type: 'response.reasoning_text.done';
  sequence_number?: number;
  item_id: string;
  output_index: number;
  content_index: number;
  text: string;
}

export interface ResponseFunctionCallArgumentsDeltaEvent {
  type: 'response.function_call_arguments.delta';
  sequence_number?: number;
  item_id: string;
  output_index: number;
  delta: string;
}

export interface ResponseFunctionCallArgumentsDoneEvent {
  type: 'response.function_call_arguments.done';
  sequence_number?: number;
  item_id: string;
  output_index: number;
  name?: string;
  arguments: string;
}

export interface ResponseCompletedEvent {
  type: 'response.completed';
  sequence_number?: number;
  response: ResponseResource;
}

export interface ResponseFailedEvent {
  type: 'response.failed';
  sequence_number?: number;
  response: ResponseResource;
}

export interface ResponseIncompleteEvent {
  type: 'response.incomplete';
  sequence_number?: number;
  response: ResponseResource;
}

/** Mid-stream error frame. */
export interface ResponseErrorEvent {
  type: 'error';
  sequence_number?: number;
  code?: string | null;
  message: string;
  param?: string | null;
}

/** Discriminated union of every stream event this library models. */
export type ResponseStreamEvent =
  | ResponseCreatedEvent
  | ResponseInProgressEvent
  | ResponseOutputItemAddedEvent
  | ResponseOutputItemDoneEvent
  | ResponseContentPartAddedEvent
  | ResponseContentPartDoneEvent
  | ResponseOutputTextDeltaEvent
  | ResponseOutputTextDoneEvent
  | ResponseRefusalDeltaEvent
  | ResponseRefusalDoneEvent
  | ResponseReasoningSummaryPartAddedEvent
  | ResponseReasoningSummaryPartDoneEvent
  | ResponseReasoningSummaryTextDeltaEvent
  | ResponseReasoningSummaryTextDoneEvent
  | ResponseReasoningTextDeltaEvent
  | ResponseReasoningTextDoneEvent
  | ResponseFunctionCallArgumentsDeltaEvent
  | ResponseFunctionCallArgumentsDoneEvent
  | ResponseCompletedEvent
  | ResponseFailedEvent
  | ResponseIncompleteEvent
  | ResponseErrorEvent;

export type ResponseStreamEventType = ResponseStreamEvent['type'];

/** Every event `type` in {@link ResponseStreamEvent}, for runtime filtering. */
export const KNOWN_RESPONSE_EVENT_TYPES: ReadonlySet<string> = new Set<ResponseStreamEventType>([
  'response.created',
  'response.in_progress',
  'response.output_item.added',
  'response.output_item.done',
  'response.content_part.added',
  'response.content_part.done',
  'response.output_text.delta',
  'response.output_text.done',
  'response.refusal.delta',
  'response.refusal.done',
  'response.reasoning_summary_part.added',
  'response.reasoning_summary_part.done',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done',
  'response.reasoning_text.delta',
  'response.reasoning_text.done',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
  'response.completed',
  'response.failed',
  'response.incomplete',
  'error',
]);

/**
 * Narrow a decoded SSE payload to a modelled event.
 *
 * Returns undefined for anything without a recognised `type`, which lets the
 * caller report it through an `onUnknownEvent` hook instead of crashing.
 */
export function asResponseStreamEvent(payload: unknown): ResponseStreamEvent | undefined {
  if (typeof payload !== 'object' || payload === null) 
    return undefined;
  const type = (payload as { type?: unknown }).type;
  if (typeof type !== 'string' || !KNOWN_RESPONSE_EVENT_TYPES.has(type)) 
    return undefined;
  return payload as ResponseStreamEvent;
}

/**
 * Narrow `type` against a payload as narrow as the SSE data itself.
 *
 * Emitted by the API as one JSON object per `data:` line.
 */
export type RawStreamPayload = Record<string, unknown> & { type?: unknown };

/* -------------------------------------------------------------------------- */
/* Output item type guards                                                    */
/* -------------------------------------------------------------------------- */

export function isReasoningItem(item: AnyResponseOutputItem): item is ReasoningItem {
  return item.type === 'reasoning';
}

export function isMessageItem(item: AnyResponseOutputItem): item is MessageItem {
  return item.type === 'message';
}

export function isFunctionCallItem(item: AnyResponseOutputItem): item is FunctionCallItem {
  return item.type === 'function_call';
}
