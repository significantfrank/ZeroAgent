import { readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { FunctionCallItem, FunctionTool, ToolResult } from './types.ts';
import { McpClientManager } from '../mcp/mcp-client.ts';
import { parseToolArguments, ToolRegistry } from './registry.ts';
import type { Agent } from '../agent-loop.ts';
import type { SubAgentDefinition } from '../subagent/types.ts';
import { runSubAgent } from '../subagent/subagent.ts';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const weatherTool: FunctionTool = {
    type: 'function',
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: 'City name' } },
        required: ['city'],
        additionalProperties: false,
    },
    strict: true,
};

export const readFileTool: FunctionTool = {
    type: 'function',
    name: 'read_file',
    description: 'Read the contents of a local file. Returns the text content of the file.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Absolute or relative path to the file to read.' },
            offset: { type: 'number', description: 'Line number to start reading from (1-indexed). Defaults to 1.' },
            limit: { type: 'number', description: 'Maximum number of lines to read. Defaults to reading all lines.' },
        },
        required: ['path'],
        additionalProperties: false,
    },
    strict: false,
};

export const writeFileTool: FunctionTool = {
    type: 'function',
    name: 'write_file',
    description: 'Write content to a local file. Creates the file if it does not exist, overwrites if it does.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Absolute or relative path to the file to write.' },
            content: { type: 'string', description: 'The full content to write to the file.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
    },
    strict: true,
};

export const editFileTool: FunctionTool = {
    type: 'function',
    name: 'edit_file',
    description: 'Edit a local file by replacing a specific text occurrence with new text.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Absolute or relative path to the file to edit.' },
            old_text: { type: 'string', description: 'The exact text to find in the file. Must be unique.' },
            new_text: { type: 'string', description: 'The replacement text.' },
        },
        required: ['path', 'old_text', 'new_text'],
        additionalProperties: false,
    },
    strict: true,
};

export const runTerminalCommandTool: FunctionTool = {
    type: 'function',
    name: 'run_terminal_command',
    description: 'Execute a shell command and return its stdout and stderr.',
    parameters: {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'The shell command to execute.' },
        },
        required: ['command'],
        additionalProperties: false,
    },
    strict: true,
};

export const fileSearchTool: FunctionTool = {
    type: 'function',
    name: 'file_search',
    description: 'Search for a pattern in files under a directory using grep. Returns matching lines with file paths and line numbers.',
    parameters: {
        type: 'object',
        properties: {
            pattern: { type: 'string', description: 'The regex pattern to search for.' },
            path: { type: 'string', description: 'Directory to search in. Defaults to the current directory.' },
        },
        required: ['pattern'],
        additionalProperties: false,
    },
    strict: false,
};

export const loadSkillTool: FunctionTool = {
    type: 'function',
    name: 'load_skill',
    description: 'Load the full instructions for an available skill before performing a task that matches it.',
    parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'The exact name of the skill to load.' } },
        required: ['name'],
        additionalProperties: false,
    },
    strict: true,
};

export const runSubagentTool: FunctionTool = {
    type: 'function',
    name: 'run_subagent',
    description: 'Delegate an independent task to a child agent and return its final result.',
    parameters: {
        type: 'object',
        properties: { task: { type: 'string', description: 'A self-contained task for the child agent.' } },
        required: ['task'],
        additionalProperties: false,
    },
    strict: true,
};

/** All local tools registered with the agent, in declaration order. */
export const allTools: readonly FunctionTool[] = [
    weatherTool,
    readFileTool,
    writeFileTool,
    editFileTool,
    runTerminalCommandTool,
    fileSearchTool,
    loadSkillTool,
    runSubagentTool,
];

/**
 * Global MCP client manager. Agent code uses this to connect to MCP servers,
 * discover their tools, and dispatch calls to them.
 */
export const mcpManager = new McpClientManager();

/**
 * Build the complete tool list: local tools + all MCP tools discovered
 * from connected servers. Called by the agent before each run.
 */
export async function getAllToolsWithMcp(): Promise<readonly FunctionTool[]> {
    const mcpEntries = await mcpManager.listAllTools();
    const mcpTools = mcpEntries.map((e) => e.tool);
    return [...allTools, ...mcpTools];
}

function requireString(args: Record<string, unknown>, key: string): string {
    const value = args[key];
    if (typeof value !== 'string') {
        throw new Error(`Missing or invalid argument "${key}": expected string`);
    }
    return value;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
    const value = args[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'number') {
        throw new Error(`Invalid argument "${key}": expected number`);
    }
    return value;
}

async function getWeather(city: string): Promise<string> {
    const weather: Record<string, { temperature_c: number; condition: string }> = {
        'new york': { temperature_c: 22, condition: 'sunny' },
        tokyo: { temperature_c: 18, condition: 'cloudy' },
        london: { temperature_c: 14, condition: 'rainy' },
    };
    const result = weather[city.toLowerCase()] ?? { temperature_c: 20, condition: 'clear' };
    return JSON.stringify({ city, ...result });
}

