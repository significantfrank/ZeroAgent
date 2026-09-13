/**
 * A minimal streaming client for the OpenAI **Responses API**.
 *
 * It is intentionally built on `fetch` + `ReadableStream` with no SDK
 * dependency, which keeps the agent portable (Node, Bun, Deno, Workers) and
 * makes the streaming behaviour explicit and testable.
 */

import { parseSSEStream } from './sse.ts';
import { asResponseStreamEvent } from './types.ts';
import type { ResponseResource, ResponsesRequest, ResponseStreamEvent } from './types.ts';

/** Injectable fetch implementation, for tests and custom transports. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ResponsesClientOptions {
  /** Defaults to `process.env.OPENAI_API_KEY`. */
  apiKey?: string;
  /** Defaults to `process.env.OPENAI_BASE_URL`, then `https://api.openai.com/v1`. */
  baseURL?: string;
  organization?: string;
  project?: string;
  /** Extra default headers merged into every request. */
  headers?: Record<string, string>;
  /** Custom fetch implementation. Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Retries for connection failures and retryable HTTP statuses. Default 2. */
  maxRetries?: number;
  /** Base delay for exponential backoff. Default 500ms. */
  retryDelayMs?: number;
  /**
   * Total request timeout. Disabled by default, because a streaming response
   * for a long reasoning turn can legitimately take minutes.
   */
  timeoutMs?: number;
  /**
   * Called for every decoded event whose `type` this client does not model.
   * Useful for observing new API features without breaking the typed stream.
   */
  onUnknownEvent?: (payload: unknown) => void;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export class OpenAIError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly type: string | undefined;
  readonly param: string | undefined;
  readonly requestId: string | undefined;
  /** Whether retrying the same request could plausibly succeed. */
  readonly retryable: boolean;

  constructor(
    message: string,
    options: {
      status?: number;
      code?: string | null;
      type?: string | null;
      param?: string | null;
      requestId?: string | null;
      retryable?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OpenAIError';
    this.status = options.status;
    this.code = options.code ?? undefined;
    this.type = options.type ?? undefined;
    this.param = options.param ?? undefined;
    this.requestId = options.requestId ?? undefined;
    this.retryable = options.retryable ?? false;
  }
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const RETRYABLE_STATUS_CODES = new Set([408, 409, 429]);

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status) || status >= 500;
}

