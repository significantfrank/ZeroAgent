export interface SubAgentDefinition {
    /** Agent identifier, kebab-case. */
    name: string;
    /** Human-readable description. */
    description: string;
    /** Must be "subagent". */
    mode: 'subagent';
    /** Optional model override, e.g. "deepseek/deepseek-chat". */
    model?: string;
    /** Tool-name whitelist (tool name → enabled). */
    tools?: Record<string, boolean>;
    /** System prompt body (Markdown content after front matter). */
    systemPrompt: string;
}

export type LoadedSubAgent = {
    definition: SubAgentDefinition;
    source: string;
};