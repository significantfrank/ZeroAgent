/**
 * Turns a raw {@link ResponseStreamEvent} stream into {@link AgentEvent}s.
 *
 * This is where the three output kinds are actually separated. The Responses API
 * multiplexes reasoning, answer text and tool calls onto a single SSE stream
 * (distinguished by event name plus `output_index`/`item_id`), and this class
 * tracks per-item state so each delta is attributed to the right item and
 * surfaced on the right channel.
 *
 * Robustness rules applied here:
 *
 * - Deltas for an item that was never announced are still handled, by inferring
 *   the item kind from the event name.
 * - `*_done` events and `response.completed` both act as finalisers, so a
 *   truncated stream still yields complete reasoning/content/tool-call events.
 * - `response.output` is treated as the source of truth when available; locally
 *   accumulated deltas are the fallback.
 */

import {
  isFunctionCallItem,
  isMessageItem,
  isReasoningItem,
} from '../openai/types.ts';
import type {
  AnyResponseOutputItem,
  ResponseInputItem,
  ResponseResource,
  ResponseStatus,
  ResponseStreamEvent,
  ResponseUsage,
} from '../openai/types.ts';
import type {
  AgentEvent,
  AgentReasoningBlock,
  AgentToolCall,
  ContentDeltaEvent,
  ContentDoneEvent,
  ReasoningDeltaEvent,
  ReasoningDoneEvent,
  ReasoningPartKind,
  RefusalDeltaEvent,
  RefusalDoneEvent,
  ToolCallDeltaEvent,
  ToolCallEvent,
} from './events.ts';

type ItemKind = 'reasoning' | 'message' | 'function_call' | 'other';

interface ContentPartState {
  kind: 'text' | 'refusal';
  text: string;
}

interface ItemState {
  itemId: string;
  outputIndex: number;
  kind: ItemKind;
  /** For reasoning items: keyed by `summary:0` / `text:0`. */
  reasoningParts: Map<string, { part: ReasoningPartKind; index: number; text: string }>;
  /** For message items: keyed by content index. */
  contentParts: Map<number, ContentPartState>;
  /** Part keys that already produced a `*_done` event. */
  doneEmitted: Set<string>;
  /** Function-call fields. */
  callId: string | undefined;
  name: string | undefined;
  args: string;
  callEmitted: boolean;
  /** Original wire item, when one was received. */
  wire: AnyResponseOutputItem | undefined;
}

