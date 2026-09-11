/**
 * Command-line argument parsing for the ZeroAgent CLI.
 *
 * This module deliberately has **no dependency** on `@zero-agent/agent-loop`: it
 * produces plain option values, and `cli.ts` maps them onto the agent's own
 * types. That keeps the parser unit-testable without building the workspace
 * first.
 */

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';
export type ReasoningSummary = 'auto' | 'concise' | 'detailed';

export type CliMode = 'help' | 'one-shot' | 'interactive';

export interface CliOptions {
  mode: CliMode;
  model: string;
  /** API base URL, or undefined to fall back to the SDK default/env. */
  baseURL: string | undefined;
  /** The single prompt, in one-shot mode. */
  prompt: string | undefined;
  instructions: string | undefined;
  maxSteps: number;
  effort: ReasoningEffort;
  summary: ReasoningSummary;
  /** False when `--no-reasoning` was passed: neither request nor display reasoning. */
  useReasoning: boolean;
  useTools: boolean;
  verbose: boolean;
  color: boolean;
}

/** Ambient state the parser reads, injected so it can be tested. */
export interface ParseContext {
  env: Record<string, string | undefined>;
  isTTY: boolean;
}

/** Thrown for anything the user can fix by changing their arguments. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export const DEFAULT_MAX_STEPS = 10;
export const DEFAULT_MODEL = 'gpt-5';

const EFFORT_LEVELS: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];
const SUMMARY_MODES: readonly ReasoningSummary[] = ['auto', 'concise', 'detailed'];

export const HELP = `zero-agent — a ReAct agent loop on the OpenAI Responses API

Usage:
  zero-agent [options]                interactive session
  zero-agent [options] -p "prompt"    one-shot run

  From the repo root (pnpm forwards arguments directly, so do NOT add "--"):
  pnpm cli [options]                  builds, then runs the CLI

Options:
  -p, --prompt <text>      Run a single prompt and exit.
  -m, --model <id>         Model id (default: $OPENAI_MODEL or "${DEFAULT_MODEL}").
      --base-url <url>     API base URL (default: $OPENAI_BASE_URL).
      --instructions <s>   System instructions.
      --max-steps <n>      Maximum ReAct iterations (default: ${DEFAULT_MAX_STEPS}).
      --effort <level>     Reasoning effort: ${EFFORT_LEVELS.join('|')}.
      --summary <mode>     Reasoning summary: ${SUMMARY_MODES.join('|')}.
      --no-reasoning       Do not request or display reasoning.
      --no-tools           Run without tools.
      --no-color           Disable ANSI colours.
  -v, --verbose            Show lifecycle events.
  -h, --help               Show this help.

Environment:
  OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL

Session commands:
  /reset                   Clear the conversation history.
  /exit                    Quit.
`;

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined) throw new CliUsageError(`${flag} requires a value`);
  return value;
}

function parseMaxSteps(flag: string, raw: string): number {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed) || Number.parseInt(trimmed, 10) < 1) {
    throw new CliUsageError(`${flag} expects a positive integer, received "${raw}"`);
  }
  return Number.parseInt(trimmed, 10);
}

/**
 * Parse `argv` (without the leading `node`/script entries).
 *
 * @throws {CliUsageError} for unknown flags, missing values or invalid values.
 */
export function parseArgs(argv: readonly string[], context: ParseContext): CliOptions {
  const options: CliOptions = {
    mode: 'interactive',
    model: context.env.OPENAI_MODEL ?? DEFAULT_MODEL,
    baseURL: context.env.OPENAI_BASE_URL,
    prompt: undefined,
    instructions: undefined,
    maxSteps: DEFAULT_MAX_STEPS,
    effort: 'low',
    summary: 'auto',
    useReasoning: true,
    useTools: true,
    verbose: false,
    color: context.isTTY,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) break;

    switch (arg) {
      case '-h':
      case '--help':
        options.mode = 'help';
        return options;

      case '-p':
      case '--prompt':
        index += 1;
        options.prompt = requireValue(arg, argv[index]);
        break;

      case '-m':
      case '--model':
        index += 1;
        options.model = requireValue(arg, argv[index]);
        break;

      case '--base-url':
        index += 1;
        options.baseURL = requireValue(arg, argv[index]);
        break;

      case '--instructions':
        index += 1;
        options.instructions = requireValue(arg, argv[index]);
        break;

      case '--max-steps':
        index += 1;
        options.maxSteps = parseMaxSteps(arg, requireValue(arg, argv[index]));
        break;

      case '--effort': {
        index += 1;
        const raw = requireValue(arg, argv[index]);
        if (!EFFORT_LEVELS.includes(raw as ReasoningEffort)) {
          throw new CliUsageError(`${arg} expects ${EFFORT_LEVELS.join('|')}, received "${raw}"`);
        }
        options.effort = raw as ReasoningEffort;
        break;
      }

      case '--summary': {
        index += 1;
        const raw = requireValue(arg, argv[index]);
        if (!SUMMARY_MODES.includes(raw as ReasoningSummary)) {
          throw new CliUsageError(`${arg} expects ${SUMMARY_MODES.join('|')}, received "${raw}"`);
        }
        options.summary = raw as ReasoningSummary;
        break;
      }

      case '--no-reasoning':
        options.useReasoning = false;
        break;

      case '--no-tools':
        options.useTools = false;
        break;

      case '--no-color':
        options.color = false;
        break;

      case '-v':
      case '--verbose':
        options.verbose = true;
        break;

      default:
        throw new CliUsageError(`Unknown option "${arg}". Try --help.`);
    }
  }

  if (options.prompt !== undefined) options.mode = 'one-shot';
  return options;
}
