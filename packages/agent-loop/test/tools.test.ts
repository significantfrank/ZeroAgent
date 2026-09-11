import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ToolRegistry } from '../src/tools/registry.ts';
import { defineTool, validateAgainstSchema } from '../src/tools/types.ts';
import { builtinTools, calculatorTool, createMemoryTool } from '../src/tools/builtin.ts';

/* -------------------------------------------------------------------------- */
/* Schema validation                                                          */
/* -------------------------------------------------------------------------- */

test('accepts a value matching the schema', () => {
  const errors = validateAgainstSchema(
    {
      type: 'object',
      properties: { expression: { type: 'string' } },
      required: ['expression'],
      additionalProperties: false,
    },
    { expression: '1+1' },
  );
  assert.deepEqual(errors, []);
});

test('reports the wrong primitive type with a path', () => {
  const errors = validateAgainstSchema(
    { type: 'object', properties: { count: { type: 'integer' } } },
    { count: 'three' },
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /arguments\.count: expected integer, received string/);
});

test('rejects a non-integer number for an integer field', () => {
  const errors = validateAgainstSchema({ type: 'integer' }, 1.5);
  assert.match(errors[0] ?? '', /expected integer, received number/);
});

test('reports missing required properties', () => {
  const errors = validateAgainstSchema(
    { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    {},
  );
  assert.match(errors[0] ?? '', /arguments\.key: required property is missing/);
});

test('treats an explicitly undefined required property as missing', () => {
  const errors = validateAgainstSchema(
    { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    { key: undefined },
  );
  assert.equal(errors.length, 1);
});

test('rejects unexpected properties when additionalProperties is false', () => {
  const errors = validateAgainstSchema(
    { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
    { a: 'x', b: 'y' },
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /arguments\.b: unexpected property/);
});

test('validates enum membership', () => {
  const schema = { type: 'string' as const, enum: ['set', 'get'] };
  assert.deepEqual(validateAgainstSchema(schema, 'set'), []);
  assert.match(validateAgainstSchema(schema, 'drop')[0] ?? '', /must be one of "set", "get"/);
});

test('validates array items by index', () => {
  const errors = validateAgainstSchema(
    { type: 'array', items: { type: 'number' } },
    [1, 'two', 3],
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /arguments\[1\]: expected number, received string/);
});

test('validates nested objects', () => {
  const errors = validateAgainstSchema(
    {
      type: 'object',
      properties: {
        filter: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1 } },
          required: ['limit'],
        },
      },
    },
    { filter: { limit: 0 } },
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /arguments\.filter\.limit: must be >= 1/);
});

test('enforces string length and numeric bounds', () => {
  assert.match(validateAgainstSchema({ type: 'string', minLength: 3 }, 'ab')[0] ?? '', /at least 3/);
  assert.match(validateAgainstSchema({ type: 'string', maxLength: 2 }, 'abc')[0] ?? '', /at most 2/);
  assert.match(validateAgainstSchema({ type: 'number', maximum: 5 }, 6)[0] ?? '', /must be <= 5/);
});

test('passes when any anyOf branch matches', () => {
  const schema = { anyOf: [{ type: 'string' as const }, { type: 'number' as const }] };
  assert.deepEqual(validateAgainstSchema(schema, 'text'), []);
  assert.deepEqual(validateAgainstSchema(schema, 42), []);
  assert.match(validateAgainstSchema(schema, true)[0] ?? '', /does not match any allowed schema variant/);
});

test('a schema with no type constraint accepts anything', () => {
  assert.deepEqual(validateAgainstSchema({}, { anything: true }), []);
  assert.deepEqual(validateAgainstSchema({}, null), []);
});

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

