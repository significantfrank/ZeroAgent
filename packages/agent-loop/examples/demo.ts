#!/usr/bin/env node
/**
 * End-to-end demo: a full ReAct run with the three output channels rendered
 * separately.
 *
 * Without `OPENAI_API_KEY` the demo drives the agent against a local mock
 * Responses API server, so the streaming behaviour, the channel separation and
 * the tool round-trip are all observable offline. Set `OPENAI_API_KEY` to run
 * the same flow against the real API:
 *
 *   node examples/demo.ts
 *   OPENAI_API_KEY=sk-... node examples/demo.ts --live
 */

import { ReActAgent } from '../src/agent/loop.ts';
import type { ReActAgentOptions } from '../src/agent/loop.ts';
import { ConsoleRenderer } from '../src/agent/display.ts';
import type { AgentChannel, AgentEvent } from '../src/agent/events.ts';
import { ResponsesClient } from '../src/openai/responses.ts';
import { builtinTools } from '../src/tools/builtin.ts';
import { startMockResponsesServer } from '../test/helpers/mock-server.ts';
import { buildTurn } from '../test/helpers/responses-script.ts';

const QUESTION = 'What is (17 * 3 + 4) / 5? Then tell me the current time in UTC.';

function banner(text: string): void {
  process.stdout.write(`\n${'─'.repeat(72)}\n${text}\n${'─'.repeat(72)}\n`);
}

/**
 * Show what a consumer can do with the typed events: instead of printing them,
 * route each channel to its own destination.
 */
function summariseChannels(events: readonly AgentEvent[]): void {
  const byChannel = new Map<AgentChannel, string[]>();
  const push = (channel: AgentChannel, item: string): void => {
    const bucket = byChannel.get(channel) ?? [];
    bucket.push(item);
    byChannel.set(channel, bucket);
  };

  for (const event of events) {
    if (event.type === 'reasoning_delta' && event.part === 'summary') push('reasoning', event.delta);
    else if (event.type === 'content_delta') push('content', event.delta);
    else if (event.type === 'tool_call') push('tool_call', `${event.name}(${event.arguments})`);
    else if (event.type === 'tool_result') push('tool_result', `${event.ok ? 'ok' : 'error'}: ${event.output}`);
  }

  banner('Events grouped by channel (this is the separation the loop guarantees)');
  for (const [channel, items] of byChannel) {
    process.stdout.write(`\n${channel} (${items.length} events)\n`);
    for (const item of items) {
      process.stdout.write(`  • ${item.replace(/\s+/g, ' ').slice(0, 100)}\n`);
    }
  }
}

async function main(): Promise<void> {
  const live = process.argv.includes('--live');
  const apiKey = process.env.OPENAI_API_KEY;
  const useLive = live || (apiKey !== undefined && apiKey.length > 0 && !process.argv.includes('--mock'));

  let baseURL: string | undefined;
  let close: (() => Promise<void>) | undefined;

  if (!useLive) {
    // A scripted two-step turn: reason + call the calculator, then answer.
    const server = await startMockResponsesServer((_request, index) => {
      const turns = [
        {
          reasoning: [
            'The user wants two things: an arithmetic result and the current time. ',
            'I should call the calculator first, then the clock.',
          ],
          content: ['Let me compute that.'],
          toolCalls: [
            { name: 'calculator', args: { expression: '(17 * 3 + 4) / 5' }, argChunkSize: 8 },
          ],
          usage: { input_tokens: 40, output_tokens: 25 },
        },
        {
          reasoning: ['The calculator returned 11. Now I need the current time in UTC.'],
          content: ['The result is 11. '],
          toolCalls: [{ name: 'current_time', args: { timezone: 'UTC' }, argChunkSize: 12 }],
          usage: { input_tokens: 80, output_tokens: 30 },
        },
        {
          reasoning: ['I have both answers. Time to respond.'],
          content: [
            'The result of (17 * 3 + 4) / 5 is 11.\n',
            'The current time in UTC is available in the tool output above.',
          ],
          usage: { input_tokens: 120, output_tokens: 20 },
        },
      ];
      const turn = turns[Math.min(index, turns.length - 1)];
      if (turn === undefined) throw new Error(`unexpected request #${index}`);
      return { events: buildTurn(turn), chunkSize: 64, chunkDelayMs: 2 };
    });

    baseURL = server.url;
    close = () => server.close();
    banner('No OPENAI_API_KEY set — driving the agent against a local mock Responses API');
    process.stdout.write(`mock server: ${server.url}\n`);
  } else {
    banner('Running against the live OpenAI Responses API');
  }

  const agentOptions: ReActAgentOptions = {
    client: new ResponsesClient(baseURL === undefined ? {} : { apiKey: apiKey ?? '', baseURL }),
    model: process.env.OPENAI_MODEL ?? 'gpt-5',
    instructions: 'You are a precise assistant. Use the calculator for arithmetic.',
    tools: builtinTools(),
    maxSteps: 6,
    reasoning: { effort: 'low', summary: 'auto' },
  };
  const agent = new ReActAgent(agentOptions);

  const renderer = new ConsoleRenderer({ color: process.stdout.isTTY === true });
  const events: AgentEvent[] = [];

  banner(`Question: ${QUESTION}`);
  process.stdout.write('\n--- live stream (channel-labelled) ---\n');

  try {
    const result = await agent.runWithCallbacks(QUESTION, {
      onEvent: (event) => {
        events.push(event);
        renderer.render(event);
      },
    });
    renderer.flush();

    summariseChannels(events);

    banner('Aggregated result');
    process.stdout.write(
      [
        `stop reason   : ${result.stopReason}`,
        `steps         : ${result.steps.length}`,
        `answer        : ${JSON.stringify(result.text)}`,
        `reasoning     : ${JSON.stringify(result.reasoningText.slice(0, 120))}`,
        `tool calls    : ${result.toolCalls.map((call) => call.name).join(', ') || '(none)'}`,
        `tool results  : ${result.toolResults.map((entry) => `${entry.name}=${entry.ok ? 'ok' : 'error'}`).join(', ') || '(none)'}`,
        `tokens        : in=${result.usage.input_tokens} out=${result.usage.output_tokens} total=${result.usage.total_tokens}`,
        `transcript    : ${result.messages.length} input items`,
        `duration      : ${result.durationMs}ms`,
      ].join('\n') + '\n',
    );
  } finally {
    if (close !== undefined) await close();
  }
}

await main();
