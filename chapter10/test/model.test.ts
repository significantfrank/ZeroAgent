import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    ModelRegistry,
    loadAuth,
    loadModelRegistry,
    loadModels,
    parseAuthJson,
    parseModelsJson,
} from '../src/model/index.ts';

// ---------------------------------------------------------------------------
// parseAuthJson
// ---------------------------------------------------------------------------

test('parseAuthJson loads provider credentials', () => {
    const auth = parseAuthJson(JSON.stringify({
        deepseek: { baseUrl: 'https://api.deepseek.com/v1', type: 'api_key', key: 'sk-1' },
    }), 'auth.json');

    assert.deepEqual(auth, {
        deepseek: { baseUrl: 'https://api.deepseek.com/v1', type: 'api_key', key: 'sk-1' },
    });
});

test('parseAuthJson rejects invalid JSON and unsupported type', () => {
    assert.throws(() => parseAuthJson('{nope', 'auth.json'), /invalid JSON/);
    assert.throws(
        () => parseAuthJson(JSON.stringify({ deepseek: { baseUrl: 'https://x', type: 'bearer', key: 'k' } }), 'auth.json'),
        /unsupported type/,
    );
    assert.throws(
        () => parseAuthJson(JSON.stringify({ deepseek: { baseUrl: 'https://x', type: 'api_key' } }), 'auth.json'),
        /missing a non-empty key field/,
    );
});

// ---------------------------------------------------------------------------
// parseModelsJson
// ---------------------------------------------------------------------------

test('parseModelsJson loads model definitions', () => {
    const models = parseModelsJson(JSON.stringify({
        'deepseek-flash': {
            provider: 'deepseek',
            name: 'DeepSeek Flash',
            reasoning: true,
            maxTokens: 384000,
            thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', max: 'max' },
        },
    }), 'models-config.json', new Set(['deepseek']));

    assert.equal(models.length, 1);
    assert.deepEqual(models[0], {
        id: 'deepseek-flash',
        provider: 'deepseek',
        name: 'DeepSeek Flash',
        reasoning: true,
        maxTokens: 384000,
        thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', max: 'max' },
    });
});

test('parseModelsJson rejects invalid field types and missing provider', () => {
    assert.throws(
        () => parseModelsJson(JSON.stringify({ m: { provider: 'p', reasoning: 'yes' } }), 'c.json', new Set(['p'])),
        /invalid reasoning: expected a boolean/,
    );
    assert.throws(
        () => parseModelsJson(JSON.stringify({ m: { reasoning: true } }), 'c.json', new Set(['p'])),
        /missing a non-empty provider field/,
    );
    assert.throws(
        () => parseModelsJson(JSON.stringify({ m: { provider: 'p', maxTokens: 0 } }), 'c.json', new Set(['p'])),
        /invalid maxTokens: expected a positive number/,
    );
});

test('parseModelsJson rejects unknown provider references', () => {
    assert.throws(
        () => parseModelsJson(JSON.stringify({ m: { provider: 'glm' } }), 'c.json', new Set(['deepseek'])),
        /unknown provider "glm"/,
    );
});

test('parseModelsJson rejects bad thinkingLevelMap keys and values', () => {
    assert.throws(
        () => parseModelsJson(JSON.stringify({ m: { provider: 'p', thinkingLevelMap: { xhigh: 'high' } } }), 'c.json', new Set(['p'])),
        /invalid thinkingLevelMap key "xhigh"/,
    );
    assert.throws(
        () => parseModelsJson(JSON.stringify({ m: { provider: 'p', thinkingLevelMap: { high: 5 } } }), 'c.json', new Set(['p'])),
        /invalid thinkingLevelMap\.high/,
    );
});

// ---------------------------------------------------------------------------
// File loading (missing files produce empty results)
// ---------------------------------------------------------------------------

test('loadAuth and loadModels return empty results for missing files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'za-model-missing-'));
    try {
        assert.deepEqual(await loadAuth(join(root, 'auth.json')), {});
        assert.deepEqual(await loadModels(join(root, 'models-config.json'), new Set()), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('loadModelRegistry resolves model to provider credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'za-model-registry-'));
    try {
        const authFile = join(root, 'auth.json');
        const modelsFile = join(root, 'models-config.json');
        await writeFile(authFile, JSON.stringify({
            deepseek: { baseUrl: 'https://api.deepseek.com/v1', type: 'api_key', key: 'sk-deepseek' },
        }));
        await writeFile(modelsFile, JSON.stringify({
            'deepseek-flash': {
                provider: 'deepseek',
                reasoning: true,
                thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', max: 'max' },
            },
        }));

        const registry = await loadModelRegistry(authFile, modelsFile);

        assert.deepEqual(registry.resolveAuth('deepseek-flash'), {
            baseUrl: 'https://api.deepseek.com/v1',
            key: 'sk-deepseek',
        });
        assert.equal(registry.resolveAuth('unknown-model'), undefined);
        assert.deepEqual(registry.names(), ['deepseek-flash']);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('loadModelRegistry rejects a model whose provider has no auth entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'za-model-bad-provider-'));
    try {
        const authFile = join(root, 'auth.json');
        const modelsFile = join(root, 'models-config.json');
        await writeFile(authFile, JSON.stringify({}));
        await writeFile(modelsFile, JSON.stringify({ m: { provider: 'glm' } }));

        await assert.rejects(
            () => loadModelRegistry(authFile, modelsFile),
            /unknown provider "glm"/,
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// ModelRegistry.availableEfforts
// ---------------------------------------------------------------------------

test('availableEfforts returns non-null levels in canonical order or undefined without a map', () => {
    const registry = new ModelRegistry();
    registry.registerProvider('deepseek', { baseUrl: 'https://x', type: 'api_key', key: 'k' });
    registry.registerModel({
        id: 'deepseek-flash',
        provider: 'deepseek',
        thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', max: null },
    });
    registry.registerModel({ id: 'plain', provider: 'deepseek' });

    assert.deepEqual(registry.availableEfforts('deepseek-flash'), ['low', 'high']);
    assert.equal(registry.availableEfforts('plain'), undefined);
    assert.equal(registry.availableEfforts('nope'), undefined);
});