/** Aggregated view of one model turn. */
export interface TurnSnapshot {
  responseId: string | undefined;
  model: string | undefined;
  status: ResponseStatus;
  /** Answer text. */
  text: string;
  /** Refusal text, if the model refused. */
  refusal: string;
  reasoning: AgentReasoningBlock[];
  reasoningText: string;
  toolCalls: AgentToolCall[];
  usage: ResponseUsage | undefined;
  /** Assistant output items, ready to append to the next request's input. */
  outputItems: ResponseInputItem[];
  error: string | undefined;
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function kindOfItem(item: AnyResponseOutputItem): ItemKind {
  if (isReasoningItem(item)) return 'reasoning';
  if (isMessageItem(item)) return 'message';
  if (isFunctionCallItem(item)) return 'function_call';
  return 'other';
}

/**
 * Parse the JSON argument string produced by the model.
 *
 * An empty string is a legitimate "no arguments" call. Anything else that does
 * not parse into a JSON object is reported as a parse error rather than thrown.
 */
export function parseToolArguments(raw: string): { args: unknown; error: string | undefined } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { args: {}, error: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return {
      args: undefined,
      error: `arguments are not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { args: undefined, error: 'arguments must be a JSON object' };
  }
  return { args: parsed, error: undefined };
}

export class TurnAccumulator {
  readonly step: number;

  #byItemId = new Map<string, ItemState>();
  #byIndex = new Map<number, ItemState>();
  #responseId: string | undefined;
  #model: string | undefined;
  #status: ResponseStatus = 'in_progress';
  #usage: ResponseUsage | undefined;
  #error: string | undefined;
  #responseOutput: AnyResponseOutputItem[] | undefined;
  #started = false;
  #finalized = false;
  #toolCalls: AgentToolCall[] = [];

  constructor(step: number) {
    this.step = step;
  }

  /** True once `response.created` has been seen. */
  get started(): boolean {
    return this.#started;
  }

  get responseId(): string | undefined {
    return this.#responseId;
  }

  get status(): ResponseStatus {
    return this.#status;
  }

  /** Convert one wire event into zero or more agent events. */
  consume(event: ResponseStreamEvent): AgentEvent[] {
    switch (event.type) {
      case 'response.created':
      case 'response.in_progress':
        return this.#onResponseStart(event);

      case 'response.output_item.added':
        return this.#onItemAdded(event.output_index, event.item);

      case 'response.output_item.done':
        return this.#onItemDone(event.output_index, event.item);

      case 'response.content_part.added':
      case 'response.content_part.done':
        return [];

      case 'response.output_text.delta':
        return this.#onContentDelta(event.item_id, event.output_index, event.content_index, event.delta, 'text');

      case 'response.output_text.done':
        return this.#onContentDone(event.item_id, event.output_index, event.content_index, event.text, 'text');

      case 'response.refusal.delta':
        return this.#onContentDelta(event.item_id, event.output_index, event.content_index, event.delta, 'refusal');

      case 'response.refusal.done':
        return this.#onContentDone(event.item_id, event.output_index, event.content_index, event.refusal, 'refusal');

      case 'response.reasoning_summary_text.delta':
        return this.#onReasoningDelta(event.item_id, event.output_index, 'summary', event.summary_index, event.delta);

      case 'response.reasoning_summary_text.done':
        return this.#onReasoningDone(event.item_id, event.output_index, 'summary', event.summary_index, event.text);

      case 'response.reasoning_text.delta':
        return this.#onReasoningDelta(event.item_id, event.output_index, 'text', event.content_index, event.delta);

      case 'response.reasoning_text.done':
        return this.#onReasoningDone(event.item_id, event.output_index, 'text', event.content_index, event.text);

      case 'response.reasoning_summary_part.added':
      case 'response.reasoning_summary_part.done':
        return [];

      case 'response.function_call_arguments.delta':
        return this.#onArgumentsDelta(event.item_id, event.output_index, event.delta);

      case 'response.function_call_arguments.done': {
        const state = this.#ensureItem(event.item_id, event.output_index, 'function_call');
        state.args = event.arguments;
        if (event.name !== undefined && event.name.length > 0) state.name = event.name;
        return this.#finalizeToolCall(state);
      }

      case 'response.completed':
      case 'response.failed':
      case 'response.incomplete':
        return this.#onResponseDone(event.response);

      case 'error': {
        const message = event.message.length > 0 ? event.message : 'Unknown streaming error';
        this.#error = message;
        return [
          {
            type: 'error',
            step: this.step,
            message,
            code: event.code ?? undefined,
            fatal: true,
            retryable: false,
          },
        ];
      }
    }
  }

  /**
   * Emit any events still owed (missing `*_done` and `tool_call` events).
   *
   * Safe to call more than once; the second call is a no-op. Call it when the
   * stream ends in case the API omitted the trailing events.
   */
  finalize(response?: ResponseResource): AgentEvent[] {
    if (this.#finalized) return [];
    this.#finalized = true;

    if (response !== undefined) {
      this.#applyResponseResource(response);
    }

    const states = [...this.#byIndex.values()].sort((a, b) => a.outputIndex - b.outputIndex);

    // Adopt items that only ever appeared in the final `response.output`.
    if (this.#responseOutput !== undefined) {
      for (const [index, item] of this.#responseOutput.entries()) {
        const record = asRecord(item);
        const itemId = readString(record, 'id');
        if (itemId === undefined) continue;
        if (this.#byItemId.has(itemId)) continue;
        const state = this.#ensureItem(itemId, index, kindOfItem(item));
        state.wire = item;
        this.#adoptWireContent(state, item);
        states.push(state);
      }
      states.sort((a, b) => a.outputIndex - b.outputIndex);
    }

    const out: AgentEvent[] = [];
    for (const state of states) {
      out.push(...this.#finalizeItem(state));
    }
    return out;
  }

  /** Aggregated view of the turn. */
  snapshot(): TurnSnapshot {
    const states = [...this.#byIndex.values()].sort((a, b) => a.outputIndex - b.outputIndex);

    const reasoning: AgentReasoningBlock[] = [];
    for (const state of states) {
      if (state.kind !== 'reasoning') continue;
      const parts = [...state.reasoningParts.values()].sort((a, b) => a.index - b.index);
      for (const part of parts) {
        if (part.text.length === 0) continue;
        reasoning.push({
          itemId: state.itemId,
          outputIndex: state.outputIndex,
          part: part.part,
          text: part.text,
        });
      }
    }

    const textPieces: string[] = [];
    const refusalPieces: string[] = [];
    for (const state of states) {
      if (state.kind !== 'message') continue;
      const parts = [...state.contentParts.entries()].sort((a, b) => a[0] - b[0]);
      for (const [, part] of parts) {
        if (part.text.length === 0) continue;
        if (part.kind === 'text') textPieces.push(part.text);
        else refusalPieces.push(part.text);
      }
    }

    const toolCalls = states
      .filter((state) => state.kind === 'function_call')
      .map((state) => this.#toToolCall(state))
      .filter((call): call is AgentToolCall => call !== undefined);

    return {
      responseId: this.#responseId,
      model: this.#model,
      status: this.#status,
      text: textPieces.join(''),
      refusal: refusalPieces.join(''),
      reasoning,
      reasoningText: reasoning.map((block) => block.text).join('\n\n'),
      toolCalls,
      usage: this.#usage,
      outputItems: this.#buildOutputItems(),
      error: this.#error,
    };
  }

  /** Tool calls in the order the model requested them. */
  get toolCalls(): AgentToolCall[] {
    return this.#toolCalls;
  }

  /* ---------------------------------------------------------------------- */
  /* Handlers                                                               */
  /* ---------------------------------------------------------------------- */

  #onResponseStart(event: Extract<ResponseStreamEvent, { response: ResponseResource }>): AgentEvent[] {
    const response = event.response;
    this.#responseId ??= response.id;
    this.#model ??= response.model;
    if (response.usage !== undefined && response.usage !== null) this.#usage = response.usage;
    if (this.#started) return [];
    this.#started = true;
    this.#status = response.status;
    return [
      {
        type: 'response_start',
        step: this.step,
        responseId: this.#responseId,
        model: this.#model,
      },
    ];
  }

  #onResponseDone(response: ResponseResource): AgentEvent[] {
    const out: AgentEvent[] = [];
    this.#applyResponseResource(response);
    out.push(...this.finalize(response));
    if (response.status === 'failed') {
      const message = response.error?.message ?? 'The model response failed';
      this.#error ??= message;
      out.push({
        type: 'error',
        step: this.step,
        message,
        code: response.error?.code ?? undefined,
        fatal: true,
        retryable: false,
      });
    }
    return out;
  }

  #onItemAdded(outputIndex: number, item: AnyResponseOutputItem): AgentEvent[] {
    const record = asRecord(item);
    const itemId = readString(record, 'id') ?? `item_${outputIndex}`;
    const state = this.#ensureItem(itemId, outputIndex, kindOfItem(item));
    state.wire = item;
    state.kind = kindOfItem(item);

    if (state.kind === 'function_call') {
      state.callId ??= readString(record, 'call_id') ?? itemId;
      state.name ??= readString(record, 'name') ?? '';
      // Announce the call immediately so consumers can show it before arguments
      // start streaming (a call with no arguments emits no delta at all).
      return [
        {
          type: 'tool_call_delta',
          step: this.step,
          itemId: state.itemId,
          outputIndex,
          callId: state.callId,
          name: state.name,
          argsDelta: '',
          arguments: state.args,
        },
      ];
    }
    return [];
  }

  #onItemDone(outputIndex: number, item: AnyResponseOutputItem): AgentEvent[] {
    const record = asRecord(item);
    const itemId = readString(record, 'id') ?? `item_${outputIndex}`;
    const state = this.#ensureItem(itemId, outputIndex, kindOfItem(item));
    state.wire = item;
    state.kind = kindOfItem(item);
    if (state.kind === 'function_call') {
      state.callId ??= readString(record, 'call_id') ?? itemId;
      state.name ??= readString(record, 'name') ?? '';
      const args = readString(record, 'arguments');
      if (args !== undefined) state.args = args;
    }
    this.#adoptWireContent(state, item);
    return this.#finalizeItem(state);
  }

  #onContentDelta(
    itemId: string,
    outputIndex: number,
    contentIndex: number,
    delta: string,
    kind: 'text' | 'refusal',
  ): AgentEvent[] {
    const state = this.#ensureItem(itemId, outputIndex, 'message');
    const part = this.#contentPart(state, contentIndex, kind);
    part.text += delta;
    if (kind === 'text') {
      const event: ContentDeltaEvent = {
        type: 'content_delta',
        step: this.step,
        itemId: state.itemId,
        outputIndex,
        delta,
        text: this.#messageText(state),
      };
      return [event];
    }
    const event: RefusalDeltaEvent = {
      type: 'refusal_delta',
      step: this.step,
      itemId: state.itemId,
      outputIndex,
      delta,
      text: part.text,
    };
    return [event];
  }

  #onContentDone(
    itemId: string,
    outputIndex: number,
    contentIndex: number,
    text: string,
    kind: 'text' | 'refusal',
  ): AgentEvent[] {
    const state = this.#ensureItem(itemId, outputIndex, 'message');
    const part = this.#contentPart(state, contentIndex, kind);
    if (text.length > 0) part.text = text;
    const key = `${kind}:${contentIndex}`;
    // Prefer the precise `*_done` payloads over the item-level fallback.
    if (state.doneEmitted.has(key)) return [];
    state.doneEmitted.add(key);

    if (kind === 'text') {
      const event: ContentDoneEvent = {
        type: 'content_done',
        step: this.step,
        itemId: state.itemId,
        outputIndex,
        text: part.text,
      };
      return [event];
    }
    const event: RefusalDoneEvent = {
      type: 'refusal_done',
      step: this.step,
      itemId: state.itemId,
      outputIndex,
      text: part.text,
    };
    return [event];
  }

  #onReasoningDelta(
    itemId: string,
    outputIndex: number,
    part: ReasoningPartKind,
    index: number,
    delta: string,
  ): AgentEvent[] {
    const state = this.#ensureItem(itemId, outputIndex, 'reasoning');
    const slot = this.#reasoningPart(state, part, index);
    slot.text += delta;
    const event: ReasoningDeltaEvent = {
      type: 'reasoning_delta',
      step: this.step,
      itemId: state.itemId,
      outputIndex,
      part,
      delta,
      text: slot.text,
    };
    return [event];
  }

  #onReasoningDone(
    itemId: string,
    outputIndex: number,
    part: ReasoningPartKind,
    index: number,
    text: string,
  ): AgentEvent[] {
    const state = this.#ensureItem(itemId, outputIndex, 'reasoning');
    const slot = this.#reasoningPart(state, part, index);
    if (text.length > 0) slot.text = text;
    const key = `${part}:${index}`;
    if (state.doneEmitted.has(key)) return [];
    state.doneEmitted.add(key);
    const event: ReasoningDoneEvent = {
      type: 'reasoning_done',
      step: this.step,
      itemId: state.itemId,
      outputIndex,
      part,
      text: slot.text,
    };
    return [event];
  }

  #onArgumentsDelta(itemId: string, outputIndex: number, delta: string): AgentEvent[] {
    const state = this.#ensureItem(itemId, outputIndex, 'function_call');
    state.args += delta;
    const event: ToolCallDeltaEvent = {
      type: 'tool_call_delta',
      step: this.step,
      itemId: state.itemId,
      outputIndex,
      callId: state.callId ?? state.itemId,
      name: state.name ?? '',
      argsDelta: delta,
      arguments: state.args,
    };
    return [event];
  }

  /* ---------------------------------------------------------------------- */
  /* Finalisation helpers                                                   */
  /* ---------------------------------------------------------------------- */

  /** Emit whatever this item still owes. */
  #finalizeItem(state: ItemState): AgentEvent[] {
    const out: AgentEvent[] = [];

    if (state.kind === 'reasoning') {
      const parts = [...state.reasoningParts.values()].sort((a, b) => a.index - b.index);
      for (const part of parts) {
        const key = `${part.part}:${part.index}`;
        if (state.doneEmitted.has(key)) continue;
        if (part.text.length === 0) continue;
        state.doneEmitted.add(key);
        out.push({
          type: 'reasoning_done',
          step: this.step,
          itemId: state.itemId,
          outputIndex: state.outputIndex,
          part: part.part,
          text: part.text,
        });
      }
      return out;
    }

    if (state.kind === 'message') {
      const parts = [...state.contentParts.entries()].sort((a, b) => a[0] - b[0]);
      for (const [index, part] of parts) {
        const key = `${part.kind}:${index}`;
        if (state.doneEmitted.has(key)) continue;
        if (part.text.length === 0) continue;
        state.doneEmitted.add(key);
        if (part.kind === 'text') {
          out.push({
            type: 'content_done',
            step: this.step,
            itemId: state.itemId,
            outputIndex: state.outputIndex,
            text: this.#messageText(state),
          });
        } else {
          out.push({
            type: 'refusal_done',
            step: this.step,
            itemId: state.itemId,
            outputIndex: state.outputIndex,
            text: part.text,
          });
        }
      }
      return out;
    }

    if (state.kind === 'function_call') {
      out.push(...this.#finalizeToolCall(state));
    }
    return out;
  }

  #finalizeToolCall(state: ItemState): AgentEvent[] {
    if (state.callEmitted) return [];
    if (state.kind !== 'function_call') return [];
    state.callEmitted = true;

    const call = this.#toToolCall(state);
    if (call === undefined) return [];
    this.#toolCalls.push(call);

    const event: ToolCallEvent = {
      type: 'tool_call',
      step: this.step,
      itemId: state.itemId,
      outputIndex: state.outputIndex,
      callId: call.callId,
      name: call.name,
      arguments: call.arguments,
      args: call.args,
      parseError: call.parseError,
    };
    return [event];
  }

  #toToolCall(state: ItemState): AgentToolCall | undefined {
    const name = state.name ?? '';
    if (name.length === 0) return undefined;
    const { args, error } = parseToolArguments(state.args);
    const call: AgentToolCall = {
      callId: state.callId ?? state.itemId,
      itemId: state.itemId,
      name,
      arguments: state.args,
      args,
    };
    if (error !== undefined) call.parseError = error;
    return call;
  }

  /** Pull text out of a completed wire item, filling gaps left by missing deltas. */
  #adoptWireContent(state: ItemState, item: AnyResponseOutputItem): void {
    const record = asRecord(item);

    if (state.kind === 'reasoning') {
      const summary = record.summary;
      if (Array.isArray(summary)) {
        summary.forEach((entry, index) => {
          const text = readString(asRecord(entry), 'text');
          if (text === undefined) return;
          const slot = this.#reasoningPart(state, 'summary', index);
          if (slot.text.length === 0) slot.text = text;
        });
      }
      const content = record.content;
      if (Array.isArray(content)) {
        content.forEach((entry, index) => {
          const text = readString(asRecord(entry), 'text');
          if (text === undefined) return;
          const slot = this.#reasoningPart(state, 'text', index);
          if (slot.text.length === 0) slot.text = text;
        });
      }
      return;
    }

    if (state.kind === 'function_call') {
      // Adopted from `response.output` when the item-level events never arrived.
      state.callId ??= readString(record, 'call_id') ?? state.itemId;
      state.name ??= readString(record, 'name');
      const args = record.arguments;
      if (typeof args === 'string' && state.args.length === 0) state.args = args;
      return;
    }

    if (state.kind === 'message') {
      const content = record.content;
      if (!Array.isArray(content)) return;
      content.forEach((entry, index) => {
        const partRecord = asRecord(entry);
        const type = readString(partRecord, 'type');
        if (type === 'output_text') {
          const text = readString(partRecord, 'text');
          if (text === undefined) return;
          const part = this.#contentPart(state, index, 'text');
          if (part.text.length === 0) part.text = text;
        } else if (type === 'refusal') {
          const text = readString(partRecord, 'refusal');
          if (text === undefined) return;
          const part = this.#contentPart(state, index, 'refusal');
          if (part.text.length === 0) part.text = text;
        }
      });
    }
  }

  #applyResponseResource(response: ResponseResource): void {
    this.#responseId ??= response.id;
    this.#model ??= response.model;
    this.#status = response.status;
    if (response.usage !== undefined && response.usage !== null) this.#usage = response.usage;
    this.#responseOutput = response.output;
    if (response.error != null && typeof response.error.message === 'string') {
      this.#error ??= response.error.message;
    }
  }

  /** Assistant items to append to the conversation for the next turn. */
  #buildOutputItems(): ResponseInputItem[] {
    const states = [...this.#byIndex.values()].sort((a, b) => a.outputIndex - b.outputIndex);
    const out: ResponseInputItem[] = [];

    for (const state of states) {
      if (state.kind === 'function_call') {
        if (state.name === undefined || state.name.length === 0) continue;
        const item: ResponseInputItem = {
          type: 'function_call',
          call_id: state.callId ?? state.itemId,
          name: state.name,
          arguments: state.args,
          status: 'completed',
        };
        if (state.wire !== undefined) {
          const wireId = readString(asRecord(state.wire), 'id');
          if (wireId !== undefined) item.id = wireId;
        }
        out.push(item);
        continue;
      }
      if (state.kind === 'message') {
        const parts = [...state.contentParts.entries()].sort((a, b) => a[0] - b[0]);
        const text = parts
          .filter(([, part]) => part.kind === 'text')
          .map(([, part]) => part.text)
          .join('');
        if (text.length === 0) continue;
        out.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'input_text', text }],
        });
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------------- */
  /* State helpers                                                          */
  /* ---------------------------------------------------------------------- */

  #ensureItem(itemId: string, outputIndex: number, kindHint: ItemKind): ItemState {
    const existing = this.#byItemId.get(itemId);
    if (existing !== undefined) return existing;
    // The item may already be tracked under its output index (announced without
    // an id, then referenced by id in later deltas).
    const byIndex = this.#byIndex.get(outputIndex);
    if (byIndex !== undefined) {
      this.#byItemId.set(itemId, byIndex);
      return byIndex;
    }
    const state: ItemState = {
      itemId,
      outputIndex,
      kind: kindHint,
      reasoningParts: new Map(),
      contentParts: new Map(),
      doneEmitted: new Set(),
      callId: undefined,
      name: undefined,
      args: '',
      callEmitted: false,
      wire: undefined,
    };
    this.#byItemId.set(itemId, state);
    this.#byIndex.set(outputIndex, state);
    return state;
  }

  #reasoningPart(
    state: ItemState,
    part: ReasoningPartKind,
    index: number,
  ): { part: ReasoningPartKind; index: number; text: string } {
    const key = `${part}:${index}`;
    const existing = state.reasoningParts.get(key);
    if (existing !== undefined) return existing;
    const created = { part, index, text: '' };
    state.reasoningParts.set(key, created);
    return created;
  }

  #contentPart(state: ItemState, index: number, kind: 'text' | 'refusal'): ContentPartState {
    const existing = state.contentParts.get(index);
    if (existing !== undefined) return existing;
    const created: ContentPartState = { kind, text: '' };
    state.contentParts.set(index, created);
    return created;
  }

  #messageText(state: ItemState): string {
    return [...state.contentParts.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, part]) => part.kind === 'text')
      .map(([, part]) => part.text)
      .join('');
  }
}
