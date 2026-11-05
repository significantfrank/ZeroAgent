/**
 * Mutable system-prompt assembly options, exposed to `before_agent_start`
 * handlers. Handlers mutate this object in place to shape the system prompt
 * for a run; the agent renders it into the request `instructions` afterwards.
 */
export type SystemPromptOptions = {
    /** Named, ordered sections rendered in insertion order. */
    sections: Record<string, string>;
    /** Text appended after all sections, at the very end of the prompt. */
    appendSystemPrompt: string;
};

/** Reserved section key holding the base instructions (subagent prompt + skills). */
export const BASE_SECTION = 'base';

/** Build initial options from the base instructions (placed first to preserve cache). */
export function createSystemPromptOptions(base: string): SystemPromptOptions {
    return {
        sections: base.length > 0 ? { [BASE_SECTION]: base } : {},
        appendSystemPrompt: '',
    };
}

/** Render the options into the final instructions string. */
export function composeSystemPrompt(options: SystemPromptOptions): string {
    const parts: string[] = [];
    for (const value of Object.values(options.sections)) {
        if (value.length > 0) parts.push(value);
    }
    if (options.appendSystemPrompt.length > 0) parts.push(options.appendSystemPrompt);
    return parts.join('\n\n');
}
