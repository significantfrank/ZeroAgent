/**
 * Builders for realistic Responses API stream scripts.
 *
 * These emit the same event shapes and ordering the real API produces, so the
 * agent can be tested offline without weakening the assertions.
 */

export interface ToolCallSpec {
  name: string;
  callId?: string;
  itemId?: string;
  /** Arguments object; serialised to JSON. */
  args?: unknown;
  /** Raw arguments string, overriding `args`. Useful for malformed JSON. */
  argumentsJson?: string;
  /** Split the argument JSON into chunks of this size while streaming. */
  argChunkSize?: number;
}

export interface UsageSpec {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
  reasoning_tokens?: number;
}

export interface TurnSpec {
  responseId?: string;
  model?: string;
  /** Reasoning **summary** deltas, in order. */
  reasoning?: readonly string[];
  /** Raw reasoning text deltas (the `reasoning_text` event family). */
  reasoningText?: readonly string[];
  /** Answer text deltas. */
  content?: readonly string[];
  /** Refusal deltas. */
  refusal?: readonly string[];
  toolCalls?: readonly ToolCallSpec[];
  usage?: UsageSpec;
  status?: 'completed' | 'incomplete' | 'failed';
  error?: { message: string; code?: string };
  /** Skip `response.completed` to exercise the truncated-stream path. */
  omitCompleted?: boolean;
  /** Skip every `response.output_item.done` event. */
  omitItemDone?: boolean;
  /** Skip `response.function_call_arguments.done`. */
  omitArgumentsDone?: boolean;
  /** Skip `response.reasoning_summary_text.done` / `reasoning_text.done`. */
  omitReasoningDone?: boolean;
  reasoningItemId?: string;
  messageItemId?: string;
}

/** Split a string into chunks of at most `size` characters. */
export function chunk(text: string, size: number): string[] {
  if (size <= 0) return [text];
  const out: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    out.push(text.slice(index, index + size));
  }
  return out.length > 0 ? out : [''];
}

interface ReasoningItem {
  type: 'reasoning';
  id: string;
  summary: Array<{ type: 'summary_text'; text: string }>;
  content: Array<{ type: 'reasoning_text'; text: string }>;
  status: string;
}

interface MessageItem {
  type: 'message';
  id: string;
  role: 'assistant';
  status: string;
  content: Array<{ type: 'output_text'; text: string; annotations: unknown[] } | { type: 'refusal'; refusal: string }>;
}

interface FunctionCallItem {
  type: 'function_call';
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status: string;
}

type WireItem = ReasoningItem | MessageItem | FunctionCallItem;

/**
 * Produce the full SSE event sequence for one model turn.
 *
 * Output index order matches the real API: reasoning items first, then the
 * assistant message, then function calls.
 */
