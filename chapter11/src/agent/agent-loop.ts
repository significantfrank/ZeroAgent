import type { AiClient, AiRequest, ToolCall } from '../ai/ai-client.ts';
import { createToolRegistryWithMcp, executeTool, ToolRegistry } from '../tool/index.ts';
import type { AgentEvent, AgentOptions, ToolResultMessage } from './types.ts';
import type { FunctionCallItem } from '../tool/types.ts';
import { logger } from '../logger.ts';
import { PromptRequestBuilder } from '../request-builder.ts';
import { EFFORT_LEVELS } from '../model/types.ts';
import type { EffortLevel, ModelDefinition, ThinkingLevelMap } from '../model/types.ts';
import type { ModelRegistry } from '../model/registry.ts';
import type { ExtensionRunner } from '../extension/runner.ts';
import type { InjectableMessage } from '../extension/types.ts';
import { composeSystemPrompt, createSystemPromptOptions } from './system-prompt.ts';

import { SkillRegistry } from '../skill/index.ts';
import type { SessionManager } from '../session/manager.ts';
import type { SubAgentDefinition } from '../subagent/types.ts';

function toolArguments(call: ToolCall): unknown {
    try {
        return JSON.parse(call.arguments) as unknown;
    } catch {
        return call.arguments;
    }
}

function functionCallItem(call: ToolCall): FunctionCallItem {
    return {
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: call.arguments,
    };
}

function translateEffort(map: ThinkingLevelMap, requested: EffortLevel): string {
    const direct = map[requested];
    if (typeof direct === 'string' && direct.length > 0) return direct;

    const available = EFFORT_LEVELS
        .map((level) => ({ level, value: map[level] }))
        .filter((entry): entry is { level: EffortLevel; value: string } =>
            typeof entry.value === 'string' && entry.value.length > 0);

    if (available.length === 0) return requested;

    const requestedIndex = EFFORT_LEVELS.indexOf(requested);
    const belowOrEqual = available.filter((entry) => EFFORT_LEVELS.indexOf(entry.level) <= requestedIndex);
    const chosen = belowOrEqual.length > 0 ? belowOrEqual[belowOrEqual.length - 1]! : available[0]!;
    return chosen.value;
}

export class Agent {
    readonly #client: AiClient;
    #model: string;
    #thinkingLevel: EffortLevel;
    readonly #maxTurns: number;
    readonly #workdir: string;
    readonly #agentType: 'agent' | 'subagent';
    readonly #tools = new ToolRegistry();
    readonly #skills = new SkillRegistry();
    readonly #sessionManager: SessionManager | undefined;
    readonly #modelRegistry: ModelRegistry | undefined;
    readonly #extensions: ExtensionRunner | undefined;
    #sessionId: string | undefined;
    readonly #subAgentDef: SubAgentDefinition | undefined;

    constructor(
        client: AiClient,
        options: AgentOptions = {},
        agentType: 'agent' | 'subagent' = 'agent',
        agentDefinition?: SubAgentDefinition,
    ) {
        this.#client = client;
        this.#model = options.model ?? options.modelRegistry?.names()[0] ?? '';
        this.#thinkingLevel = options.thinkingLevel ?? 'high';
        this.#maxTurns = options.maxSteps ?? 50;
        this.#workdir = options.workdir ?? process.cwd();
        this.#agentType = agentType;
        this.#sessionManager = options.sessionManager;
        this.#modelRegistry = options.modelRegistry;
        this.#extensions = options.extensions;
        this.#sessionId = options.sessionId;
        this.#subAgentDef = agentDefinition;
    }

    /** The active model id. */
    get model(): string {
        return this.#model;
    }

    /** Change the active model for subsequent `stream()` calls. */
    setModel(model: string): void {
        this.#model = model;
    }

    /** The active thinking level. */
    get thinkingLevel(): EffortLevel {
        return this.#thinkingLevel;
    }

    /** Change the active thinking level for subsequent `stream()` calls. */
    setThinkingLevel(level: EffortLevel): void {
        this.#thinkingLevel = level;
    }

    /** The agent's working directory. */
    get workdir(): string {
        return this.#workdir;
    }

    /** The agent's skill registry. */
    get skills(): SkillRegistry {
        return this.#skills;
    }

    get tools(): ToolRegistry {
        return this.#tools;
    }

    /** The active session manager, or `undefined` in stateless mode. */
    get sessionManager(): SessionManager | undefined {
        return this.#sessionManager;
    }

    /** The active session ID, or `undefined` in stateless mode. */
    get sessionId(): string | undefined {
        return this.#sessionId;
    }

    /** The extension runner driving lifecycle hooks, or `undefined`. */
    get extensions(): ExtensionRunner | undefined {
        return this.#extensions;
    }

