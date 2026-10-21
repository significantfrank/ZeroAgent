import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { Agent } from './agent-loop.ts';
import { ResponsesClient } from './client.ts';
import { render } from './agent-event.ts';
import { mcpManager, registerBuiltInToolHandlers } from './tool/index.ts';
import { AgentEventType, type ReasoningConfig } from './types.ts';
import { loadSkills } from './skill/index.ts';
import { CommandRegistry, loadCommands, tryRunCommand } from './command/index.ts';
import { SessionManager } from './session/manager.ts';
import { AgentRegistry, buildSubagentParentPrompt, isSubAgentInput, loadAgents, parseSubAgent, runSubAgent } from './subagent/index.ts';

const REASONING: ReasoningConfig = { effort: 'high', summary: 'auto' };

function loadEnv(): void {
    const loader = (process as typeof process & { loadEnvFile?: (path?: string) => void }).loadEnvFile;
    try {
        loader?.('.env');
    } catch {
        // Environment variables may already be supplied by the shell.
    }
}

async function runOnce(agent: Agent, prompt: string, skipInitialStepStart = false): Promise<void> {
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());

    for await (const event of agent.stream(prompt, {
        signal: controller.signal,
        reasoning: REASONING,
    })) {
        if (skipInitialStepStart && event.type === AgentEventType.StepStart && event.step === 1) {
            skipInitialStepStart = false;
            continue;
        }
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

    console.log('\n[step 1]');
    let result: string;
    try {
        result = await runSubAgent(agent, invocation.task, invocation.definition);
    } catch {
        return;
    }
    const parentPrompt = buildSubagentParentPrompt(invocation.definition.name, invocation.task, result);
    await runOnce(agent, parentPrompt, true);
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
    const title = session.title || '(untitled)';
    console.log(`Resumed session ${id} — ${title} [${session.messageCount} messages]\n`);
    return true;
}

function handleClearCommand(agent: Agent, manager: SessionManager, workspace: string): void {
    const session = manager.createSession(workspace, process.env.OPENAI_MODEL);
    agent.setSessionId(session.id);
    console.log(`New session: ${session.id}\n`);
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleReloadCommand(
    agent: Agent,
    registry: CommandRegistry,
    subagentRegistry: AgentRegistry,
    workdir: string,
): Promise<void> {
    const loadedCommands = await loadCommands(workdir, registry);
    const loadedSkills = await loadSkills(workdir, agent.skills);
    await loadAgents(workdir, subagentRegistry);
    console.log(`[reload] ${loadedCommands.length} command(s), ${loadedSkills.length} skill(s), ${subagentRegistry.names().length} subagent(s)\n`);
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
    const model = process.env.OPENAI_MODEL;

    // Session manager — shared across the REPL lifecycle
    const sessionManager = new SessionManager();

    const agent = new Agent(new ResponsesClient(), {
        workdir: workdir,
        sessionManager,
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
    let activeSession = sessionManager.createSession(workdir, model);
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
            await handleReloadCommand(agent, commandRegistry, subagentRegistry, workdir);
            continue;
        }
        // User-defined slash commands
        if (prompt.startsWith('/')) {
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
