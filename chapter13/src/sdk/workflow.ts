import type { AgentRunOptions, AgentResult, RunnableAgent } from './agent.ts';

function assertAgents(name: string, agents: readonly RunnableAgent[]): void {
    if (agents.length === 0) {
        throw new Error(`${name} requires at least one agent.`);
    }
    const names = new Set<string>();
    for (const agent of agents) {
        if (names.has(agent.name)) {
            throw new Error(`${name} contains duplicate agent name "${agent.name}".`);
        }
        names.add(agent.name);
    }
}

export type WorkflowAgentOptions = {
    name: string;
    agents: readonly RunnableAgent[];
};

export class SequentialAgent implements RunnableAgent {
    readonly name: string;
    readonly agents: readonly RunnableAgent[];

    constructor(options: WorkflowAgentOptions) {
        assertAgents(options.name, options.agents);
        this.name = options.name;
        this.agents = [...options.agents];
    }

    async run(input: string, options: AgentRunOptions = {}): Promise<AgentResult> {
        const children: AgentResult[] = [];
        for (const agent of this.agents) {
            options.signal?.throwIfAborted();
            const stepInput = children.length === 0
                ? input
                : [
                    `Original task:\n${input}`,
                    ...children.map((result) => `Previous step (${result.name}) result:\n${result.output}`),
                ].join('\n\n');
            children.push(await agent.run(stepInput, options));
        }
        return {
            name: this.name,
            output: children[children.length - 1]!.output,
            children,
        };
    }
}

export class ParallelAgent implements RunnableAgent {
    readonly name: string;
    readonly agents: readonly RunnableAgent[];

    constructor(options: WorkflowAgentOptions) {
        assertAgents(options.name, options.agents);
        this.name = options.name;
        this.agents = [...options.agents];
    }

    async run(input: string, options: AgentRunOptions = {}): Promise<AgentResult> {
        options.signal?.throwIfAborted();
        const controller = new AbortController();
        const signal = options.signal === undefined
            ? controller.signal
            : AbortSignal.any([options.signal, controller.signal]);

        try {
            const children = await Promise.all(this.agents.map(async (agent) => {
                try {
                    return await agent.run(input, { ...options, signal });
                } catch (error) {
                    controller.abort(error);
                    throw error;
                }
            }));
            return {
                name: this.name,
                output: children.map((child) => `## ${child.name}\n${child.output}`).join('\n\n'),
                children,
            };
        } finally {
            controller.abort();
        }
    }
}
