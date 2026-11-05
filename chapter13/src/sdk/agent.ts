import { Agent as AgentRuntime } from '../agent/agent-loop.ts';
import type { AgentEvent, AgentOptions } from '../agent/types.ts';
import type { ToolHandlerContext } from '../tool/types.ts';
import type { LanguageModel } from './model.ts';
import { FunctionTool } from './function-tool.ts';
import type { FunctionToolLike } from './function-tool.ts';
import type { ExtensionRunner } from '../extension/runner.ts';
import type { ModelRegistry } from '../model/registry.ts';
import type { SessionManager } from '../session/manager.ts';
import { logger } from '../logger.ts';

export type AgentRunOptions = Pick<AgentOptions, 'maxSteps' | 'signal'>;

export type AgentResult = {
    name: string;
    output: string;
    children?: AgentResult[];
};

export interface RunnableAgent {
    readonly name: string;
    run(input: string, options?: AgentRunOptions): Promise<AgentResult>;
}

export type LlmAgentOptions = {
    name: string;
    model: LanguageModel;
    description?: string;
    instruction?: string;
    tools?: FunctionToolLike[];
    maxSteps?: number;
    workdir?: string;
    sessionManager?: SessionManager;
    sessionId?: string;
    modelRegistry?: ModelRegistry;
    extensions?: ExtensionRunner;
};

export class LlmAgent implements RunnableAgent {
    readonly name: string;
    readonly description: string;
    readonly model: LanguageModel;
    readonly #runtime: AgentRuntime;

    constructor(options: LlmAgentOptions) {
        this.name = options.name;
        this.description = options.description ?? '';
        this.model = options.model;
        this.#runtime = new AgentRuntime(options.model.createClient(), {
            model: options.model.model,
            instruction: options.instruction,
            maxSteps: options.maxSteps,
            workdir: options.workdir,
            sessionManager: options.sessionManager,
            sessionId: options.sessionId,
            modelRegistry: options.modelRegistry,
            extensions: options.extensions,
        });
        const toolNames = new Set<string>();
        for (const tool of options.tools ?? []) {
            if (toolNames.has(tool.name)) {
                throw new Error(`Agent "${this.name}" has duplicate tool "${tool.name}".`);
            }
            toolNames.add(tool.name);
            this.#runtime.tools.register(
                tool.definition,
                (_call, args: Record<string, unknown>, context?: ToolHandlerContext) =>
                    tool.execute(args, context),
            );
        }
    }

    get tools() {
        return this.#runtime.tools;
    }

    get skills() {
        return this.#runtime.skills;
    }

    stream(input: string, options: AgentRunOptions = {}): AsyncGenerator<AgentEvent> {
        return this.#runtime.stream(input, options);
    }

    async run(input: string, options: AgentRunOptions = {}): Promise<AgentResult> {
        const startedAt = performance.now();
        logger.debug('log/agent.log', `${new Date().toISOString()}：[${this.name}] Running agent with input: ${input}`);

        let output: string | undefined;
        for await (const event of this.stream(input, options)) {
            if (event.type === 'error') {
                throw new Error(event.reason);
            }
            if (event.type === 'turn_end' &&
                event.message.role === 'assistant' &&
                event.message.toolCalls === undefined) {
                output = event.message.content;
            }
        }
        options.signal?.throwIfAborted();
        if (output === undefined) {
            throw new Error(`Agent "${this.name}" ended without a final response.`);
        }
        const durationMs = Math.round(performance.now() - startedAt);
        logger.debug('log/agent.log', `${new Date().toISOString()}：[${this.name}] Agent finished in ${durationMs}ms`);

        return { name: this.name, output };
    }
}

export type AgentToolOptions = {
    name?: string;
    description?: string;
};

export class AgentTool extends FunctionTool {
    constructor(agent: RunnableAgent, options: AgentToolOptions = {}) {
        super({
            name: options.name ?? agent.name,
            description: options.description ?? agent.name,
            parameters: {
                type: 'object',
                properties: {
                    task: { type: 'string', description: 'A self-contained task for the delegated agent.' },
                },
                required: ['task'],
            },
            execute: async ({ task }, context) => {
                if (typeof task !== 'string') {
                    throw new Error(`Agent tool "${options.name ?? agent.name}" requires a string task.`);
                }
                const result = await agent.run(task, { signal: context.signal });
                return result.output;
            },
        });
    }
}
