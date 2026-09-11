/**
 * Tool registry: registration, schema surfaced to the model, and guarded
 * execution.
 *
 * Execution never throws. Every failure mode — unknown tool, malformed JSON
 * arguments, schema violations, a thrown implementation, a timeout — is turned
 * into a structured observation that is handed back to the model, so the ReAct
 * loop can recover instead of crashing.
 */

import type { FunctionTool } from '../openai/types.ts';
import { errorMessage } from '../util/errors.ts';
import { validateAgainstSchema } from './types.ts';
import type {
  AnyToolDefinition,
  ToolContext,
  ToolExecutionResult,
  ToolDefinition,
} from './types.ts';

/** A tool call as produced by the model. */
export interface ToolInvocation {
  callId: string;
  name: string;
  /** Raw JSON string. */
  arguments: string;
  /** Parsed arguments, when parsing succeeded. */
  args: unknown;
  /** Set when the arguments could not be parsed. */
  parseError?: string;
}

export interface ToolExecuteOptions {
  step: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputChars?: number;
  log?: (message: string) => void;
}

export interface ToolRegistryOptions {
  tools?: readonly AnyToolDefinition[];
  /** Per-tool execution timeout. Default 60s. */
  timeoutMs?: number;
  /** Observations longer than this are truncated. Default 30_000 chars. */
  maxOutputChars?: number;
  log?: (message: string) => void;
}

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 30_000;

/** Render a tool return value as the observation string. */
function stringifyResult(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'null';
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n…[truncated ${omitted} characters]`;
}

export class ToolRegistry {
  readonly #tools = new Map<string, AnyToolDefinition>();
  readonly #timeoutMs: number;
  readonly #maxOutputChars: number;
  readonly #log: ((message: string) => void) | undefined;

  constructor(options: ToolRegistryOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    this.#log = options.log;
    if (options.tools !== undefined)
      this.registerAll(options.tools);
  }

  /**
   * Accept a registry, a list of tools, or nothing.
   *
   * Lets callers pass `tools: [myTool]` or `tools: registry` interchangeably.
   */
  static from(
    input: ToolRegistry | readonly AnyToolDefinition[] | undefined,
    options: Omit<ToolRegistryOptions, 'tools'> = {},
  ): ToolRegistry {
    if (input instanceof ToolRegistry) return input;
    return new ToolRegistry({ ...options, tools: input ?? [] });
  }

  register(tool: AnyToolDefinition): this {
    const name = tool.name;
    if (!TOOL_NAME_PATTERN.test(name)) {
      throw new Error(
        `Invalid tool name "${name}": must match ${TOOL_NAME_PATTERN.source}`,
      );
    }
    if (this.#tools.has(name)) {
      throw new Error(`Tool "${name}" is already registered`);
    }
    if (typeof tool.execute !== 'function') {
      throw new Error(`Tool "${name}" must define an execute function`);
    }
    this.#tools.set(name, tool);
    return this;
  }

  registerAll(tools: readonly AnyToolDefinition[]): this {
    for (const tool of tools) this.register(tool);
    return this;
  }

  unregister(name: string): boolean {
    return this.#tools.delete(name);
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  get(name: string): AnyToolDefinition | undefined {
    return this.#tools.get(name);
  }

  get size(): number {
    return this.#tools.size;
  }

  names(): string[] {
    return [...this.#tools.keys()];
  }

  list(): AnyToolDefinition[] {
    return [...this.#tools.values()];
  }

  /** Tools in the flat **Responses API** function format. */
  toFunctionTools(): FunctionTool[] {
    return this.list().map((tool) => {
      const descriptor: FunctionTool = {
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as unknown as Record<string, unknown>,
      };
      if (tool.strict !== undefined) descriptor.strict = tool.strict;
      return descriptor;
    });
  }

  /** Run one tool call, converting every failure into an observation string. */
  async execute(
    invocation: ToolInvocation,
    options: ToolExecuteOptions,
  ): Promise<ToolExecutionResult> {
    const startedAt = Date.now();
    const { callId, name } = invocation;

    const finish = (
      ok: boolean,
      output: string,
      error?: string,
      args?: unknown,
    ): ToolExecutionResult => {
      const result: ToolExecutionResult = {
        callId,
        name,
        ok,
        output,
        durationMs: Date.now() - startedAt,
      };
      if (error !== undefined) result.error = error;
      if (args !== undefined) result.args = args;
      return result;
    };

    const fail = (message: string, args?: unknown): ToolExecutionResult =>
      finish(false, JSON.stringify({ error: message }), message, args);

    const tool = this.#tools.get(name);
    if (tool === undefined) {
      const available = this.names();
      const hint =
        available.length === 0
          ? 'No tools are available.'
          : `Available tools: ${available.join(', ')}.`;
      return fail(`Unknown tool "${name}". ${hint}`);
    }

    if (invocation.parseError !== undefined) {
      return fail(
        `Could not parse arguments for "${name}": ${invocation.parseError}. ` +
        'Respond with arguments that are a single valid JSON object.',
      );
    }

    const args = invocation.args ?? {};
    const validationErrors = validateAgainstSchema(tool.parameters, args);
    if (validationErrors.length > 0) {
      return fail(
        `Invalid arguments for "${name}": ${validationErrors.join('; ')}. ` +
        `Expected schema: ${JSON.stringify(tool.parameters)}`,
        args,
      );
    }

    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const maxOutputChars = options.maxOutputChars ?? this.#maxOutputChars;

    // Own controller so a timeout can also signal cancellation to the tool.
    const controller = new AbortController();
    const external = options.signal;
    const onExternalAbort = (): void => controller.abort();
    if (external !== undefined) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', onExternalAbort, { once: true });
    }

    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    // Racing the tool against this promise is what actually enforces the
    // timeout: aborting the signal alone only helps tools that honour it.
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      if (timeoutMs <= 0) return;
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error(`Tool "${name}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    const context: ToolContext = {
      signal: controller.signal,
      callId,
      step: options.step,
      log: options.log ?? this.#log ?? (() => { }),
    };

    const toolPromise = Promise.resolve().then(() =>
      tool.execute(args as Record<string, unknown>, context),
    );

    try {
      const value = await Promise.race([toolPromise, timeoutPromise]);
      return finish(true, truncate(stringifyResult(value), maxOutputChars), undefined, args);
    } catch (error) {
      if (timedOut) {
        return fail(`Tool "${name}" timed out after ${timeoutMs}ms`, args);
      }
      if (controller.signal.aborted) {
        return fail(`Tool "${name}" was cancelled`, args);
      }
      return fail(`Tool "${name}" failed: ${errorMessage(error)}`, args);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
      // A tool that ignores cancellation may still settle after the race is
      // lost; keep its late rejection from becoming an unhandled rejection.
      toolPromise.catch(() => { });
    }
  }
}

export type { ToolDefinition };
