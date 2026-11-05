import assert from 'node:assert/strict';
import test from 'node:test';
import { HindsightClient } from '@vectorize-io/hindsight-client';

const client = new HindsightClient({
    baseUrl: process.env.HINDSIGHT_BASE_URL ?? 'http://localhost:8888',
});
const bankId = process.env.HINDSIGHT_BANK_ID ?? 'hindsight-integration-test';

test('Hindsight retain, recall, and reflect workflow', { timeout: 120_000 }, async () => {
    const retained = await client.retain(bankId, 'Alice works at Google as a software engineer');
    assert.equal(retained.success, true);
    console.log('Retain:', JSON.stringify(retained, null, 2));

    const recalled = await client.recall(bankId, 'What does Alice do?');
    assert.ok(recalled.results.length > 0, 'Recall should return at least one memory');
    assert.ok(
        recalled.results.some((memory) => /Alice/i.test(memory.text) && /Google/i.test(memory.text)),
        'Recall should find the memory retained for Alice',
    );
    console.log('Recall:', JSON.stringify(recalled, null, 2));

    const reflection = await client.reflect(bankId, 'Tell me about Alice');
    assert.ok(reflection.text.trim().length > 0, 'Reflect should return a non-empty response');
    console.log('Reflect:', reflection.text);
});
