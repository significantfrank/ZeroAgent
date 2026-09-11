/**
 * Built-in example tools.
 *
 * They are deliberately dependency-free and side-effect-light so the demo and
 * the test suite can run fully offline, while still exercising the interesting
 * parts of the loop: argument validation, structured returns, thrown errors and
 * cross-step state.
 */

import { evaluateExpression } from './calculator.ts';
import { defineTool } from './types.ts';
import type { ToolDefinition } from './types.ts';

/** Safe arithmetic evaluation — no `eval`, no arbitrary code execution. */
export const calculatorTool = defineTool({
  name: 'calculator',
  description:
    'Evaluate an arithmetic expression and return the numeric result. ' +
    'Supports + - * / % ^ (and ** for power), parentheses, the constants pi/e/tau, ' +
    'and functions such as sqrt, abs, min, max, round, floor, ceil, log, exp, sin, cos, tan.',
  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'The expression to evaluate, e.g. "(17 * 3 + 4) / 5" or "sqrt(2) * 10".',
        minLength: 1,
      },
    },
    required: ['expression'],
    additionalProperties: false,
  },
  execute(args: { expression: string }) {
    const result = evaluateExpression(args.expression);
    return { expression: args.expression, result };
  },
});

/** Current date/time, optionally in a named IANA time zone. */
export const currentTimeTool = defineTool({
  name: 'current_time',
  description:
    'Get the current date and time. Optionally pass an IANA time zone name ' +
    '(for example "Asia/Shanghai" or "UTC") to get the time in that zone.',
  parameters: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: 'IANA time zone name. Defaults to UTC.',
      },
    },
    required: [],
    additionalProperties: false,
  },
  execute(args: { timezone?: string }, context) {
    const timezone = args.timezone ?? 'UTC';
    const now = new Date();

    let formatted: string;
    try {
      formatted = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        dateStyle: 'full',
        timeStyle: 'long',
      }).format(now);
    } catch {
      throw new Error(
        `Unknown time zone "${timezone}". Use an IANA name such as "UTC", "Europe/London" or "Asia/Shanghai".`,
      );
    }

    context.log(`resolved current time in ${timezone}`);
    return {
      timezone,
      iso8601: now.toISOString(),
      epochMs: now.getTime(),
      formatted,
    };
  },
});

/**
 * A scratchpad the model can use to persist notes between steps.
 *
 * Demonstrates a stateful tool: the store lives in the closure returned by this
 * factory, so each agent gets its own isolated memory.
 */
export function createMemoryTool(): ToolDefinition<
  { action: 'set' | 'get' | 'list' | 'delete'; key?: string; value?: string },
  unknown
> {
  const store = new Map<string, string>();

  return defineTool({
    name: 'memory',
    description:
      'Read and write short notes that persist for the duration of the task. ' +
      'Use "set" to store a key/value pair, "get" to read one back, "list" to see all keys, ' +
      'and "delete" to remove one.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set', 'get', 'list', 'delete'] },
        key: { type: 'string', description: 'Required for "set", "get" and "delete".' },
        value: { type: 'string', description: 'Required for "set".' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    execute(args: { action: 'set' | 'get' | 'list' | 'delete'; key?: string; value?: string }) {
      const { action, key, value } = args;

      if (action === 'list') return { keys: [...store.keys()] };

      if (key === undefined || key.length === 0) {
        throw new Error(`The "${action}" action requires a "key"`);
      }

      switch (action) {
        case 'set': {
          if (value === undefined) throw new Error('The "set" action requires a "value"');
          store.set(key, value);
          return { key, stored: true };
        }
        case 'get': {
          const found = store.get(key);
          return found === undefined ? { key, found: false } : { key, found: true, value: found };
        }
        case 'delete': {
          return { key, deleted: store.delete(key) };
        }
      }
    },
  });
}

/** A fresh set of the bundled example tools, including private memory state. */
export function builtinTools(): ToolDefinition[] {
  return [calculatorTool, currentTimeTool, createMemoryTool()];
}
