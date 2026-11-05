import type { ExtensionAPI } from '../../src/extension/index.ts';

export default function (zeroagent: ExtensionAPI): void {
    zeroagent.on('before_agent_start', (event) => {
        console.log('before_agent_start extension');
        event.systemPromptOptions.sections['test'] = 'test section';
        event.systemPromptOptions.sections['project_context'] = 'Project context from test extension.';
        event.systemPromptOptions.appendSystemPrompt += '\n\n test cover for new func';
    });

    zeroagent.registerCommand('hello', {
        description: 'Show a greeting',
        async handler(args) {
            console.log(`Hello, ${args || 'world'}!`);
        },
    });

    zeroagent.registerTool(
        {
            type: 'function',
            name: 'get_answer',
            description: 'Return the answer.',
            parameters: { type: 'object', properties: {} },
            strict: true,
        },
        async () => '42',
    );
}
