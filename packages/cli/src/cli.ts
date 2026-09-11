#!/usr/bin/env node
/**
 * Interactive ReAct agent CLI.
 *
 * Run from the repo root:  pnpm cli -- --model gpt-5
 * Or directly:             node packages/cli/dist/cli.js -p "What is 2+2?"
 *
 * Streaming output is rendered per channel, so the model's reasoning, its answer
 * text and its tool traffic are visually distinct instead of interleaved.
 */

import { createInterface } from 'node:readline/promises';
import { existsSync } from 'node:fs';

import {
  ConsoleRenderer,
  ReActAgent,
  ResponsesClient,
  builtinTools,
  userMessage,
} from '@zero-agent/agent-loop';
import type { AgentResult, ReActAgentOptions, ResponseInputItem } from '@zero-agent/agent-loop';

import { CliUsageError, HELP, parseArgs } from './args.ts';
import type { CliOptions } from './args.ts';

/** Drive one prompt to completion, rendering every event as it arrives. */
async function runOnce(
  agent: ReActAgent,
  renderer: ConsoleRenderer,
  input: string | ResponseInputItem[],
  options: { signal?: AbortSignal },
): Promise<AgentResult> {
  const result = await agent.runWithCallbacks(
    input,
    { onEvent: (event) => renderer.render(event) },
    options.signal === undefined ? {} : { signal: options.signal },
  );
  renderer.flush();
  return result;
}

function buildAgentAndRenderer(options: CliOptions): {
  agent: ReActAgent;
  renderer: ConsoleRenderer;
} {
  const renderer = new ConsoleRenderer({
    color: options.color,
    showReasoning: options.useReasoning,
    showStatus: options.verbose,
  });

  const agentOptions: ReActAgentOptions = {
    client: new ResponsesClient(
      options.baseURL === undefined ? {} : { baseURL: options.baseURL },
    ),
    model: options.model,
    maxSteps: options.maxSteps,
    tools: options.useTools ? builtinTools() : [],
  };

  if (options.instructions !== undefined)
    agentOptions.instructions = options.instructions;

  if (options.useReasoning) {
    agentOptions.reasoning = { effort: options.effort, summary: options.summary };
  }

  return { agent: new ReActAgent(agentOptions), renderer };
}

async function runOneShot(
  agent: ReActAgent,
  renderer: ConsoleRenderer,
  prompt: string,
): Promise<number> {
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());

  try {
    const result = await runOnce(agent, renderer, prompt, { signal: controller.signal });
    if (result.stopReason === 'failed') {
      process.stderr.write(`\n${result.error ?? 'the run failed'}\n`);
      return 1;
    }
    return 0;
  } catch (error) {
    process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function runInteractive(
  agent: ReActAgent,
  renderer: ConsoleRenderer,
  options: CliOptions,
): Promise<number> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  readline.on('close', () => {
    closed = true;
  });

  let conversation: ResponseInputItem[] = [];
  let activeRun: AbortController | undefined;

  // First Ctrl-C aborts the current run; a second one exits.
  process.on('SIGINT', () => {
    if (activeRun !== undefined && !activeRun.signal.aborted) {
      activeRun.abort();
      process.stdout.write('\n^C — run aborted\n');
      return;
    }
    readline.close();
  });

  process.stdout.write(
    `zero-agent · model=${options.model} · ` +
    `tools=${options.useTools ? agent.tools.names().join(', ') : 'none'}\n` +
    'Type a message, /reset to clear history, /exit to quit.\n\n',
  );

  for (; ;) {
    if (closed) break;
    const answer = await readline.question('you › ').catch(() => null);
    if (answer === null) break;

    const line = answer.trim();
    if (line.length === 0) continue;
    if (line === '/exit' || line === '/quit' || line === 'exit' || line === 'quit') break;
    if (line === '/reset') {
      conversation = [];
      process.stdout.write('history cleared\n');
      continue;
    }

    const controller = new AbortController();
    activeRun = controller;
    try {
      const result = await runOnce(agent, renderer, [...conversation, userMessage(line)], {
        signal: controller.signal,
      });
      // A failed or aborted turn is not worth keeping in the transcript.
      if (result.stopReason !== 'failed' && result.stopReason !== 'aborted') {
        conversation = result.messages;
      }
    } catch (error) {
      process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      activeRun = undefined;
    }
    process.stdout.write('\n');
  }

  readline.close();
  return 0;
}

async function main(): Promise<number> {
  if (existsSync('.env')) process.loadEnvFile('.env');

  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2), {
      env: process.env,
      isTTY: process.stdout.isTTY === true,
    });
  } catch (error) {
    if (error instanceof CliUsageError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  }

  if (options.mode === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  const { agent, renderer } = buildAgentAndRenderer(options);

  if (options.mode === 'one-shot') {
    return runOneShot(agent, renderer, options.prompt ?? '');
  }

  if (process.stdin.isTTY !== true) {
    process.stderr.write(
      'No TTY detected. Pass -p "<prompt>" for a one-shot run, or pipe a prompt on stdin.\n',
    );
  }
  return runInteractive(agent, renderer, options);
}

process.exitCode = await main();
