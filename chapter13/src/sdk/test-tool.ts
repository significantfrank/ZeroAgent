import { existsSync } from 'node:fs';
import { LlmAgent } from './agent.ts';
import { OpenAICompatibleLlm } from './model.ts';
import { FunctionTool } from './function-tool.ts';

if (existsSync('.env')) {
    process.loadEnvFile('.env');
}

const modelName = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
const prompt = process.argv.slice(2).join(' ') || '杭州现在是什么时间.';

const tool = new FunctionTool({
    name: 'get_current_time',
    description: 'Get the current time in a city.',
    parameters: { city: 'The name of the city.' },
    execute: ({ city }) => ({ city, time: '10:30 AM' }),
});

const agent = new LlmAgent({
    name: 'sdk-tool-test',
    model: new OpenAICompatibleLlm({ model: modelName }),
    tools: [tool],
});

console.log(`Sending a live request to ${modelName}...`);
const result = await agent.run(prompt, {
    signal: AbortSignal.timeout(60_000),
});
console.log(result.output);
