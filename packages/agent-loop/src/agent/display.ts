/**
 * Console rendering of the agent's event stream.
 *
 * Demonstrates the intended consumption pattern: every event is routed by
 * {@link channelOf} so reasoning, answer text and tool traffic are visually
 * separated instead of being interleaved into one undifferentiated blob.
 */

import { channelOf } from './events.ts';
import type { AgentChannel, AgentEvent } from './events.ts';

const ANSI = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  grey: '\u001b[90m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
} as const;

const CHANNEL_STYLE: Record<AgentChannel, { color: string; label: string }> = {
  reasoning: { color: ANSI.grey, label: 'reasoning' },
  content: { color: ANSI.reset, label: 'content' },
  tool_call: { color: ANSI.cyan, label: 'tool_call' },
  tool_result: { color: ANSI.yellow, label: 'tool_result' },
  status: { color: ANSI.blue, label: 'status' },
  error: { color: ANSI.red, label: 'error' },
};

export interface ConsoleRendererOptions {
  /** Write to this sink. Default `process.stdout`. */
  write?: (text: string) => void;
  /** Force ANSI colour on/off. Defaults to `process.stdout.isTTY`. */
  color?: boolean;
  /** Stream reasoning deltas. Default true. */
  showReasoning?: boolean;
  /** Show tool-call and tool-result lines. Default true. */
  showTools?: boolean;
  /** Show lifecycle lines (run/step start, usage). Default true. */
  showStatus?: boolean;
  /** Show the final token usage line. Default true. */
  showUsage?: boolean;
  /** Prefix each channel block with a coloured `[channel]` label. Default true. */
  showLabels?: boolean;
}

/**
 * Stateful console renderer for {@link AgentEvent}s.
 *
 * Delta events are written inline under a per-channel header; other events are
 * written as their own line.
 */
export class ConsoleRenderer {
  readonly #write: (text: string) => void;
  readonly #color: boolean;
  readonly #showReasoning: boolean;
  readonly #showTools: boolean;
  readonly #showStatus: boolean;
  readonly #showUsage: boolean;
  readonly #showLabels: boolean;

  /** Channel currently being streamed, so headers are emitted only on change. */
  #openChannel: AgentChannel | null = null;
  #atLineStart = true;

  constructor(options: ConsoleRendererOptions = {}) {
    this.#write = options.write ?? ((text) => process.stdout.write(text));
    this.#color = options.color ?? process.stdout.isTTY === true;
    this.#showReasoning = options.showReasoning ?? true;
    this.#showTools = options.showTools ?? true;
    this.#showStatus = options.showStatus ?? true;
    this.#showUsage = options.showUsage ?? true;
    this.#showLabels = options.showLabels ?? true;
  }

  /** Render one event. */
  render(event: AgentEvent): void {
    const channel = channelOf(event);

    // Deltas are streamed inline on their own channel.
    if (
      event.type === 'reasoning_delta' ||
      event.type === 'content_delta' ||
      event.type === 'refusal_delta' ||
      event.type === 'tool_call_delta'
    ) {
      // A tool call opening frame has no text yet; skip it so the header is not
      // printed for a call whose arguments never stream.
      // 不显示tool_call_delta（参数部分 event.argsDelta ） ，后面会显示
      if (event.type === 'tool_call_delta') return;
      if (event.type === 'reasoning_delta' && !this.#showReasoning) return;
      this.#ensureChannel(channel);
      this.#raw(event.delta);
      return;
    }

    switch (event.type) {
      case 'step_start':
        if (!this.#showStatus) return;
        this.#line('status', `── step ${event.step} ──────────────────────────────`);
        return;

      case 'response_start':
        if (!this.#showStatus) return;
        this.#line('status', `response ${event.responseId ?? '(pending)'} model=${event.model ?? '?'}`);
        return;

      case 'reasoning_done':
        if (!this.#showReasoning) return;
        this.#closeChannel();
        return;

      case 'content_done':
      case 'refusal_done':
        this.#closeChannel();
        return;

      case 'tool_call':
        if (!this.#showTools) return;
        this.#line('tool_call', `${event.name}(${event.arguments.length > 0 ? event.arguments : ''})`);
        if (event.parseError !== undefined) {
          this.#line('error', `argument parse problem: ${event.parseError}`);
        }
        return;

      case 'tool_result':
        if (!this.#showTools) return;
        this.#line(
          'tool_result',
          `${event.ok ? '✓' : '✗'} ${event.name} (${event.durationMs}ms) → ${truncateForDisplay(event.output)}`,
        );
        return;

      case 'step_end':
        if (!this.#showStatus) return;
        this.#line(
          'status',
          `step ${event.step} done: status=${event.status} text=${event.text.length}ch ` +
          `reasoning=${event.reasoning.length}ch toolCalls=${event.toolCalls.length}`,
        );
        return;

      case 'run_end':
        this.#closeChannel();
        if (this.#showStatus) {
          this.#line('status', `run finished: stopReason=${event.stopReason} steps=${event.steps}`);
        }
        if (this.#showUsage) {
          this.#line(
            'status',
            `token usage: total=${event.usage.total_tokens} ` +
            `(input=${event.usage.input_tokens}, output=${event.usage.output_tokens})`,
          );
        }
        if (event.error !== undefined) this.#line('error', event.error);
        return;

      case 'error':
        this.#line('error', `${event.message}${event.fatal ? ' (fatal)' : ''}`);
        return;

      case 'run_start':
        if (!this.#showStatus) return;
        this.#line(
          'status',
          `run start: model=${event.model} tools=[${event.tools.join(', ')}] maxSteps=${event.maxSteps}`,
        );
        return;

      default:
        return;
    }
  }

  /** Finish any open channel. Call once at the end of a run. */
  flush(): void {
    this.#closeChannel();
  }

  #raw(text: string): void {
    const color = this.#openChannel === null ? ANSI.reset : CHANNEL_STYLE[this.#openChannel].color;
    this.#write(this.#paint(text, color));
    this.#atLineStart = text.endsWith('\n');
  }

  #ensureChannel(channel: AgentChannel): void {
    if (this.#openChannel === channel) return;
    this.#closeChannel();
    this.#openChannel = channel;
    if (this.#showLabels) {
      const style = CHANNEL_STYLE[channel];
      this.#write(`${this.#paint(`[${style.label}] `, style.color)}`);
      this.#atLineStart = false;
    }
  }

  #closeChannel(): void {
    if (this.#openChannel === null)
      return;
    this.#openChannel = null;
    if (!this.#atLineStart)
      this.#write('\n');
    this.#atLineStart = true;
  }

  #line(channel: AgentChannel, text: string): void {
    this.#closeChannel();
    const style = CHANNEL_STYLE[channel];
    this.#write(`${this.#paint(`[${style.label}]`, style.color)} ${text}\n`);
    this.#atLineStart = true;
  }

  #paint(text: string, color: string): string {
    return this.#color ? `${color}${text}${ANSI.reset}` : text;
  }
}

function truncateForDisplay(text: string, max = 300): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, max)}…`;
}
