import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { Agent } from './agent-loop.ts';
import { ResponsesClient } from './client.ts';
import { mcpManager } from './tools.ts';
import { AgentEventType, type AgentEvent, type ReasoningConfig } from './types.ts';
import { loadSkills } from './skills/index.ts';
import { CommandRegistry, loadCommands, tryRunCommand } from './command/index.ts';
import { SessionManager } from './session/manager.ts';

const REASONING: ReasoningConfig = { effort: 'high', summary: 'auto' };

function loadEnv(): void {
    const loader = (process as typeof process & { loadEnvFile?: (path?: string) => void }).loadEnvFile;
    try {
        loader?.('.env');
    } catch {
        // Environment variables may already be supplied by the shell.
    }
}

function render(event: AgentEvent): void {
    switch (event.type) {
        case AgentEventType.StepStart:
            console.log(`\n[step ${event.step}]`);
            break;
        case AgentEventType.ReasoningDelta:
            process.stdout.write(`\x1b[90m${event.delta}\x1b[0m`);
            break;
        case AgentEventType.ContentDelta:
            process.stdout.write(`\x1b[34m${event.delta}\x1b[0m`);
            break;
        case AgentEventType.TokenUsage: {
            console.log(`\n[token_usage] input ${event.inputTokens}, output ${event.outputTokens}, total ${event.totalTokens}`);
            break;
        }
        case AgentEventType.ToolCall:
            console.log(`\n[tool_call] ${event.call.name}(${event.call.arguments})`);
            break;
        case AgentEventType.ToolResult:
            console.log(`\n[tool_result] ${event.output}`);
            break;
        case AgentEventType.StepEnd:
            console.log(`\n[step ${event.step} done: ${event.toolCalls} tool call(s)]`);
            break;
        case AgentEventType.RunEnd:
            console.log(`\n\n[run_end after ${event.steps} step(s)]`);
            break;
        case AgentEventType.Error:
            console.error(`\n[error] ${event.message}`);
            break;
    }
}

async function runOnce(agent: Agent, prompt: string): Promise<void> {
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());

    for await (const event of agent.stream(prompt, {
        signal: controller.signal,
        reasoning: REASONING,
    })) {
        render(event);
    }
    process.stdout.write('\n');
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

async function handleReloadCommand(agent: Agent, registry: CommandRegistry, workdir: string): Promise<void> {
    const loadedCommands = await loadCommands(workdir, registry);
    const loadedSkills = await loadSkills(workdir, agent.skills);
    console.log(`[reload] ${loadedCommands.length} command(s), ${loadedSkills.length} skill(s)\n`);
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

    // One-shot mode: no session, stateless
    if (args.length > 0) {
        await runOnce(agent, args.join(' '));
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

    // Interactive REPL: auto-load workspace's latest session or create new
    let activeSession = sessionManager.getLatestSessionByWorkspace(workdir);
    if (activeSession === undefined) {
        activeSession = sessionManager.createSession(workdir, model);
        console.log(`[session] New session: ${activeSession.id}`);
    } else {
        const msgCount = sessionManager.getMessages(activeSession.id).length;
        const title = activeSession.title || '(untitled)';
        console.log(`[session] Resumed: ${activeSession.id} — ${title} [${msgCount} messages]`);
    }
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
            await handleReloadCommand(agent, commandRegistry, workdir);
            continue;
        }
        // User-defined slash commands
        if (prompt.startsWith('/')) {
            await tryRunCommand(commandRegistry, prompt, (expanded) => runOnce(agent, expanded));
            continue;
        }

        await runOnce(agent, prompt);
        console.log(); // blank line between turns
    }

    rl.close();
    await mcpManager.closeAll();
    sessionManager.close();
}

void main();