test('registers tools and exposes them in the flat Responses format', () => {
  const registry = new ToolRegistry({ tools: [calculatorTool] });
  const tools = registry.toFunctionTools();

  assert.equal(tools.length, 1);
  const tool = tools[0];
  assert.ok(tool !== undefined);
  // The Responses API uses a flat tool shape, not the nested Chat Completions one.
  assert.equal(tool.type, 'function');
  assert.equal(tool.name, 'calculator');
  assert.equal('function' in tool, false);
  assert.ok(tool.parameters !== null);
  assert.equal((tool.parameters as { type?: string }).type, 'object');
});

test('rejects duplicate registrations', () => {
  const registry = new ToolRegistry({ tools: [calculatorTool] });
  assert.throws(() => registry.register(calculatorTool), /already registered/);
});

test('rejects invalid tool names', () => {
  const registry = new ToolRegistry();
  const bad = defineTool({ name: 'has spaces', description: '', parameters: {}, execute: () => 1 });
  assert.throws(() => registry.register(bad), /Invalid tool name/);
});

test('ToolRegistry.from accepts a registry, a list, or undefined', () => {
  const registry = new ToolRegistry({ tools: [calculatorTool] });
  assert.equal(ToolRegistry.from(registry), registry);
  assert.equal(ToolRegistry.from([calculatorTool]).size, 1);
  assert.equal(ToolRegistry.from(undefined).size, 0);
});

test('names and size reflect the registered tools', () => {
  const registry = new ToolRegistry({ tools: builtinTools() });
  assert.equal(registry.size, 3);
  assert.deepEqual(registry.names().sort(), ['calculator', 'current_time', 'memory']);
  assert.equal(registry.has('calculator'), true);
  assert.equal(registry.has('nope'), false);
});

/* -------------------------------------------------------------------------- */
/* Execution                                                                  */
/* -------------------------------------------------------------------------- */

function invoke(name: string, args: unknown, extra: Record<string, unknown> = {}) {
  return {
    callId: 'call_1',
    name,
    arguments: JSON.stringify(args),
    args,
    ...extra,
  };
}

test('executes a tool and serialises an object result', async () => {
  const registry = new ToolRegistry({ tools: [calculatorTool] });
  const result = await registry.execute(invoke('calculator', { expression: '6*7' }), { step: 1 });

  assert.equal(result.ok, true);
  assert.equal(result.name, 'calculator');
  assert.equal(result.callId, 'call_1');
  assert.deepEqual(JSON.parse(result.output), { expression: '6*7', result: 42 });
  assert.ok(result.durationMs >= 0);
});

test('returns a string result verbatim', async () => {
  const registry = new ToolRegistry({
    tools: [defineTool({ name: 'echo', description: '', parameters: {}, execute: () => 'plain text' })],
  });
  const result = await registry.execute(invoke('echo', {}), { step: 1 });
  assert.equal(result.output, 'plain text');
});

test('turns an unknown tool into a recoverable observation', async () => {
  const registry = new ToolRegistry({ tools: [calculatorTool] });
  const result = await registry.execute(invoke('nope', {}), { step: 1 });

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /Unknown tool "nope"/);
  assert.match(result.output, /Available tools: calculator/);
  assert.deepEqual(JSON.parse(result.output), { error: result.error });
});

test('lists no tools when the registry is empty', async () => {
  const registry = new ToolRegistry();
  const result = await registry.execute(invoke('nope', {}), { step: 1 });
  assert.match(result.error ?? '', /No tools are available\./);
});

test('refuses to run a tool whose arguments failed to parse', async () => {
  const registry = new ToolRegistry({ tools: [calculatorTool] });
  const result = await registry.execute(
    { callId: 'c', name: 'calculator', arguments: '{bad', args: undefined, parseError: 'unexpected end of JSON' },
    { step: 1 },
  );

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /Could not parse arguments/);
  assert.match(result.error ?? '', /single valid JSON object/);
});

test('reports schema violations with the expected schema', async () => {
  const registry = new ToolRegistry({ tools: [calculatorTool] });
  const result = await registry.execute(invoke('calculator', {}), { step: 1 });

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /arguments\.expression: required property is missing/);
  assert.match(result.error ?? '', /Expected schema:/);
});

