import { existsSync } from 'node:fs';
import { LlmAgent, OpenAICompatibleLlm, ParallelAgent } from './index.ts';

if (existsSync('.env')) {
    process.loadEnvFile('.env');
}

const modelName = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
const prompt = process.argv.slice(2).join(' ') || 'Explain the benefits of automated testing.';
const createModel = () => new OpenAICompatibleLlm({ model: modelName });

const agents = [
    new LlmAgent({
        name: 'testing-benefits',
        model: createModel(),
        instruction: 'Analyze the practical benefits of automated testing. Be concise and no more than 3 points.',
    }),
    new LlmAgent({
        name: 'testing-tradeoffs',
        model: createModel(),
        instruction: 'Analyze the limitations and tradeoffs of automated testing. Be concise and no more than 4 points.',
    }),
];
const workflow = new ParallelAgent({
    name: 'parallel-testing-analysis',
    agents,
});

console.log(`Running ${agents.length} agents concurrently with ${modelName}...`);
const result = await workflow.run(prompt, {
    signal: AbortSignal.timeout(90_000),
});

for (const child of result.children ?? []) {
    console.log(`\n## ${child.name}\n${child.output}`);
}