export function buildTurn(spec: TurnSpec): unknown[] {
  const responseId = spec.responseId ?? 'resp_mock_1';
  const model = spec.model ?? 'gpt-mock-1';
  const status = spec.status ?? 'completed';
  const events: unknown[] = [];
  const items: WireItem[] = [];
  let sequence = 0;

  const emit = (event: Record<string, unknown>): void => {
    events.push({ ...event, sequence_number: sequence++ });
  };

  emit({
    type: 'response.created',
    response: { id: responseId, model, status: 'in_progress', output: [] },
  });
  emit({
    type: 'response.in_progress',
    response: { id: responseId, model, status: 'in_progress', output: [] },
  });

  let outputIndex = 0;

  /* ----------------------------- reasoning ------------------------------ */
  const hasReasoning = (spec.reasoning?.length ?? 0) > 0 || (spec.reasoningText?.length ?? 0) > 0;
  if (hasReasoning) {
    const itemId = spec.reasoningItemId ?? 'rs_mock_1';
    const summaryText = (spec.reasoning ?? []).join('');
    const rawText = (spec.reasoningText ?? []).join('');

    emit({
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: { type: 'reasoning', id: itemId, summary: [] },
    });

    if (summaryText.length > 0) {
      emit({
        type: 'response.reasoning_summary_part.added',
        item_id: itemId,
        output_index: outputIndex,
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      });
      for (const delta of spec.reasoning ?? []) {
        emit({
          type: 'response.reasoning_summary_text.delta',
          item_id: itemId,
          output_index: outputIndex,
          summary_index: 0,
          delta,
        });
      }
      if (spec.omitReasoningDone !== true) {
        emit({
          type: 'response.reasoning_summary_text.done',
          item_id: itemId,
          output_index: outputIndex,
          summary_index: 0,
          text: summaryText,
        });
      }
    }

    if (rawText.length > 0) {
      for (const delta of spec.reasoningText ?? []) {
        emit({
          type: 'response.reasoning_text.delta',
          item_id: itemId,
          output_index: outputIndex,
          content_index: 0,
          delta,
        });
      }
      if (spec.omitReasoningDone !== true) {
        emit({
          type: 'response.reasoning_text.done',
          item_id: itemId,
          output_index: outputIndex,
          content_index: 0,
          text: rawText,
        });
      }
    }

    const item: ReasoningItem = {
      type: 'reasoning',
      id: itemId,
      summary: summaryText.length > 0 ? [{ type: 'summary_text', text: summaryText }] : [],
      content: rawText.length > 0 ? [{ type: 'reasoning_text', text: rawText }] : [],
      status: status === 'completed' ? 'completed' : 'incomplete',
    };
    items.push(item);
    if (spec.omitItemDone !== true) {
      emit({ type: 'response.output_item.done', output_index: outputIndex, item });
    }
    outputIndex += 1;
  }

  /* ------------------------------ message ------------------------------- */
  const hasMessage = (spec.content?.length ?? 0) > 0 || (spec.refusal?.length ?? 0) > 0;
  if (hasMessage) {
    const itemId = spec.messageItemId ?? 'msg_mock_1';
    const contentText = (spec.content ?? []).join('');
    const refusalText = (spec.refusal ?? []).join('');

    emit({
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: { type: 'message', id: itemId, role: 'assistant', status: 'in_progress', content: [] },
    });
    emit({
      type: 'response.content_part.added',
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });

    for (const delta of spec.content ?? []) {
      emit({
        type: 'response.output_text.delta',
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        delta,
      });
    }
    if (contentText.length > 0) {
      emit({
        type: 'response.output_text.done',
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        text: contentText,
      });
    }

    for (const delta of spec.refusal ?? []) {
      emit({
        type: 'response.refusal.delta',
        item_id: itemId,
        output_index: outputIndex,
        content_index: 1,
        delta,
      });
    }
    if (refusalText.length > 0) {
      emit({
        type: 'response.refusal.done',
        item_id: itemId,
        output_index: outputIndex,
        content_index: 1,
        refusal: refusalText,
      });
    }

    const content: MessageItem['content'] = [];
    if (contentText.length > 0) content.push({ type: 'output_text', text: contentText, annotations: [] });
    if (refusalText.length > 0) content.push({ type: 'refusal', refusal: refusalText });

    const item: MessageItem = {
      type: 'message',
      id: itemId,
      role: 'assistant',
      status: status === 'completed' ? 'completed' : 'incomplete',
      content,
    };
    items.push(item);
    if (spec.omitItemDone !== true) {
      emit({ type: 'response.output_item.done', output_index: outputIndex, item });
    }
    outputIndex += 1;
  }

  /* ---------------------------- tool calls ------------------------------ */
  (spec.toolCalls ?? []).forEach((call, index) => {
    const itemId = call.itemId ?? `fc_mock_${index + 1}`;
    const callId = call.callId ?? `call_mock_${index + 1}`;
    const argsJson = call.argumentsJson ?? JSON.stringify(call.args ?? {});
    const thisIndex = outputIndex;
    outputIndex += 1;

    emit({
      type: 'response.output_item.added',
      output_index: thisIndex,
      item: {
        type: 'function_call',
        id: itemId,
        call_id: callId,
        name: call.name,
        arguments: '',
        status: 'in_progress',
      },
    });

    for (const piece of chunk(argsJson, call.argChunkSize ?? argsJson.length)) {
      emit({
        type: 'response.function_call_arguments.delta',
        item_id: itemId,
        output_index: thisIndex,
        delta: piece,
      });
    }

    if (spec.omitArgumentsDone !== true) {
      emit({
        type: 'response.function_call_arguments.done',
        item_id: itemId,
        output_index: thisIndex,
        name: call.name,
        arguments: argsJson,
      });
    }

    const item: FunctionCallItem = {
      type: 'function_call',
      id: itemId,
      call_id: callId,
      name: call.name,
      arguments: argsJson,
      status: 'completed',
    };
    items.push(item);
    if (spec.omitItemDone !== true) {
      emit({ type: 'response.output_item.done', output_index: thisIndex, item });
    }
  });

  /* ---------------------------- completion ------------------------------ */
  if (spec.omitCompleted !== true) {
    const usage =
      spec.usage === undefined
        ? undefined
        : {
            input_tokens: spec.usage.input_tokens,
            output_tokens: spec.usage.output_tokens,
            total_tokens: spec.usage.total_tokens ?? spec.usage.input_tokens + spec.usage.output_tokens,
            ...(spec.usage.reasoning_tokens === undefined
              ? {}
              : { output_tokens_details: { reasoning_tokens: spec.usage.reasoning_tokens } }),
          };

    emit({
      type: status === 'failed' ? 'response.failed' : status === 'incomplete' ? 'response.incomplete' : 'response.completed',
      response: {
        id: responseId,
        model,
        status,
        output: items,
        ...(usage === undefined ? {} : { usage }),
        ...(spec.error === undefined ? {} : { error: spec.error }),
      },
    });
  }

  return events;
}
