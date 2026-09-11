/**
 * A small, dependency-free Server-Sent Events (SSE) parser.
 *
 * It implements the WHATWG event-stream parsing rules that matter in practice:
 *
 * - events are separated by a blank line;
 * - a line is `field: value` (a single leading space after the colon is stripped);
 * - a line starting with `:` is a comment and is ignored;
 * - repeated `data:` lines are joined with `\n`;
 * - `event:`, `id:` and `retry:` fields are surfaced on the message;
 * - unknown fields are ignored.
 *
 * The parser is **incremental**: it is fed arbitrary string chunks (which do not
 * have to align with line or event boundaries, and may split a `\r\n` pair in
 * half) and returns whichever complete messages became available.
 */

/** A single dispatched SSE event. */
export interface SSEMessage {
  /** Value of the `event:` field. Undefined when the server did not name the event. */
  event?: string;
  /** Concatenation of the `data:` lines, joined with `\n`. */
  data: string;
  /** Most recent value of the `id:` field. Persists across messages, per spec. */
  id?: string;
  /** Value of the `retry:` field, when it was a valid integer. */
  retry?: number;
}

/** Matches a single complete line terminator (CRLF, CR or LF). */
const LINE_BREAK = /\r\n|\r|\n/;

/** Position of the last line terminator in `text`, or -1 when there is none. */
function lastLineBreakIndex(text: string): number {
  const lf = text.lastIndexOf('\n');
  const cr = text.lastIndexOf('\r');
  return lf > cr ? lf : cr;
}

export class SSEParser {
  /** Bytes received so far that do not yet form a complete line. */
  private buffer = '';
  /** Pending `event:` field for the event being assembled. */
  private eventName: string | undefined;
  /** Pending `data:` lines for the event being assembled. */
  private dataLines: string[] = [];
  /** Last seen `id:`, which persists across events. */
  private lastEventId: string | undefined;
  /** Last seen `retry:`. */
  private lastRetry: number | undefined;

  /** Feed a chunk of decoded text; returns every message that completed. */
  push(chunk: string): SSEMessage[] {
    this.buffer += chunk;

    // Only lines terminated by a line break are complete; the tail of the
    // buffer stays pending because it may still grow into a longer line.
    const breakIndex = lastLineBreakIndex(this.buffer);
    if (breakIndex === -1) return [];

    const complete = this.buffer.slice(0, breakIndex + 1);
    this.buffer = this.buffer.slice(breakIndex + 1);

    const out: SSEMessage[] = [];
    const lines = complete.split(LINE_BREAK);
    // Everything after the final line terminator is not a line yet. Dropping
    // that trailing element is essential: without it a chunk ending on a line
    // break (e.g. "data: a\n") would look like a blank line and dispatch a
    // half-finished event, splitting multi-line data across two messages.
    lines.pop();
    for (const line of lines) {
      this.consumeLine(line, out);
    }
    return out;
  }

  /**
   * Flush any buffered content.
   *
   * The specification discards a trailing event that was never terminated by a
   * blank line. We are deliberately more lenient here so that a server which
   * closes the connection without a final `\n\n` still yields its last event.
   */
  end(): SSEMessage[] {
    const out: SSEMessage[] = [];
    const remaining = this.buffer;
    this.buffer = '';

    if (remaining.length > 0) {
      // Strip a single trailing line terminator so it is not seen as a blank line.
      const trimmed = remaining.replace(/\r\n$|\r$|\n$/, '');
      if (trimmed.length > 0) this.consumeLine(trimmed, out);
    }
    this.dispatch(out);
    return out;
  }

  /** Reset all parser state. */
  reset(): void {
    this.buffer = '';
    this.eventName = undefined;
    this.dataLines = [];
    this.lastEventId = undefined;
    this.lastRetry = undefined;
  }

  private consumeLine(line: string, out: SSEMessage[]): void {
    if (line === '') {
      this.dispatch(out);
      return;
    }
    if (line.startsWith(':')) return; // comment / keep-alive

    const colon = line.indexOf(':');
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
    }

    switch (field) {
      case 'event':
        this.eventName = value;
        break;
      case 'data':
        this.dataLines.push(value);
        break;
      case 'id':
        // A NUL in the id is ignored per spec.
        if (!value.includes('\u0000')) this.lastEventId = value;
        break;
      case 'retry':
        if (/^\d+$/.test(value)) this.lastRetry = Number.parseInt(value, 10);
        break;
      default:
        break; // unknown field: ignore
    }
  }

  private dispatch(out: SSEMessage[]): void {
    const name = this.eventName;
    const lines = this.dataLines;
    // The event type buffer is always cleared, per spec.
    this.eventName = undefined;
    this.dataLines = [];

    // Per spec the check is on the data *buffer*: a frame whose data lines are
    // all empty (including "data\n\n") is not dispatched.
    const data = lines.join('\n');
    if (data.length === 0) return;

    const message: SSEMessage = { data };
    if (name !== undefined) message.event = name;
    if (this.lastEventId !== undefined) message.id = this.lastEventId;
    if (this.lastRetry !== undefined) message.retry = this.lastRetry;
    out.push(message);
  }
}

/**
 * Turn a byte stream into SSE messages.
 *
 * Decoding is done with a streaming `TextDecoder` so multi-byte UTF-8
 * characters split across chunks are reassembled correctly.
 *
 * If the consumer stops iterating early the underlying stream is cancelled,
 * which releases the HTTP connection.
 */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  options: { signal?: AbortSignal } = {},
): AsyncGenerator<SSEMessage, void, void> {
  const parser = new SSEParser();
  const decoder = new TextDecoder('utf-8');
  const reader = body.getReader();
  let completed = false;

  try {
    for (; ;) {
      if (options.signal?.aborted === true) break;

      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;

      for (const message of parser.push(decoder.decode(value, { stream: true }))) {
        yield message;
      }
    }

    const tail = decoder.decode();
    if (tail.length > 0) {
      for (const message of parser.push(tail))
        yield message;
    }
    for (const message of parser.end())
      yield message;
    completed = true;
  } finally {
    if (!completed) {
      // Consumer bailed out (or we threw): tear the connection down.
      try {
        await reader.cancel();
      } catch {
        // The stream may already be closed; nothing useful to do.
      }
    }
    reader.releaseLock();
  }
}
