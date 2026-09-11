/**
 * ZeroAgent — a ReAct agent loop on the OpenAI Responses API.
 *
 * Streaming output is separated into distinct channels (reasoning / content /
 * tool calls) via the {@link AgentEvent} discriminated union, so consumers can
 * route each kind of output wherever it belongs.
 *
 * ```ts
 * import { ReActAgent, ResponsesClient, builtinTools, channelOf } from 'zero-agent';
 *
 * const agent = new ReActAgent({
 *   client: new ResponsesClient(),
 *   model: 'gpt-5',
 *   instructions: 'You are a careful assistant. Use tools when they help.',
 *   tools: builtinTools(),
 *   reasoning: { effort: 'low', summary: 'auto' },
 * });
 *
 * for await (const event of agent.stream('What is (17*3+4)/5?')) {
 *   if (channelOf(event) === 'reasoning') process.stderr.write(event.delta);  // thinking
 *   if (event.type === 'content_delta')    process.stdout.write(event.delta); // answer
 *   if (event.type === 'tool_call')        console.log('→', event.name, event.arguments);
 *   if (event.type === 'tool_result')      console.log('←', event.output);
 * }
 * ```
 */

/* -------------------------------------------------------------------------- */
/* Agent                                                                      */
/* -------------------------------------------------------------------------- */

export {
  ReActAgent,
  createAgent,
  normalizeInput,
  userMessage,
  assistantMessage,
} from './agent/loop.ts';
export type { AgentInput, AgentHandlers, ReActAgentOptions, RunOptions } from './agent/loop.ts';

export {
  channelOf,
  displayText,
  isContentEvent,
  isReasoningEvent,
  isToolCallEvent,
  addUsage,
  emptyUsage,
} from './agent/events.ts';
export type {
  AgentChannel,
  AgentDeltaEvent,
  AgentErrorEvent,
  AgentEvent,
  AgentEventType,
  AgentReasoningBlock,
  AgentResult,
  AgentStep,
  AgentToolCall,
  AgentToolResult,
  ContentDeltaEvent,
  ContentDoneEvent,
  ReasoningDeltaEvent,
  ReasoningDoneEvent,
  ReasoningPartKind,
  RefusalDeltaEvent,
  RefusalDoneEvent,
  RunEndEvent,
  RunStartEvent,
  ResponseStartEvent,
  StepEndEvent,
  StepStartEvent,
  StopReason,
  ToolCallDeltaEvent,
  ToolCallEvent,
  ToolResultEvent,
} from './agent/events.ts';

export { TurnAccumulator, parseToolArguments } from './agent/accumulator.ts';
export type { TurnSnapshot } from './agent/accumulator.ts';

export { ConsoleRenderer } from './agent/display.ts';
export type { ConsoleRendererOptions } from './agent/display.ts';

/* -------------------------------------------------------------------------- */
/* OpenAI transport                                                           */
/* -------------------------------------------------------------------------- */

export { ResponsesClient, OpenAIError } from './openai/responses.ts';
export type { FetchLike, RequestOptions, ResponsesClientOptions } from './openai/responses.ts';

export { SSEParser, parseSSEStream } from './openai/sse.ts';
export type { SSEMessage } from './openai/sse.ts';

export { asResponseStreamEvent, KNOWN_RESPONSE_EVENT_TYPES } from './openai/types.ts';
export type * from './openai/types.ts';

/* -------------------------------------------------------------------------- */
/* Tools                                                                      */
/* -------------------------------------------------------------------------- */

export { ToolRegistry } from './tools/registry.ts';
export type {
  ToolExecuteOptions,
  ToolInvocation,
  ToolRegistryOptions,
} from './tools/registry.ts';

export { defineTool, validateAgainstSchema } from './tools/types.ts';
export type {
  AnyToolDefinition,
  JSONSchema,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
  ValidationResult,
} from './tools/types.ts';

export {
  builtinTools,
  calculatorTool,
  createMemoryTool,
  currentTimeTool,
} from './tools/builtin.ts';
export { CalculatorError, evaluateExpression } from './tools/calculator.ts';

export { errorMessage, toError } from './util/errors.ts';
