import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CliUsageError, DEFAULT_MAX_STEPS, DEFAULT_MODEL, parseArgs } from '../src/args.ts';
import type { CliOptions, ParseContext } from '../src/args.ts';

/** Parse with a scrubbed environment so the host machine cannot leak in. */
function parse(argv: readonly string[], context: Partial<ParseContext> = {}): CliOptions {
  return parseArgs(argv, { env: {}, isTTY: false, ...context });
}

function expectUsageError(argv: readonly string[], pattern: RegExp): void {
  assert.throws(
    () => parse(argv),
    (error: unknown) => {
      assert.ok(error instanceof CliUsageError, `expected CliUsageError, got ${String(error)}`);
      assert.match(error.message, pattern);
      return true;
    },
  );
}

test('defaults to interactive mode with sane values', () => {
  const options = parse([]);

  assert.equal(options.mode, 'interactive');
  assert.equal(options.model, DEFAULT_MODEL);
  assert.equal(options.baseURL, undefined);
  assert.equal(options.prompt, undefined);
  assert.equal(options.instructions, undefined);
  assert.equal(options.maxSteps, DEFAULT_MAX_STEPS);
  assert.equal(options.effort, 'low');
  assert.equal(options.summary, 'auto');
  assert.equal(options.useReasoning, true);
  assert.equal(options.useTools, true);
  assert.equal(options.verbose, false);
  assert.equal(options.color, false);
});

test('reads the model and base URL from the environment', () => {
  const options = parse([], {
    env: { OPENAI_MODEL: 'gpt-4.1-mini', OPENAI_BASE_URL: 'https://example.test/v1' },
  });
  assert.equal(options.model, 'gpt-4.1-mini');
  assert.equal(options.baseURL, 'https://example.test/v1');
});

test('explicit flags override the environment', () => {
  const options = parse(['--model', 'o4-mini', '--base-url', 'http://localhost:8080/v1'], {
    env: { OPENAI_MODEL: 'gpt-4.1-mini', OPENAI_BASE_URL: 'https://example.test/v1' },
  });
  assert.equal(options.model, 'o4-mini');
  assert.equal(options.baseURL, 'http://localhost:8080/v1');
});

test('a prompt switches to one-shot mode', () => {
  assert.equal(parse(['-p', 'hello']).mode, 'one-shot');
  assert.equal(parse(['-p', 'hello']).prompt, 'hello');
  assert.equal(parse(['--prompt', 'hello there']).prompt, 'hello there');
});

test('parses instructions, max steps and colour', () => {
  const options = parse(['--instructions', 'Be terse.', '--max-steps', '3', '--no-color']);
  assert.equal(options.instructions, 'Be terse.');
  assert.equal(options.maxSteps, 3);
  assert.equal(options.color, false);
});

test('defaults colour to whether stdout is a TTY', () => {
  assert.equal(parse([], { isTTY: true }).color, true);
  assert.equal(parse([], { isTTY: false }).color, false);
  assert.equal(parse(['--no-color'], { isTTY: true }).color, false);
});

test('parses reasoning effort and summary', () => {
  for (const effort of ['minimal', 'low', 'medium', 'high'] as const) {
    assert.equal(parse(['--effort', effort]).effort, effort);
  }
  for (const summary of ['auto', 'concise', 'detailed'] as const) {
    assert.equal(parse(['--summary', summary]).summary, summary);
  }
});

test('--no-reasoning turns reasoning off', () => {
  assert.equal(parse(['--no-reasoning']).useReasoning, false);
  // The effort/summary values keep their defaults; the flag is what gates them.
  assert.equal(parse(['--no-reasoning']).effort, 'low');
});

test('--no-tools and --verbose are parsed', () => {
  assert.equal(parse(['--no-tools']).useTools, false);
  assert.equal(parse(['-v']).verbose, true);
  assert.equal(parse(['--verbose']).verbose, true);
});

test('--help returns help mode immediately', () => {
  assert.equal(parse(['--help']).mode, 'help');
  assert.equal(parse(['-h']).mode, 'help');
  // Parsing stops at --help, so later flags are not validated.
  assert.equal(parse(['--help', '--bogus']).mode, 'help');
});

test('rejects unknown options with the offending flag', () => {
  expectUsageError(['--bogus'], /Unknown option "--bogus"/);
  expectUsageError(['-x'], /Unknown option "-x"/);
});

test('rejects options that are missing their value', () => {
  expectUsageError(['--model'], /--model requires a value/);
  expectUsageError(['-p'], /-p requires a value/);
  expectUsageError(['--max-steps'], /--max-steps requires a value/);
  expectUsageError(['--instructions'], /--instructions requires a value/);
});

test('rejects invalid --max-steps values', () => {
  expectUsageError(['--max-steps', '0'], /expects a positive integer/);
  expectUsageError(['--max-steps', '-1'], /expects a positive integer/);
  expectUsageError(['--max-steps', 'abc'], /expects a positive integer/);
  expectUsageError(['--max-steps', '1.5'], /expects a positive integer/);
  expectUsageError(['--max-steps', ''], /expects a positive integer/);
  // Whitespace and leading zeros are tolerated.
  assert.equal(parse(['--max-steps', ' 03 ']).maxSteps, 3);
});

test('rejects invalid --effort and --summary values', () => {
  expectUsageError(['--effort', 'maximum'], /--effort expects minimal\|low\|medium\|high/);
  expectUsageError(['--summary', 'verbose'], /--summary expects auto\|concise\|detailed/);
});

test('parses a full realistic command line', () => {
  const options = parse(
    [
      '--model', 'gpt-5',
      '--effort', 'medium',
      '--summary', 'detailed',
      '--max-steps', '6',
      '--instructions', 'Be concise.',
      '--verbose',
      '-p', 'What is 2+2?',
    ],
    { isTTY: true, env: { OPENAI_BASE_URL: 'https://gateway.test/v1' } },
  );

  assert.deepEqual(options, {
    mode: 'one-shot',
    model: 'gpt-5',
    baseURL: 'https://gateway.test/v1',
    prompt: 'What is 2+2?',
    instructions: 'Be concise.',
    maxSteps: 6,
    effort: 'medium',
    summary: 'detailed',
    useReasoning: true,
    useTools: true,
    verbose: true,
    color: true,
  });
});