/** Parse a `Retry-After` header expressed as seconds or an HTTP date. */
function parseRetryAfter(header: string | null): number | undefined {
  if (header === null || header.length === 0) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function joinUrl(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, '')}${path}`;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/** Abortable sleep, used between retries. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new OpenAIError('Request aborted', { code: 'aborted' }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new OpenAIError('Request aborted', { code: 'aborted' }));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function backoffDelay(attempt: number, baseMs: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, 60_000);
  const exponential = baseMs * 2 ** attempt;
  // Full jitter, capped so a bad gateway cannot stall the loop for long.
  return Math.min(Math.random() * exponential + baseMs, 20_000);
}

export class ResponsesClient {
  private readonly apiKey: string | undefined;
  private readonly baseURL: string;
  private readonly organization: string | undefined;
  private readonly project: string | undefined;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: FetchLike;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly timeoutMs: number | undefined;
  private readonly onUnknownEvent: ((payload: unknown) => void) | undefined;

  constructor(options: ResponsesClientOptions = {}) {
    const env = typeof process === 'undefined' ? undefined : process.env;
    this.apiKey = options.apiKey ?? env?.OPENAI_API_KEY;
    this.baseURL = options.baseURL ?? env?.OPENAI_BASE_URL ?? DEFAULT_BASE_URL;
    this.organization = options.organization ?? env?.OPENAI_ORG_ID;
    this.project = options.project ?? env?.OPENAI_PROJECT_ID;
    this.headers = options.headers ?? {};
    // Bind so the global fetch keeps working when detached from globalThis.
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.timeoutMs = options.timeoutMs;
    this.onUnknownEvent = options.onUnknownEvent;
  }

  /**
   * Stream a response, yielding typed {@link ResponseStreamEvent}s.
   *
   * Retries are only attempted before the response body starts being consumed,
   * so a consumer never observes duplicated events.
   */
  async *stream(
    request: Omit<ResponsesRequest, 'stream'> & { stream?: boolean },
    options: RequestOptions = {},
  ): AsyncGenerator<ResponseStreamEvent, void, void> {
    const body = JSON.stringify({ ...request, stream: true });
    // console.log('=====> ' + body);
    const signal = this.#combineSignals(options.signal);
    // Built once, outside the retry loop: a configuration problem such as a
    // missing API key must surface as itself, not as a retryable connection
    // error, and must not be retried.
    const headers = this.#buildHeaders();

    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(joinUrl(this.baseURL, '/responses'), {
          method: 'POST',
          headers,
          body,
          signal,
        });
      } catch (error) {
        if (error instanceof OpenAIError) throw error;
        if (signal?.aborted === true || isAbortError(error)) {
          throw new OpenAIError('Request aborted', { code: 'aborted', cause: error });
        }
        const wrapped = new OpenAIError(
          `Failed to reach the Responses API: ${error instanceof Error ? error.message : String(error)}`,
          { code: 'connection_error', retryable: true, cause: error },
        );
        if (attempt >= this.maxRetries) throw wrapped;
        await sleep(backoffDelay(attempt, this.retryDelayMs), signal);
        continue;
      }

      if (!response.ok) {
        const error = await this.#toError(response);
        if (!error.retryable || attempt >= this.maxRetries) throw error;
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        await sleep(backoffDelay(attempt, this.retryDelayMs, retryAfter), signal);
        continue;
      }

      if (response.body === null) {
        throw new OpenAIError('Responses API returned an empty body for a streaming request', {
          status: response.status,
          requestId: response.headers.get('x-request-id'),
        });
      }
      // console.log('=====> '+response.body);

      try {
        for await (const message of parseSSEStream(response.body, { signal })) {
          const data = message.data.trim();
          // console.log('SSE:', message.data);
          if (data.length === 0)
            continue;
          // Some gateways terminate the stream with a literal [DONE] sentinel.
          if (data === '[DONE]')
            return;

          let payload: unknown;
          try {
            payload = JSON.parse(data);
          } catch {
            // A malformed frame should not kill an otherwise healthy stream.
            continue;
          }

          const event = asResponseStreamEvent(payload);
          if (event === undefined) {
            this.onUnknownEvent?.(payload);
            continue;
          }
          yield event;
        }
      } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) {
          throw new OpenAIError('Request aborted', { code: 'aborted', cause: error });
        }
        if (error instanceof OpenAIError) throw error;
        // The body was already partially consumed: retrying would duplicate
        // events, so surface the failure instead.
        throw new OpenAIError(
          `Stream failed mid-response: ${error instanceof Error ? error.message : String(error)}`,
          { code: 'stream_error', retryable: false, cause: error },
        );
      }
      return;
    }
  }

  /** Non-streaming request, for callers that do not need incremental output. */
  async create(
    request: Omit<ResponsesRequest, 'stream'>,
    options: RequestOptions = {},
  ): Promise<ResponseResource> {
    const signal = this.#combineSignals(options.signal);
    const response = await this.fetchImpl(joinUrl(this.baseURL, '/responses'), {
      method: 'POST',
      headers: this.#buildHeaders(),
      body: JSON.stringify({ ...request, stream: false }),
      signal,
    });
    if (!response.ok) throw await this.#toError(response);
    return (await response.json()) as ResponseResource;
  }

  #combineSignals(signal: AbortSignal | undefined): AbortSignal | undefined {
    if (this.timeoutMs === undefined) return signal;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    if (signal === undefined) return timeout;
    return AbortSignal.any([signal, timeout]);
  }

  #buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...this.headers,
    };
    if (this.apiKey !== undefined && this.apiKey.length > 0) {
      headers.authorization = `Bearer ${this.apiKey}`;
    } else if (this.baseURL.includes('api.openai.com')) {
      throw new OpenAIError(
        'Missing API key: set OPENAI_API_KEY or pass `apiKey` to the ResponsesClient',
        { code: 'missing_api_key' },
      );
    }
    if (this.organization !== undefined) headers['openai-organization'] = this.organization;
    if (this.project !== undefined) headers['openai-project'] = this.project;
    return headers;
  }

  /** Convert a non-2xx response into a rich {@link OpenAIError}. */
  async #toError(response: Response): Promise<OpenAIError> {
    const requestId = response.headers.get('x-request-id');
    const text = await response.text().catch(() => '');

    let message = `Responses API request failed with status ${response.status}`;
    let code: string | null | undefined;
    let type: string | null | undefined;
    let param: string | null | undefined;

    if (text.length > 0) {
      try {
        const parsed = JSON.parse(text) as {
          error?: { message?: string; code?: string | null; type?: string | null; param?: string | null };
          message?: string;
        };
        const detail = parsed.error ?? parsed;
        if (typeof detail.message === 'string' && detail.message.length > 0) {
          message = detail.message;
        } else {
          message = text.slice(0, 500);
        }
        code = 'code' in detail ? detail.code : undefined;
        type = 'type' in detail ? detail.type : undefined;
        param = 'param' in detail ? detail.param : undefined;
      } catch {
        message = text.slice(0, 500);
      }
    }

    return new OpenAIError(message, {
      status: response.status,
      code,
      type,
      param,
      requestId,
      retryable: isRetryableStatus(response.status),
    });
  }
}
