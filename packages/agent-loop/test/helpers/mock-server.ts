/**
 * A real HTTP server that speaks the Responses API streaming protocol.
 *
 * Tests run against actual `fetch` + `node:http` + chunked transfer encoding
 * rather than a stubbed fetch, so the SSE parser, the streaming decoder and the
 * client's error handling are all exercised end to end.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One scripted HTTP response. */
export interface MockTurn {
  /** HTTP status. Default 200. */
  status?: number;
  /** JSON body, used instead of SSE when `status` is an error code. */
  json?: unknown;
  /** SSE event payloads; serialised as `event:`/`data:` frames. */
  events?: readonly unknown[];
  /** Raw SSE text, for hand-crafted edge cases. Overrides `events`. */
  raw?: string;
  /**
   * Split the response body into pieces of this many bytes before writing.
   * Small values deliberately break lines and UTF-8 sequences across chunks.
   */
  chunkSize?: number;
  /** Delay between chunks, in ms. */
  chunkDelayMs?: number;
  /** Extra response headers. */
  headers?: Record<string, string>;
  /** Close the connection abruptly instead of ending the response cleanly. */
  destroy?: boolean;
}

/** A captured inbound request. */
export interface MockRequestRecord {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  /** Parsed JSON body, or undefined when the body was not JSON. */
  body: Record<string, unknown> | undefined;
  rawBody: string;
  /** True when the client sent `Accept: text/event-stream`. */
  streaming: boolean;
}

export type MockTurnHandler = (
  request: MockRequestRecord,
  index: number,
) => MockTurn | Promise<MockTurn>;

export interface MockResponsesServer {
  /** Base URL to pass as `baseURL`, e.g. `http://127.0.0.1:PORT/v1`. */
  url: string;
  port: number;
  /** Every request received, in order. */
  readonly requests: MockRequestRecord[];
  /** Close the server. */
  close(): Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function serialiseEvents(events: readonly unknown[]): string {
  const frames: string[] = [];
  for (const event of events) {
    const type =
      typeof event === 'object' && event !== null && typeof (event as { type?: unknown }).type === 'string'
        ? (event as { type: string }).type
        : undefined;
    if (type !== undefined) frames.push(`event: ${type}\n`);
    frames.push(`data: ${JSON.stringify(event)}\n\n`);
  }
  return frames.join('');
}

async function writeBody(
  response: ServerResponse,
  text: string,
  turn: MockTurn,
): Promise<void> {
  const buffer = Buffer.from(text, 'utf8');
  const chunkSize = turn.chunkSize ?? buffer.length;

  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    response.write(buffer.subarray(offset, offset + chunkSize));
    if (turn.chunkDelayMs !== undefined && turn.chunkDelayMs > 0) {
      await delay(turn.chunkDelayMs);
    } else {
      // Yield so the client observes genuinely separate chunks.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  response.end();
}

/**
 * Start a mock Responses API server.
 *
 * The handler is called once per request with the parsed body and the
 * zero-based request index, and returns the response to send.
 */
export async function startMockResponsesServer(
  handler: MockTurnHandler,
): Promise<MockResponsesServer> {
  const requests: MockRequestRecord[] = [];

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const rawBody = await readBody(request);
      let parsed: Record<string, unknown> | undefined;
      try {
        const value: unknown = JSON.parse(rawBody);
        if (typeof value === 'object' && value !== null) parsed = value as Record<string, unknown>;
      } catch {
        parsed = undefined;
      }

      const record: MockRequestRecord = {
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        headers: request.headers,
        body: parsed,
        rawBody,
        streaming: (request.headers.accept ?? '').includes('text/event-stream'),
      };
      requests.push(record);

      if (!record.url.includes('/responses')) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }

      let turn: MockTurn;
      try {
        turn = await handler(record, requests.length - 1);
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ error: { message: error instanceof Error ? error.message : 'handler failed' } }),
        );
        return;
      }

      const status = turn.status ?? 200;

      if (status !== 200) {
        response.writeHead(status, {
          'content-type': 'application/json',
          'x-request-id': 'req_mock_error',
          ...turn.headers,
        });
        response.end(JSON.stringify(turn.json ?? { error: { message: 'mock error' } }));
        return;
      }

      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        ...turn.headers,
      });

      if (turn.destroy === true) {
        // Write a partial body, then drop the connection without the final
        // chunked-encoding terminator, so the client sees a genuine failure
        // rather than a clean end of stream.
        response.write(turn.raw ?? serialiseEvents(turn.events ?? []));
        await new Promise((resolve) => setImmediate(resolve));
        response.socket?.destroy();
        return;
      }

      const text = turn.raw ?? serialiseEvents(turn.events ?? []);
      await writeBody(response, text, turn);
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    port: address.port,
    requests,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}