async function handleReadFile(args: { path: string; offset?: number; limit?: number }): Promise<string> {
    const content = await fsReadFile(args.path, 'utf-8');
    const lines = content.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const start = Math.max(0, (args.offset ?? 1) - 1);
    const end = args.limit !== undefined ? start + args.limit : lines.length;
    return lines.slice(start, Math.min(end, lines.length))
        .map((line, index) => `${start + index + 1}|${line}`)
        .join('\n');
}

async function handleWriteFile(args: { path: string; content: string }): Promise<string> {
    await fsWriteFile(args.path, args.content, 'utf-8');
    return JSON.stringify({ path: args.path, bytes_written: Buffer.byteLength(args.content, 'utf-8') });
}

async function handleEditFile(args: { path: string; old_text: string; new_text: string }): Promise<string> {
    const content = await fsReadFile(args.path, 'utf-8');
    const occurrences = content.split(args.old_text).length - 1;
    if (occurrences === 0) throw new Error(`old_text not found in ${args.path}`);
    if (occurrences > 1) {
        throw new Error(`old_text appears ${occurrences} times in ${args.path}; expected exactly one occurrence`);
    }
    await fsWriteFile(args.path, content.replace(args.old_text, args.new_text), 'utf-8');
    return JSON.stringify({ path: args.path, status: 'edited' });
}

async function handleRunTerminalCommand(args: { command: string }): Promise<string> {
    const { stdout, stderr } = await execAsync(args.command, {
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
    });
    return JSON.stringify({ stdout, stderr });
}

async function handleFileSearch(args: { pattern: string; path?: string }): Promise<string> {
    try {
        const result = await execAsync(
            `grep -rn -- ${JSON.stringify(args.pattern)} ${JSON.stringify(args.path ?? '.')}`,
            { maxBuffer: 1024 * 1024, timeout: 30_000 },
        );
        return JSON.stringify({ matches: result.stdout, stderr: result.stderr });
    } catch (error) {
        const execError = error as { code?: number; stdout?: string; stderr?: string };
        if (execError.code !== 1) throw error;
        return JSON.stringify({ matches: execError.stdout ?? '', stderr: execError.stderr ?? '' });
    }
}

export function registerBuiltInToolHandlers(agent: Agent): void {
    agent.tools
        .register(weatherTool.name, (_call, args) => getWeather(requireString(args, 'city')))
        .register(readFileTool.name, (_call, args) => handleReadFile({
            path: requireString(args, 'path'),
            offset: optionalNumber(args, 'offset'),
            limit: optionalNumber(args, 'limit'),
        }))
        .register(writeFileTool.name, (_call, args) => handleWriteFile({
            path: requireString(args, 'path'),
            content: requireString(args, 'content'),
        }))
        .register(editFileTool.name, (_call, args) => handleEditFile({
            path: requireString(args, 'path'),
            old_text: requireString(args, 'old_text'),
            new_text: requireString(args, 'new_text'),
        }))
        .register(runTerminalCommandTool.name, (_call, args) => handleRunTerminalCommand({
            command: requireString(args, 'command'),
        }))
        .register(fileSearchTool.name, (_call, args) => {
            const path = args.path;
            return handleFileSearch({
                pattern: requireString(args, 'pattern'),
                path: typeof path === 'string' ? path : undefined,
            });
        })
        .register(loadSkillTool.name, (call, args) => {
            const skillName = requireString(args, 'name');
            const skill = agent.skills.get(skillName);
            if (skill === undefined) {
                return { callId: call.call_id, name: call.name, output: `Unknown skill: ${skillName}`, error: 'unknown_skill' };
            }
            return `## Skill: ${skill.name}\n\n${skill.instructions}`;
        })
        .register(runSubagentTool.name, async (_call, args) => {
            const availableTools = await getAllToolsWithMcp();
            const definition: SubAgentDefinition = {
                name: 'general',
                description: 'General purpose child agent for independent tasks.',
                mode: 'subagent',
                systemPrompt: 'Complete the delegated task independently and return a concise, useful result.',
                tools: Object.fromEntries(availableTools.map((tool) => [tool.name, tool.name !== runSubagentTool.name])),
            };
            return runSubAgent(agent, requireString(args, 'task'), definition);
        });
}

export async function executeTool(
    call: FunctionCallItem,
    handlers: ToolRegistry,
): Promise<ToolResult> {
    if (mcpManager.isMcpTool(call.name)) {
        const args = parseToolArguments(call);
        const mcpResult = await mcpManager.callTool(call.name, args);
        return {
            callId: call.call_id,
            name: call.name,
            output: mcpResult.output,
            error: mcpResult.error,
        };
    }
    const result = await handlers.execute(call);
    return result ?? { callId: call.call_id, name: call.name, output: `Unknown tool: ${call.name}`, error: 'unknown_tool' };
}
