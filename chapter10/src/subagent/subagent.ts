import type { AgentRegistry } from './registry.ts';
import type { SubAgentDefinition } from './types.ts';
import type { Agent } from '../agent-loop.ts';
import { AgentEventType, type AgentEvent } from '../types.ts';
import { render } from '../agent-event.ts';

export function isSubAgentInput(input: string): boolean {
    return input.startsWith('@');
}

export function parseSubAgent(
    input: string,
    registry: AgentRegistry,
): { task: string; definition: SubAgentDefinition } {
    const match = /^@(\S+)(?:\s+([\s\S]*))?$/.exec(input);
    if (match === null) throw new Error('Expected @<agent-name> <task>.');

    const name = match[1]!;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
        throw new Error(`Invalid agent name "${name}".`);
    }

    const definition = registry.get(name);
    if (definition === undefined) throw new Error(`Unknown agent: ${name}`);

    const task = match[2]?.trim();
    if (task === undefined || task.length === 0) throw new Error(`Usage: @${name} <task>`);

    return { task, definition };
}

export function buildSubagentParentPrompt(name: string, task: string, result: string): string {
    return [
        `The user invoked @${name} with this task:`,
        task,
        '',
        'Use the SubAgent result below to answer the user。',
        '<subagent_result>',
        result,
        '</subagent_result>',
    ].join('\n');
}

export async function runSubAgent(
    parent: Agent,
    task: string,
    definition: SubAgentDefinition,
): Promise<string> {
    let result: string | undefined;
    let errorRendered = false;
    render({ type: AgentEventType.SubagentStart, name: definition.name });
    try {
        const child = parent.createSubAgent(definition);
        for await (const event of child.stream(task)) {
            render(event);
            if (event.type === AgentEventType.Error) {
                errorRendered = true;
                throw new Error(`Subagent failed: ${event.message}`);
            }
            if (event.type === AgentEventType.RunEnd) result = event.text;
        }
        if (result === undefined) {
            errorRendered = true;
            render({ type: AgentEventType.Error, message: 'Subagent ended without a final response' });
            throw new Error('Subagent ended without a final response');
        }
        return result;
    } catch (error) {
        if (!errorRendered) {
            render({
                type: AgentEventType.Error,
                message: error instanceof Error ? error.message : String(error),
            });
        }
        throw error;
    } finally {
        render({ type: AgentEventType.SubagentEnd, name: definition.name });
    }
}