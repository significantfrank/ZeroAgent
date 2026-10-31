import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { Agent } from './agent/agent-loop.ts';
import { createAiClient } from './ai/index.ts';
import { render } from './agent/agent-console.ts';
import { AgentBridge } from './agent/agent-bridge.ts';
import { ExtensionRunner, loadExtensions } from './extension/index.ts';
import { mcpManager, registerBuiltInToolHandlers } from './tool/index.ts';
import type { ReasoningConfig } from './agent/types.ts';
import { loadSkills } from './skill/index.ts';
import { CommandRegistry, loadCommands, tryRunCommand } from './command/index.ts';
import { SessionManager } from './session/manager.ts';
import { AgentRegistry, buildSubagentParentPrompt, isSubAgentInput, loadAgents, parseSubAgent, runSubAgent } from './subagent/index.ts';
import { EFFORT_LEVELS, SettingsStore, authFilePath, formatModels, loadModelRegistry, modelsConfigPath, restoreSessionModel, switchModel, type EffortLevel, type ModelRegistry } from './model/index.ts';

const REASONING: ReasoningConfig = { summary: 'auto' };

function isEffortLevel(value: string): value is EffortLevel {
    return (EFFORT_LEVELS as readonly string[]).includes(value);
}

function loadEnv(): void {
    const loader = (process as typeof process & { loadEnvFile?: (path?: string) => void }).loadEnvFile;
    try {
        loader?.('.env');
    } catch {
        // Environment variables may already be supplied by the shell.
    }
}

async function runOnce(agent: Agent, prompt: string): Promise<void> {
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());

    const sessionManager = agent.sessionManager;
    const sessionId = agent.sessionId;
    const bridge = sessionManager !== undefined && sessionId !== undefined
        ? new AgentBridge(sessionManager, sessionId, prompt, agent.extensions)
        : undefined;

    for await (const event of agent.stream(prompt, {
        signal: controller.signal,
        reasoning: REASONING,
    })) {
        await bridge?.handleAgentEvent(event);
        render(event);
    }
    process.stdout.write('\n');
}

async function runPrompt(agent: Agent, registry: AgentRegistry, prompt: string): Promise<void> {
    if (!isSubAgentInput(prompt)) {
        await runOnce(agent, prompt);
        return;
    }

    let invocation;
    try {
        invocation = parseSubAgent(prompt, registry);
    } catch (error) {
        console.error(`[subagent] ${error instanceof Error ? error.message : String(error)}`);
        return;
    }

    console.log('\n[delegating to subagent]');
    let result: string;
    try {
        result = await runSubAgent(agent, invocation.task, invocation.definition);
    } catch {
        return;
    }
    const parentPrompt = buildSubagentParentPrompt(invocation.definition.name, invocation.task, result);
    await runOnce(agent, parentPrompt);
}

// ---------------------------------------------------------------------------
// Session command handlers
// ---------------------------------------------------------------------------

function handleSessionsCommand(manager: SessionManager, workspace: string): void {
    const sessions = manager.listSessions(workspace);
    if (sessions.length === 0) {
        console.log('No sessions found.');
        return;
    }
    console.log('\nSessions (newest first):');
    for (const s of sessions) {
        const title = s.title || '(untitled)';
        console.log(`  ${s.id}  ${title}  [${s.messageCount} msgs]  ${s.updatedAt}`);
    }
    console.log();
}

function handleResumeCommand(agent: Agent, manager: SessionManager, id: string): boolean {
    const session = manager.getSession(id);
    if (session === undefined) {
        console.log(`Session not found: ${id}`);
        return false;
    }
    agent.setSessionId(id);
    restoreSessionModel(agent, session.model);
    const title = session.title || '(untitled)';
    const modelLabel = session.model !== '' ? ` [${session.model}]` : '';
    console.log(`Resumed session ${id} — ${title} [${session.messageCount} messages]${modelLabel}\n`);
    return true;
}

function handleClearCommand(agent: Agent, manager: SessionManager, workspace: string): void {
    const session = manager.createSession(workspace, agent.model);
    agent.setSessionId(session.id);
    console.log(`New session: ${session.id}\n`);
}

