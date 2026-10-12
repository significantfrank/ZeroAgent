import { readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { FunctionCallItem, FunctionTool } from './types.ts';

const execAsync = promisify(exec);

export type ToolResult = {
    callId: string;
    name: string;
    output: string;
    error?: string;
};

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

/** All tools registered with the agent, in declaration order. */
export const allTools: readonly FunctionTool[] = [
    weatherTool,
    readFileTool,
    writeFileTool,
    editFileTool,
    runTerminalCommandTool,
    fileSearchTool,
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function getWeather(city: string): Promise<string> {
    const weather: Record<string, { temperature_c: number; condition: string }> = {
        'new york': { temperature_c: 22, condition: 'sunny' },
        tokyo: { temperature_c: 18, condition: 'cloudy' },
        london: { temperature_c: 14, condition: 'rainy' },
    };
    const result = weather[city.toLowerCase()] ?? { temperature_c: 20, condition: 'clear' };
    return JSON.stringify({ city, ...result });
}

async function handleReadFile(args: {
    path: string;
    offset?: number;
    limit?: number;
}): Promise<string> {
    const content = await fsReadFile(args.path, 'utf-8');
    // Drop the trailing empty element produced by a final newline so it
    // does not show up as a phantom extra line.
    const lines = content.split('\n');
    if (lines.length > 0 && lines.at(-1) === '') lines.pop();
    const offset = args.offset ?? 1;
    const start = Math.max(0, offset - 1);
    const end = args.limit !== undefined ? start + args.limit : lines.length;
    const selected = lines.slice(start, Math.min(end, lines.length));
    // Prefix each line with its 1-indexed line number for context.
    return selected
        .map((line, i) => `${start + i + 1}|${line}`)
        .join('\n');
}

async function handleWriteFile(args: { path: string; content: string }): Promise<string> {
    await fsWriteFile(args.path, args.content, 'utf-8');
    return JSON.stringify({ path: args.path, bytes_written: Buffer.byteLength(args.content, 'utf-8') });
}

async function handleEditFile(args: {
    path: string;
    old_text: string;
    new_text: string;
}): Promise<string> {
    const content = await fsReadFile(args.path, 'utf-8');
    const occurrences = content.split(args.old_text).length - 1;
    if (occurrences === 0) {
        throw new Error(`old_text not found in ${args.path}`);
    }
    if (occurrences > 1) {
        throw new Error(`old_text appears ${occurrences} times in ${args.path}; expected exactly one occurrence`);
    }
    const updated = content.replace(args.old_text, args.new_text);
    await fsWriteFile(args.path, updated, 'utf-8');
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
    const searchPath = args.path ?? '.';
    // grep -rn: recursive, line numbers; exit code 1 means no matches (not an error).
    let stdout: string;
    let stderr: string;
    try {
        const result = await execAsync(`grep -rn -- ${JSON.stringify(args.pattern)} ${JSON.stringify(searchPath)}`, {
            maxBuffer: 1024 * 1024,
            timeout: 30_000,
        });
        stdout = result.stdout;
        stderr = result.stderr;
    } catch (error) {
        // grep exits with code 1 when no matches are found — that is not an error.
        const execError = error as { code?: number; stdout?: string; stderr?: string };
        if (execError.code === 1) {
            stdout = execError.stdout ?? '';
            stderr = execError.stderr ?? '';
        } else {
            throw error;
        }
    }
    return JSON.stringify({ matches: stdout, stderr });
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

function parseArgs(call: FunctionCallItem): Record<string, unknown> {
    const args: unknown = JSON.parse(call.arguments);
    if (typeof args !== 'object' || args === null) {
        throw new Error('Tool arguments must be a JSON object');
    }
    return args as Record<string, unknown>;
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

export async function executeTool(call: FunctionCallItem): Promise<ToolResult> {
    try {
        switch (call.name) {
            case weatherTool.name: {
                const args = parseArgs(call);
                const city = requireString(args, 'city');
                const output = await getWeather(city);
                return { callId: call.call_id, name: call.name, output };
            }
            case readFileTool.name: {
                const args = parseArgs(call);
                const output = await handleReadFile({
                    path: requireString(args, 'path'),
                    offset: optionalNumber(args, 'offset'),
                    limit: optionalNumber(args, 'limit'),
                });
                return { callId: call.call_id, name: call.name, output };
            }
            case writeFileTool.name: {
                const args = parseArgs(call);
                const output = await handleWriteFile({
                    path: requireString(args, 'path'),
                    content: requireString(args, 'content'),
                });
                return { callId: call.call_id, name: call.name, output };
            }
            case editFileTool.name: {
                const args = parseArgs(call);
                const output = await handleEditFile({
                    path: requireString(args, 'path'),
                    old_text: requireString(args, 'old_text'),
                    new_text: requireString(args, 'new_text'),
                });
                return { callId: call.call_id, name: call.name, output };
            }
            case runTerminalCommandTool.name: {
                const args = parseArgs(call);
                const output = await handleRunTerminalCommand({
                    command: requireString(args, 'command'),
                });
                return { callId: call.call_id, name: call.name, output };
            }
            case fileSearchTool.name: {
                const args = parseArgs(call);
                const pathValue = args.path;
                const output = await handleFileSearch({
                    pattern: requireString(args, 'pattern'),
                    path: typeof pathValue === 'string' ? pathValue : undefined,
                });
                return { callId: call.call_id, name: call.name, output };
            }
            default:
                return { callId: call.call_id, name: call.name, output: `Unknown tool: ${call.name}`, error: 'unknown_tool' };
        }
    } catch (error) {
        return {
            callId: call.call_id,
            name: call.name,
            output: error instanceof Error ? error.message : String(error),
            error: 'tool_error',
        };
    }
}