test('accepts explicit undefined args as an empty object', async () => {
  const registry = new ToolRegistry({
    tools: [
      defineTool({
        name: 'noargs',
        description: '',
        parameters: { type: 'object', properties: {} },
        execute: () => 'ran',
      }),
    ],
  });
  const result = await registry.execute(
    { callId: 'c', name: 'noargs', arguments: '', args: undefined },
    { step: 1 },
  );
  assert.equal(result.ok, true);
  assert.equal(result.output, 'ran');
});

test('captures a thrown tool error without failing the run', async () => {
  const registry = new ToolRegistry({ tools: [calculatorTool] });
  const result = await registry.execute(invoke('calculator', { expression: '1/0' }), { step: 1 });

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /Division by zero/);
});

test('captures a non-Error thrown value', async () => {
  const registry = new ToolRegistry({
    tools: [
      defineTool({
        name: 'thrower',
        description: '',
        parameters: {},
        execute: () => {
          throw 'a string failure';
        },
      }),
    ],
  });
  const result = await registry.execute(invoke('thrower', {}), { step: 1 });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /a string failure/);
});

test('enforces a per-tool timeout even when the tool ignores the signal', async () => {
  const registry = new ToolRegistry({
    tools: [
      defineTool({
        name: 'slow',
        description: '',
        parameters: {},
        // Deliberately never looks at context.signal, and takes far longer than
        // the timeout. `unref` keeps the pending timer from holding the test
        // process open once the assertion is done.
        execute: () =>
          new Promise<string>((resolve) => {
            const timer = setTimeout(() => resolve('too late'), 3000);
            timer.unref();
          }),
      }),
    ],
  });

  const startedAt = Date.now();
  const result = await registry.execute(invoke('slow', {}), { step: 1, timeoutMs: 15 });
  const elapsed = Date.now() - startedAt;

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /timed out after 15ms/);
  // The call must return on the timeout, not when the tool eventually settles.
  // The bound is deliberately loose so a loaded machine cannot flake it, while
  // still being far below the tool's own 3s duration.
  assert.ok(elapsed < 1000, `expected a prompt timeout, took ${elapsed}ms`);
});

test('signals cancellation to a tool through its context', async () => {
  let sawAbort = false;
  const registry = new ToolRegistry({
    tools: [
      defineTool({
        name: 'patient',
        description: '',
        parameters: {},
        execute: async (_args, context) => {
          await new Promise<void>((resolve) => {
            if (context.signal?.aborted === true) {
              sawAbort = true;
              resolve();
              return;
            }
            context.signal?.addEventListener('abort', () => {
              sawAbort = true;
              resolve();
            });
          });
          throw new Error('stopped by cancellation');
        },
      }),
    ],
  });

  const controller = new AbortController();
  const promise = registry.execute(invoke('patient', {}), { step: 1, signal: controller.signal });
  controller.abort();
  const result = await promise;

  assert.equal(sawAbort, true, 'the tool should observe the abort signal');
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /was cancelled/);
});

test('truncates an oversized observation', async () => {
  const registry = new ToolRegistry({
    tools: [
      defineTool({ name: 'big', description: '', parameters: {}, execute: () => 'x'.repeat(500) }),
    ],
    maxOutputChars: 100,
  });

  const result = await registry.execute(invoke('big', {}), { step: 1 });
  assert.equal(result.ok, true);
  assert.match(result.output, /truncated 400 characters/);
  assert.ok(result.output.startsWith('x'.repeat(100)));
});

test('passes the step and call id to the tool context', async () => {
  let seen: { step: number; callId: string } | undefined;
  const registry = new ToolRegistry({
    tools: [
      defineTool({
        name: 'ctx',
        description: '',
        parameters: {},
        execute: (_args, context) => {
          seen = { step: context.step, callId: context.callId };
          return 'ok';
        },
      }),
    ],
  });

  await registry.execute(invoke('ctx', {}), { step: 7 });
  assert.deepEqual(seen, { step: 7, callId: 'call_1' });
});