function handleModelsCommand(agent: Agent, registry: ModelRegistry): void {
    console.log('\nModels:');
    for (const line of formatModels(registry, agent.model)) {
        console.log(`  ${line}`);
    }
    console.log();
}

async function handleModelCommand(agent: Agent, registry: ModelRegistry, manager: SessionManager, settings: SettingsStore, id: string): Promise<void> {
    if (switchModel(agent, registry, manager, id)) {
        await settings.setCurrentModel(id);
        console.log(`Active model: ${id}\n`);
    } else {
        console.log(`Unknown model: ${id}`);
    }
}

async function handleThinkingCommand(agent: Agent, settings: SettingsStore, level: string): Promise<void> {
    if (!isEffortLevel(level)) {
        console.log(`Unknown thinking level: ${level} (expected: ${EFFORT_LEVELS.join(', ')})\n`);
        return;
    }
    agent.setThinkingLevel(level);
    await settings.setCurrentThinkingLevel(level);
    console.log(`Thinking level: ${level}\n`);
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleReloadCommand(
    agent: Agent,
    registry: CommandRegistry,
    subagentRegistry: AgentRegistry,
    modelRegistry: ModelRegistry,
    workdir: string,
): Promise<void> {
    const loadedCommands = await loadCommands(workdir, registry);
    const loadedSkills = await loadSkills(workdir, agent.skills);
    await loadAgents(workdir, subagentRegistry);
    const loadedExtensions = agent.extensions !== undefined ? await loadExtensions(workdir, agent.extensions) : [];
    modelRegistry.clear();
    await loadModelRegistry(authFilePath(), modelsConfigPath(), modelRegistry);
    console.log(`[reload] ${loadedCommands.length} command(s), ${loadedSkills.length} skill(s), ${subagentRegistry.names().length} subagent(s), ${loadedExtensions.length} extension(s), ${modelRegistry.names().length} model(s)\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    loadEnv();

    await mcpManager.connectStdio(
        'demo',
        process.execPath,
        [fileURLToPath(new URL('./mcp/server.ts', import.meta.url))],
    );

    const workdir = process.env.ZEROAGENT_WORKDIR ?? process.cwd();
    console.log(`[workdir] ${workdir}`);
    const args = process.argv.slice(2);

    // Settings — current model + thinking level from ~/.zeroagent/settings.json
    const settingsStore = new SettingsStore();
    const settings = await settingsStore.load();

    // Session manager — shared across the REPL lifecycle
    const sessionManager = new SessionManager();

    // Model registry — auth + model config from ~/.zeroagent/
    const modelRegistry = await loadModelRegistry(authFilePath(), modelsConfigPath());
    const configuredModel = settings.currentModel !== undefined && modelRegistry.get(settings.currentModel) !== undefined
        ? settings.currentModel
        : modelRegistry.names()[0];
    if (configuredModel === undefined) {
        console.error('[models] No models configured. Add providers to ~/.zeroagent/auth.json and models to ~/.zeroagent/models-config.json.');
        await mcpManager.closeAll();
        sessionManager.close();
        return;
    }
    if (settings.currentModel !== configuredModel) {
        await settingsStore.setCurrentModel(configuredModel);
    }
    if (modelRegistry.names().length > 0) {
        console.log(`[models] Loaded ${modelRegistry.names().length} model(s): ${modelRegistry.names().join(', ')}`);
    }
    console.log(`[model] Using model: ${configuredModel} , thinking level: ${settings.currentThinkingLevel}`);

    const activeProvider = modelRegistry.get(configuredModel)?.provider;
    if (activeProvider === undefined) {
        console.error(`[model] No provider configured for model "${configuredModel}".`);
        await mcpManager.closeAll();
        sessionManager.close();
        return;
    }
    // Extension runner — lifecycle hooks and command/tool registrations.
    const extensions = new ExtensionRunner();

    const agent = new Agent(createAiClient(activeProvider, {
        resolveProvider: (modelId) => modelRegistry.resolveAuth(modelId),
    }), {
        workdir: workdir,
        sessionManager,
        modelRegistry,
        model: configuredModel,
        thinkingLevel: settings.currentThinkingLevel,
        extensions,
    });

    // Load skills before the first interaction
    const loadedSkills = await loadSkills(workdir, agent.skills);
    if (loadedSkills.length > 0) {
        console.log(`[skills] Loaded ${loadedSkills.length} skill(s): ${loadedSkills.map((s) => s.skill.name).join(', ')}\n`);
    }

    // Register tools
    registerBuiltInToolHandlers(agent);

    const subagentRegistry = new AgentRegistry();
    const loadedAgents = await loadAgents(workdir, subagentRegistry);
    if (loadedAgents.length > 0) {
        console.log(`[subagents] Loaded ${subagentRegistry.names().join(', ')}\n`);
    }

    // Load extensions before the first interaction
    const loadedExtensions = await loadExtensions(workdir, extensions);
    if (loadedExtensions.length > 0) {
        console.log(`[extensions] Loaded ${loadedExtensions.map((e) => e.path).join(', ')}\n`);
    }

    // One-shot mode: no session, stateless
    if (args.length > 0) {
        await runPrompt(agent, subagentRegistry, args.join(' '));
        await mcpManager.closeAll();
        sessionManager.close();
        return;
    }

    // Interactive REPL: load user commands from disk
    const commandRegistry = new CommandRegistry();
    const loadedCommands = await loadCommands(workdir, commandRegistry);
    if (loadedCommands.length > 0) {
        console.log(`[commands] Loaded ${loadedCommands.length} command(s): ${loadedCommands.map((c) => c.command.name).join(', ')}\n`);
    }

    // create new session for the interactive REPL
    let activeSession = sessionManager.createSession(workdir, agent.model);
    console.log(`[session] New session: ${activeSession.id}`);
    agent.setSessionId(activeSession.id);
    console.log('Interactive mode — type your prompt and press Enter. Ctrl+C to exit.\n');

    const rl = createInterface({ input: stdin, output: stdout });

    while (true) {
        let prompt: string;
        try {
            prompt = await rl.question('❯ ');
        } catch {
            break; // stdin closed
        }

        prompt = prompt.trim();
        if (prompt.length === 0) continue;

        // Session commands
        if (prompt === '/sessions') {
            handleSessionsCommand(sessionManager, workdir);
            continue;
        }
        if (prompt === '/models') {
            handleModelsCommand(agent, modelRegistry);
            continue;
        }
        if (prompt.startsWith('/model ')) {
            const modelId = prompt.slice('/model '.length).trim();
            await handleModelCommand(agent, modelRegistry, sessionManager, settingsStore, modelId);
            continue;
        }
        if (prompt === '/thinking') {
            console.log(`Thinking level: ${agent.thinkingLevel}\n`);
            continue;
        }
        if (prompt.startsWith('/thinking ')) {
            const level = prompt.slice('/thinking '.length).trim();
            await handleThinkingCommand(agent, settingsStore, level);
            continue;
        }
        if (prompt.startsWith('/resume ')) {
            const id = prompt.slice('/resume '.length).trim();
            handleResumeCommand(agent, sessionManager, id);
            continue;
        }
        if (prompt === '/clear') {
            handleClearCommand(agent, sessionManager, workdir);
            continue;
        }
        if (prompt === '/reload') {
            await handleReloadCommand(agent, commandRegistry, subagentRegistry, modelRegistry, workdir);
            continue;
        }
        // User-defined slash commands (extension commands first, then templates)
        if (prompt.startsWith('/')) {
            const tokens = prompt.split(/\s+/);
            const extCommand = extensions.getCommand(tokens[0]!.slice(1));
            if (extCommand !== undefined) {
                await extCommand.handler(tokens.slice(1).join(' '), { input: prompt });
                console.log();
                continue;
            }
            await tryRunCommand(commandRegistry, prompt, (expanded) => runOnce(agent, expanded));
            continue;
        }

        await runPrompt(agent, subagentRegistry, prompt);
        console.log(); // blank line between turns
    }

    rl.close();
    await mcpManager.closeAll();
    sessionManager.close();
}

void main();
