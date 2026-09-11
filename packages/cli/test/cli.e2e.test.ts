import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// The mock Responses API server is owned by the library package's test helpers.
// Importing a sibling package's test source is a workspace-internal convenience:
// it keeps a single implementation of the SSE protocol fixture.
import { startMockResponsesServer } from '../../agent-loop/test/helpers/mock-server.ts';
import { buildTurn } from '../../agent-loop/test/helpers/responses-script.ts';

const CLI_ENTRY = join(import.meta.dirname, '..', 'dist', 'cli.js');

interface CliRun {
  code: number;
  output: string;
}

function spawnCli(args: readonly string[], env: NodeJS.ProcessEnv): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, output }));
  });
}

/** Run the built CLI with a placeholder key, so no real credential is needed. */
function runCli(args: readonly string[]): Promise<CliRun> {
  return spawnCli(args, { ...process.env, OPENAI_API_KEY: 'test-key' });
}

/** Run the CLI in an environment with no API key at all. */
function runCliWithoutApiKey(args: readonly string[]): Promise<CliRun> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.OPENAI_API_KEY;
  return spawnCli(args, env);
}

/**
 * These tests execute the **built** CLI, which is what actually exercises the
 * monorepo wiring: the CLI resolves `@zero-agent/agent-loop` through the
 * workspace symlink into the library's `dist`, then streams over real HTTP.
 *
 * `pnpm test` at the repo root builds first, so `dist` is present there. When
 * run against a cold tree the suite skips rather than failing confusingly.
 */
const built = existsSync(CLI_ENTRY);
const skip = built ? false : 'dist/cli.js is missing — run `pnpm build` first';

test('runs a full ReAct turn against a streaming server', { skip }, async () => {
  const server = await startMockResponsesServer((_request, index) => {
    const turns = [
      {
        reasoning: ['I should compute this with the calculator.'],
        content: ['Let me calculate that.'],
        toolCalls: [{ name: 'calculator', args: { expression: '(17 * 3 + 4) / 5' }, argChunkSize: 6 }],
      },
      { reasoning: ['The tool returned 11.'], content: ['The answer is 11.'] },
    ];
    const turn = turns[Math.min(index, turns.length - 1)];
    if (turn === undefined) throw new Error(`unexpected request #${index}`);
    // Fragment the body so the SSE parser is exercised across chunk boundaries.
    return { events: buildTurn(turn), chunkSize: 32 };
  });

  try {
    const { code, output } = await runCli([
      '--base-url',
      server.url,
      '--no-color',
      '-p',
      'What is (17*3+4)/5?',
    ]);

    assert.equal(code, 0, `CLI exited ${code}:\n${output}`);

    // Each of the three channels must reach the terminal distinctly.
    assert.match(output, /\[reasoning\] I should compute this with the calculator\./);
    assert.match(output, /\[content\] Let me calculate that\./);
    assert.match(output, /\[tool_call\] calculator\(\{"expression":"\(17 \* 3 \+ 4\) \/ 5"\}\)/);
    assert.match(output, /\[tool_result\] ✓ calculator \([\d.]+ms\)/);
    assert.match(output, /\[content\] The answer is 11\./);

    // Argument JSON must have streamed in pieces before the completed call.
    assert.match(output, /\[tool_call\] \{"expression":"\(17 \* 3 \+ 4\) \/ 5"\}/);

    // Two model turns, and the second carried the tool observation back.
    assert.equal(server.requests.length, 2);
    const secondInput = server.requests[1]?.body?.input;
    assert.ok(Array.isArray(secondInput), 'the second request must send an item list');

    const observation = (secondInput as Array<Record<string, unknown>>).find(
      (item) => item.type === 'function_call_output',
    );
    assert.ok(observation !== undefined, 'the observation must be replayed to the model');
    assert.equal(observation.call_id, 'call_mock_1');
    assert.deepEqual(JSON.parse(observation.output as string), {
      expression: '(17 * 3 + 4) / 5',
      result: 11,
    });
  } finally {
    await server.close();
  }
});

test('--help exits 0 and documents the options', { skip }, async () => {
  const { code, output } = await runCli(['--help']);
  assert.equal(code, 0);
  assert.match(output, /--prompt/);
  assert.match(output, /--effort/);
});

test('an unknown flag exits 2 with a usage message', { skip }, async () => {
  const { code, output } = await runCli(['--definitely-not-a-flag']);
  assert.equal(code, 2);
  assert.match(output, /Unknown option "--definitely-not-a-flag"/);
});

test('a missing API key exits 1 with a clear message', { skip }, async () => {
  // No key, and a base URL that requires one. The client rejects before making
  // any network call, so this stays offline-safe.
  const { code, output } = await runCliWithoutApiKey(['-p', 'hi']);
  assert.equal(code, 1, `expected exit 1, got ${code}:\n${output}`);
  assert.match(output, /Missing API key/);
});