    /** Update the active session ID. */
    setSessionId(id: string | undefined): void {
        this.#sessionId = id;
    }

    #resolveReasoning(
        definition: ModelDefinition | undefined,
        options: AgentOptions,
    ): NonNullable<AiRequest['reasoning']> {
        if (definition?.reasoning !== true) return { effort: this.#thinkingLevel };
        const effort: EffortLevel = options.reasoning?.effort ?? this.#thinkingLevel;
        const summary = options.reasoning?.summary;
        const translated = definition.thinkingLevelMap !== undefined
            ? translateEffort(definition.thinkingLevelMap, effort)
            : effort;
        return { effort: translated, ...(summary !== undefined ? { summary } : {}) };
    }

    async #prepareRequest(
        model: string,
        input: string,
        reasoning: NonNullable<AiRequest['reasoning']>,
        definition: ModelDefinition | undefined,
        sessionManager: SessionManager | undefined,
        sessionId: string | undefined,
    ): Promise<{ requestBuilder: PromptRequestBuilder; tools: ToolRegistry }> {
        const instructions = [this.#subAgentDef?.systemPrompt, this.#skills.buildPromptInstructions()]
            .filter((part) => part !== undefined && part.length > 0)
            .join('\n\n');

        // Let extensions inspect and mutate the run before the request is built.
        const systemPromptOptions = createSystemPromptOptions(instructions);
        let injectedMessages: InjectableMessage[] = [];
        if (this.#extensions !== undefined) {
            const before = await this.#extensions.emitBeforeAgentStart(input, systemPromptOptions);
            injectedMessages = before.messages ?? [];
        }
        const finalInstructions = composeSystemPrompt(systemPromptOptions);

        const developerMessage = `Working directory: ${this.#workdir}. Resolve relative paths from this directory.`;
        const requestBuilder = new PromptRequestBuilder(model)
            .addDeveloperMsg(developerMessage)
            .setInstructions(finalInstructions)
            .setParallelToolCalls(true)
            .setStore(false)
            .setReasoning(reasoning);
        if (definition?.maxTokens !== undefined) requestBuilder.setMaxOutputTokens(definition.maxTokens);

        for (const message of injectedMessages) {
            requestBuilder.addInputItem({ role: message.role, content: message.content });
        }

        if (sessionManager !== undefined && sessionId !== undefined) {
            for (const msg of sessionManager.getMessages(sessionId)) {
                requestBuilder.addInputItem({
                    role: msg.role as 'user' | 'assistant' | 'developer' | 'system',
                    content: msg.content,
                });
            }
        } else {
            requestBuilder.addUserMsg(input);
        }

        const tools = await createToolRegistryWithMcp(this.#tools, this.#subAgentDef);
        if (this.#extensions !== undefined) {
            for (const tool of this.#extensions.registeredTools()) {
                tools.register(tool.definition, tool.handler);
            }
        }
        for (const tool of tools.definitions()) {
            requestBuilder.addTool(tool);
        }

        return { requestBuilder, tools };
    }

    createSubAgent(definition: SubAgentDefinition): Agent {
        const childDefinition: SubAgentDefinition = {
            ...definition,
            tools: { ...definition.tools, load_skill: true },
        };
        if (this.#modelRegistry !== undefined && childDefinition.model !== undefined && this.#modelRegistry.get(childDefinition.model) === undefined) {
            throw new Error(`Unknown model "${childDefinition.model}" for subagent "${childDefinition.name}"`);
        }
        const child = new Agent(this.#client, {
            model: childDefinition.model ?? this.#model,
            maxSteps: this.#maxTurns,
            workdir: this.#workdir,
            modelRegistry: this.#modelRegistry,
        }, 'subagent', childDefinition);
        child.#skills.copyFrom(this.#skills);
        child.#tools.copyFrom(this.#tools, childDefinition);
        return child;
    }

    async *stream(input: string, options: AgentOptions = {}): AsyncGenerator<AgentEvent> {
        yield { type: 'agent_start' };

        const signal = options.signal;
        const maxTurns = options.maxSteps ?? this.#maxTurns;
        const model = options.model ?? this.#model;
        if (model.length === 0) {
            yield { type: 'error', reason: 'No model configured. Add a model to ~/.zeroagent/models-config.json.' };
            return;
        }

        if (this.#modelRegistry !== undefined && this.#modelRegistry.get(model) === undefined) {
            yield { type: 'error', reason: `Unknown model "${model}" in ~/.zeroagent/models-config.json.` };
            return;
        }

        const sessionId = options.sessionId ?? this.#sessionId;

        const definition = this.#modelRegistry?.get(model);
        const reasoning = this.#resolveReasoning(definition, options);
        logger.debug('log/agent.log', `[${this.#agentType}] Starting agent loop , model=${model} , reasoning=${JSON.stringify(reasoning)} ,with maxTurns=${maxTurns}`);

        const sessionManager = options.sessionManager ?? this.#sessionManager;
        let assistantText = '';

        try {
            const { requestBuilder, tools } = await this.#prepareRequest(
                model,
                input,
                reasoning,
                definition,
                sessionManager,
                sessionId,
            );

            for (let turn = 1; turn <= maxTurns; turn += 1) {
                yield { type: 'turn_start' };
                const calls = new Map<string, ToolCall>();
                const toolResults: ToolResultMessage[] = [];
                let turnAssistantText = '';
                let thinking: string | undefined;
                let streamCompleted = false;
                const request = { ...requestBuilder.build(), signal };
                logger.debug('log/request.log', JSON.stringify({ agent: this.#agentType, request }, null, 2));
                streamEvents: for await (const aiEvent of this.#client.stream(request)) {
                    logger.debug('log/ai-event-type.log', `[${this.#agentType}] ${aiEvent.type}`);
                    switch (aiEvent.type) {
                        case 'start':
                            yield { type: 'message_start' };
                            break;
                        case 'text_delta':
                            yield { type: 'message_update', aiEvent: aiEvent };
                            break;
                        case 'text_end':
                            turnAssistantText = aiEvent.content; // 保存本轮助手的文本内容
                            assistantText = turnAssistantText;// 保存整个对话的最新助手文本内容
                            break;
                        case 'thinking_delta':
                            yield { type: 'message_update', aiEvent: aiEvent };
                            break;
                        case 'thinking_end':
                            thinking = aiEvent.content;
                            break;
                        case 'toolcall_delta':
                            yield { type: 'message_update', aiEvent: aiEvent };
                            break;
                        case 'toolcall_end':
                            logger.debug('log/function-call.log', JSON.stringify({ agent: this.#agentType, call: aiEvent.toolCall }, null, 2));
                            calls.set(aiEvent.toolCall.id, aiEvent.toolCall);
                            yield { type: 'message_update', aiEvent: aiEvent };
                            break;
                        case 'error':
                            yield { type: 'error', reason: aiEvent.reason };
                            break streamEvents; // 退出整个 for-await 循环
                        // case 'text_start':
                        // case 'thinking_start':
                        // case 'toolcall_start':
                        case 'done':
                            streamCompleted = true;
                            yield {
                                type: 'message_end',
                                message: {
                                    role: 'assistant',
                                    content: turnAssistantText,
                                    ...(thinking !== undefined ? { thinking } : {}),
                                    ...(calls.size > 0 ? { toolCalls: [...calls.values()] } : {}),
                                },
                            };
                            break streamEvents;
                    }
                }

                if (!streamCompleted) {
                    break;
                }

                if (calls.size === 0) {
                    yield {
                        type: 'turn_end',
                        message: { role: 'assistant', content: turnAssistantText },
                        toolResults,
                    };
                    break;
                }

                if (turn >= maxTurns) {
                    yield {
                        type: 'turn_end',
                        message: { role: 'assistant', content: turnAssistantText, toolCalls: [...calls.values()] },
                        toolResults,
                    };
                    yield { type: 'error', reason: `Reached maxSteps (${maxTurns})` };
                    break;
                }

                for (const call of calls.values()) {
                    requestBuilder.addInputItem({ type: 'tool_call', toolCall: call });
                }
                for (const call of calls.values()) {
                    const args = toolArguments(call);
                    yield {
                        type: 'tool_execution_start',
                        toolCallId: call.id,
                        toolName: call.name,
                        args,
                    };
                    const startedAt = performance.now();
                    const result = await executeTool(functionCallItem(call), tools);
                    const durationMs = performance.now() - startedAt;
                    const resultMessage: ToolResultMessage = {
                        role: 'toolResult',
                        toolCallId: result.callId,
                        toolName: result.name,
                        content: result.output,
                        isError: result.error !== undefined,
                        durationMs,
                    };
                    toolResults.push(resultMessage);
                    requestBuilder.addInputItem({
                        type: 'tool_result',
                        toolCallId: result.callId,
                        content: result.output,
                    });
                    yield {
                        type: 'tool_execution_end',
                        toolCallId: result.callId,
                        toolName: result.name,
                        result: result.output,
                        isError: result.error !== undefined,
                        durationMs,
                    };
                }
                yield {
                    type: 'turn_end',
                    message: { role: 'assistant', content: turnAssistantText, toolCalls: [...calls.values()] },
                    toolResults,
                };
            }
        } catch (error) {
            if (signal?.aborted !== true) {
                yield { type: 'error', reason: error instanceof Error ? error.message : String(error) };
            }
        } finally {
            yield { type: 'agent_end', message: { role: 'assistant', content: assistantText } };
        }
    }
}