/* -------------------------------------------------------------------------- */
/* Built-in tools                                                             */
/* -------------------------------------------------------------------------- */

test('memory tool keeps state between calls', async () => {
  const registry = new ToolRegistry({ tools: [createMemoryTool()] });

  await registry.execute(invoke('memory', { action: 'set', key: 'name', value: 'Ada' }), { step: 1 });
  const got = await registry.execute(invoke('memory', { action: 'get', key: 'name' }), { step: 1 });
  assert.deepEqual(JSON.parse(got.output), { key: 'name', found: true, value: 'Ada' });

  const listed = await registry.execute(invoke('memory', { action: 'list' }), { step: 1 });
  assert.deepEqual(JSON.parse(listed.output), { keys: ['name'] });

  const deleted = await registry.execute(invoke('memory', { action: 'delete', key: 'name' }), { step: 1 });
  assert.deepEqual(JSON.parse(deleted.output), { key: 'name', deleted: true });

  const missing = await registry.execute(invoke('memory', { action: 'get', key: 'name' }), { step: 1 });
  assert.deepEqual(JSON.parse(missing.output), { key: 'name', found: false });
});

test('each memory tool instance is isolated', async () => {
  const first = new ToolRegistry({ tools: [createMemoryTool()] });
  const second = new ToolRegistry({ tools: [createMemoryTool()] });

  await first.execute(invoke('memory', { action: 'set', key: 'a', value: '1' }), { step: 1 });
  const other = await second.execute(invoke('memory', { action: 'list' }), { step: 1 });
  assert.deepEqual(JSON.parse(other.output), { keys: [] });
});

test('memory tool reports a missing key as a tool error', async () => {
  const registry = new ToolRegistry({ tools: [createMemoryTool()] });
  const result = await registry.execute(invoke('memory', { action: 'get' }), { step: 1 });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /requires a "key"/);
});

test('memory tool rejects an unknown action at the schema level', async () => {
  const registry = new ToolRegistry({ tools: [createMemoryTool()] });
  const result = await registry.execute(invoke('memory', { action: 'explode', key: 'k' }), { step: 1 });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /must be one of/);
});

test('current_time returns an ISO timestamp and honours a time zone', async () => {
  const registry = new ToolRegistry({ tools: builtinTools() });

  const utc = await registry.execute(invoke('current_time', {}), { step: 1 });
  assert.equal(utc.ok, true);
  const parsedUtc = JSON.parse(utc.output) as { timezone: string; iso8601: string };
  assert.equal(parsedUtc.timezone, 'UTC');
  assert.ok(!Number.isNaN(Date.parse(parsedUtc.iso8601)));

  const shanghai = await registry.execute(invoke('current_time', { timezone: 'Asia/Shanghai' }), { step: 1 });
  assert.equal(shanghai.ok, true);
  assert.equal((JSON.parse(shanghai.output) as { timezone: string }).timezone, 'Asia/Shanghai');
});

test('current_time rejects an unknown time zone', async () => {
  const registry = new ToolRegistry({ tools: builtinTools() });
  const result = await registry.execute(invoke('current_time', { timezone: 'Mars/Olympus' }), { step: 1 });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /Unknown time zone/);
});

test('builtinTools returns independently usable instances', () => {
  const first = builtinTools();
  const second = builtinTools();
  assert.equal(first.length, second.length);
  assert.notEqual(first[2], second[2], 'memory tools must not share state');
});

test('defineTool preserves concrete argument types', () => {
  const tool = defineTool({
    name: 'typed',
    description: 'typed args',
    parameters: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
    execute: (args: { count: number }) => args.count * 2,
  });
  assert.equal(tool.execute({ count: 21 }, { signal: undefined, callId: 'c', step: 1, log: () => {} }), 42);
});
